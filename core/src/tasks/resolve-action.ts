/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { BaseActionTask, ActionTaskProcessParams, ActionTaskStatusParams, BaseTask, ValidResultType } from "./base"
import { Profile } from "../util/profiling"
import { Action, ActionState, ExecutedAction, Resolved, ResolvedAction } from "../actions/types"
import { ActionSpecContext } from "../config/template-contexts/actions"
import { resolveTemplateStrings } from "../template-string/template-string"
import { InternalError } from "../exceptions"
import { validateWithPath } from "../config/validation"
import { DeepPrimitiveMap } from "../config/common"
import { merge } from "lodash"
import { mergeVariables } from "../graph/common"
import { actionToResolved } from "../actions/helpers"
import { ResolvedConfigGraph } from "../graph/config-graph"
import { OtelTraced } from "../util/open-telemetry/decorators"

export interface ResolveActionResults<T extends Action> extends ValidResultType {
  state: ActionState
  outputs: {
    resolvedAction: Resolved<T>
  }
  detail: null
}

@Profile()
export class ResolveActionTask<T extends Action> extends BaseActionTask<T, ResolveActionResults<T>> {
  type = "resolve-action"

  getDescription() {
    return `resolve ${this.action.longDescription()}`
  }

  override getName() {
    return this.action.key()
  }

  getStatus({}: ActionTaskStatusParams<T>) {
    return null
  }

  override resolveStatusDependencies() {
    return []
  }

  override resolveProcessDependencies(): BaseTask[] {
    // TODO-0.13.1
    // If we get a resolved task upfront, e.g. from module conversion, we could avoid resolving any dependencies.
    // if (this.action.getConfig().internal?.resolved) {
    //   return []
    // }

    return this.action.getDependencyReferences().flatMap((d): BaseTask[] => {
      const action = this.graph.getActionByRef(d, { includeDisabled: true })

      if (d.needsExecutedOutputs) {
        // Need runtime outputs from dependency
        return [this.getExecuteTask(action)]
      } else if (d.needsStaticOutputs || d.explicit) {
        // Needs a static output from dependency
        return [this.getResolveTask(action)]
      } else {
        return []
      }
    })
  }

  @OtelTraced({
    name(_params) {
      return this.action.key() + ".resolveAction"
    },
    getAttributes(_params) {
      return {
        key: this.action.key(),
        kind: this.action.kind,
      }
    },
  })
  async process({
    dependencyResults,
  }: ActionTaskProcessParams<T, ResolveActionResults<T>>): Promise<ResolveActionResults<T>> {
    const action = this.action
    const config = action.getConfig()

    // Collect dependencies
    const resolvedDependencies: ResolvedAction[] = []
    const executedDependencies: ExecutedAction[] = []

    // TODO: get this to a type-safer place
    for (const task of dependencyResults.getTasks()) {
      if (task instanceof ResolveActionTask) {
        const r = dependencyResults.getResult(task)
        if (!r) {
          continue
        }
        resolvedDependencies.push(r.outputs.resolvedAction)
      } else if (task.isExecuteTask()) {
        const r = dependencyResults.getResult(task)
        if (!r?.result) {
          continue
        }
        executedDependencies.push(r.result.executedAction)
      }
    }

    // Resolve template inputs
    const inputsContext = new ActionSpecContext({
      garden: this.garden,
      resolvedProviders: await this.garden.resolveProviders(this.log),
      action,
      modules: this.graph.getModules(),
      partialRuntimeResolution: false,
      resolvedDependencies,
      executedDependencies,
      variables: {},
      inputs: {},
    })
    const inputs = resolveTemplateStrings(config.internal.inputs || {}, inputsContext, { allowPartial: false })

    // Resolve variables
    let groupVariables: DeepPrimitiveMap = {}
    const groupName = action.groupName()

    if (groupName) {
      const group = this.graph.getGroup(groupName)

      groupVariables = resolveTemplateStrings(
        await mergeVariables({ basePath: group.path, variables: group.variables, varfiles: group.varfiles }),
        inputsContext
      )
    }

    const actionVariables = resolveTemplateStrings(
      await mergeVariables({
        basePath: action.basePath(),
        variables: config.variables,
        varfiles: config.varfiles,
      }),
      new ActionSpecContext({
        garden: this.garden,
        resolvedProviders: await this.garden.resolveProviders(this.log),
        action,
        modules: this.graph.getModules(),
        partialRuntimeResolution: false,
        resolvedDependencies,
        executedDependencies,
        variables: groupVariables,
        inputs,
      })
    )

    const variables = groupVariables
    merge(variables, actionVariables)
    // Override with CLI-set variables
    merge(variables, this.garden.variableOverrides)

    // Resolve spec
    let spec = resolveTemplateStrings(
      action.getConfig().spec || {},
      new ActionSpecContext({
        garden: this.garden,
        resolvedProviders: await this.garden.resolveProviders(this.log),
        action,
        modules: this.graph.getModules(),
        partialRuntimeResolution: false,
        resolvedDependencies,
        executedDependencies,
        variables,
        inputs,
      })
    )

    // Validate spec
    spec = await this.validateSpec(spec)

    // Resolve action without outputs
    const resolvedGraph = new ResolvedConfigGraph({
      actions: [...resolvedDependencies, ...executedDependencies],
      moduleGraph: this.graph.moduleGraph,
      groups: this.graph.getGroups(),
    })

    const resolvedAction = actionToResolved(action, {
      resolvedGraph,
      dependencyResults,
      executedDependencies,
      resolvedDependencies,
      variables,
      inputs,
      spec,
      staticOutputs: {},
    }) as Resolved<T>

    // Get outputs and assign to the resolved action
    const router = await this.garden.getActionRouter()
    const { outputs: staticOutputs } = await router.getActionOutputs({
      action: resolvedAction,
      graph: this.graph,
      log: this.log,
    })

    // Validate the outputs
    const actionRouter = router.getRouterForActionKind(resolvedAction.kind)
    await actionRouter.validateActionOutputs(resolvedAction, "static", staticOutputs)

    await actionRouter.callHandler({
      handlerType: "validate",
      params: { action: resolvedAction, graph: resolvedGraph, log: this.log, events: undefined },
      defaultHandler: async (_) => ({}),
    })

    // TODO: avoid this private assignment
    resolvedAction["_staticOutputs"] = staticOutputs

    return {
      state: "ready",
      outputs: {
        resolvedAction,
      },
      detail: null,
    }
  }

  @OtelTraced({
    name: "validateAction",
    getAttributes(_spec) {
      return {
        key: this.action.key(),
        kind: this.action.kind,
      }
    },
  })
  private async validateSpec<S>(spec: S) {
    const actionTypes = await this.garden.getActionTypes()
    const { kind, type } = this.action
    const actionType = actionTypes[kind][type]?.spec
    const description = this.action.longDescription()

    if (!actionType) {
      // This should be caught way earlier in normal usage, so it's an internal error
      throw new InternalError({ message: `Could not find type definition for ${description}.`, detail: { kind, type } })
    }

    const path = this.action.basePath()
    const internal = this.action.getInternal()

    spec = validateWithPath({
      config: spec,
      schema: actionType.schema,
      path,
      projectRoot: this.garden.projectRoot,
      configType: `spec for ${description}`,
      yamlDoc: internal.yamlDoc,
      yamlDocBasePath: ["spec"],
    })

    const actionTypeBases = await this.garden.getActionTypeBases(kind, type)
    for (const base of actionTypeBases) {
      this.log.silly(`Validating ${description} spec against '${base.name}' schema`)

      spec = validateWithPath({
        config: spec,
        schema: base.schema,
        path,
        projectRoot: this.garden.projectRoot,
        configType: `spec for ${description} (base schema from '${base.name}' plugin)`,
        yamlDoc: internal.yamlDoc,
        yamlDocBasePath: ["spec"],
      })
    }

    return spec
  }
}
