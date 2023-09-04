/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import cloneDeep from "fast-copy"
import { isEqual, mapValues, memoize, omit, pick, uniq } from "lodash"
import {
  Action,
  ActionConfig,
  ActionConfigsByKey,
  ActionDependency,
  ActionDependencyAttributes,
  ActionKind,
  actionKinds,
  ActionMode,
  ActionModeMap,
  ActionWrapperParams,
  Executed,
  Resolved,
} from "../actions/types"
import {
  actionReferenceToString,
  addActionDependency,
  baseRuntimeActionConfigSchema,
  describeActionConfig,
  describeActionConfigWithPath,
} from "../actions/base"
import { BuildAction, buildActionConfigSchema, isBuildActionConfig } from "../actions/build"
import { DeployAction, deployActionConfigSchema, isDeployActionConfig } from "../actions/deploy"
import { RunAction, runActionConfigSchema, isRunActionConfig } from "../actions/run"
import { TestAction, testActionConfigSchema, isTestActionConfig } from "../actions/test"
import { noTemplateFields } from "../config/base"
import { ActionReference, describeSchema, JoiDescription, parseActionReference } from "../config/common"
import type { GroupConfig } from "../config/group"
import { ActionConfigContext } from "../config/template-contexts/actions"
import { validateWithPath } from "../config/validation"
import { ConfigurationError, InternalError, PluginError, ValidationError } from "../exceptions"
import { overrideVariables, type Garden } from "../garden"
import type { Log } from "../logger/log-entry"
import type { ActionTypeDefinition } from "../plugin/action-types"
import { ActionDefinitionMap, getActionTypeBases } from "../plugins"
import type { ActionRouter } from "../router/router"
import { getExecuteTaskForAction } from "../tasks/helpers"
import { ResolveActionTask } from "../tasks/resolve-action"
import {
  getActionTemplateReferences,
  maybeTemplateString,
  resolveTemplateString,
  resolveTemplateStrings,
} from "../template-string/template-string"
import { dedent, deline, naturalList } from "../util/string"
import { mergeVariables } from "./common"
import { ConfigGraph, MutableConfigGraph } from "./config-graph"
import type { ModuleGraph } from "./modules"
import chalk from "chalk"
import type { MaybeUndefined } from "../util/util"
import minimatch from "minimatch"
import { ConfigContext } from "../config/template-contexts/base"
import { LinkedSource, LinkedSourceMap } from "../config-store/local"
import { relative } from "path"
import { profileAsync } from "../util/profiling"
import { uuidv4 } from "../util/random"
import { getConfigBasePath } from "../vcs/vcs"
import { actionIsDisabled } from "../actions/base"

export const actionConfigsToGraph = profileAsync(async function actionConfigsToGraph({
  garden,
  log,
  groupConfigs,
  configs,
  moduleGraph,
  actionModes,
  linkedSources,
  environmentName,
}: {
  garden: Garden
  log: Log
  groupConfigs: GroupConfig[]
  configs: ActionConfig[]
  moduleGraph: ModuleGraph
  actionModes: ActionModeMap
  linkedSources: LinkedSourceMap
  environmentName: string
}): Promise<MutableConfigGraph> {
  const configsByKey: ActionConfigsByKey = {}

  function addConfig(config: ActionConfig) {
    if (!actionKinds.includes(config.kind)) {
      throw new ConfigurationError({ message: `Unknown action kind: ${config.kind}`, detail: { config } })
    }

    const key = actionReferenceToString(config)
    const existing = configsByKey[key]

    if (existing) {
      if (actionIsDisabled(config, environmentName)) {
        log.silly(`Skipping disabled action ${key} in favor of other action with same key`)
        return
      } else if (actionIsDisabled(existing, environmentName)) {
        log.silly(`Skipping disabled action ${key} in favor of other action with same key`)
        configsByKey[key] = config
        return
      } else {
        throw actionNameConflictError(existing, config, garden.projectRoot)
      }
    }
    configsByKey[key] = config
  }

  configs.forEach(addConfig)

  for (const group of groupConfigs) {
    for (const config of group.actions) {
      config.internal.groupName = group.name

      if (group.internal?.configFilePath) {
        config.internal.configFilePath = group.internal.configFilePath
      }

      addConfig(config)
    }
  }

  // Optimize file scanning by avoiding unnecessarily broad scans when project is not in repo root.
  const allPaths = Object.values(configsByKey).map((c) => getConfigBasePath(c))
  const minimalRoots = await garden.vcs.getMinimalRoots(log, allPaths)

  const router = await garden.getActionRouter()

  // TODO: Maybe we could optimize resolving tree versions, avoid parallel scanning of the same directory etc.
  const graph = new MutableConfigGraph({ actions: [], moduleGraph, groups: groupConfigs })

  await Promise.all(
    Object.entries(configsByKey).map(async ([key, config]) => {
      // Apply action modes
      let mode: ActionMode = "default"
      let explicitMode = false // set if a key is explicitly set (as opposed to a wildcard match)

      for (const pattern of actionModes.sync || []) {
        if (key === pattern) {
          explicitMode = true
          mode = "sync"
          log.silly(`Action ${key} set to ${mode} mode, matched on exact key`)
          break
        } else if (minimatch(key, pattern)) {
          mode = "sync"
          log.silly(`Action ${key} set to ${mode} mode, matched with pattern '${pattern}'`)
          break
        }
      }

      // Local mode takes precedence over sync
      // TODO: deduplicate
      for (const pattern of actionModes.local || []) {
        if (key === pattern) {
          explicitMode = true
          mode = "local"
          log.silly(`Action ${key} set to ${mode} mode, matched on exact key`)
          break
        } else if (minimatch(key, pattern)) {
          mode = "local"
          log.silly(`Action ${key} set to ${mode} mode, matched with pattern '${pattern}'`)
          break
        }
      }

      try {
        const action = await actionFromConfig({
          garden,
          graph,
          config,
          router,
          log,
          configsByKey,
          mode,
          linkedSources,
          scanRoot: minimalRoots[getConfigBasePath(config)],
        })

        if (!action.supportsMode(mode)) {
          if (explicitMode) {
            log.warn(chalk.yellow(`${action.longDescription()} is not configured for or does not support ${mode} mode`))
          }
        }

        graph.addAction(action)
      } catch (error) {
        throw new ConfigurationError({
          message:
            chalk.redBright(
              `\nError processing config for ${chalk.white.bold(config.kind)} action ${chalk.white.bold(
                config.name
              )}:\n`
            ) + chalk.red(error.message),
          detail: { config },
          wrappedErrors: [error],
        })
      }
    })
  )

  graph.validate()

  return graph
})

export const actionFromConfig = profileAsync(async function actionFromConfig({
  garden,
  graph,
  config: inputConfig,
  router,
  log,
  configsByKey,
  mode,
  linkedSources,
  scanRoot,
}: {
  garden: Garden
  graph: ConfigGraph
  config: ActionConfig
  router: ActionRouter
  log: Log
  configsByKey: ActionConfigsByKey
  mode: ActionMode
  linkedSources: LinkedSourceMap
  scanRoot?: string
}) {
  // Call configure handler and validate
  const { config, supportedModes, templateContext } = await preprocessActionConfig({
    garden,
    config: inputConfig,
    router,
    mode,
    log,
  })

  const actionTypes = await garden.getActionTypes()
  const definition = actionTypes[config.kind][config.type]?.spec
  const compatibleTypes = [config.type, ...getActionTypeBases(definition, actionTypes[config.kind]).map((t) => t.name)]
  const repositoryUrl = config.source?.repository?.url
  const key = actionReferenceToString(config)

  let linked: LinkedSource | null = null
  let remoteSourcePath: string | null = null
  if (repositoryUrl) {
    if (config.internal.remoteClonePath) {
      // Carry over clone path from converted module
      remoteSourcePath = config.internal.remoteClonePath
    } else {
      remoteSourcePath = await garden.resolveExtSourcePath({
        name: key,
        sourceType: "action",
        repositoryUrl,
        linkedSources: Object.values(linkedSources),
      })

      config.internal.basePath = remoteSourcePath
    }

    if (linkedSources[key]) {
      linked = linkedSources[key]
    }
  }

  const configPath = relative(garden.projectRoot, config.internal.configFilePath || config.internal.basePath)

  if (!actionTypes[config.kind][config.type]) {
    const availableKinds: ActionKind[] = []
    actionKinds.forEach((actionKind) => {
      if (actionTypes[actionKind][config.type]) {
        availableKinds.push(actionKind)
      }
    })

    if (availableKinds.length > 0) {
      throw new ConfigurationError({
        message: deline`
        Unrecognized ${config.type} action of kind ${config.kind} (defined at ${configPath}).
        There are no ${config.type} ${config.kind} actions, did you mean to specify a ${naturalList(availableKinds, {
          trailingWord: "or a",
        })} action(s)?
        `,
        detail: { config, configuredActionTypes: Object.keys(actionTypes) },
      })
    }

    throw new ConfigurationError({
      message: deline`
      Unrecognized action type '${config.type}' (defined at ${configPath}).
      Are you missing a provider configuration?
      `,
      detail: { config, configuredActionTypes: Object.keys(actionTypes) },
    })
  }

  const dependencies = dependenciesFromActionConfig(log, config, configsByKey, definition, templateContext, actionTypes)

  if (config.exclude?.includes("**/*")) {
    if (config.include && config.include.length !== 0) {
      throw new ConfigurationError({
        message: deline`Action ${config.kind}.${config.name} (defined at ${configPath})
        tries to include files but excludes all files via "**/*".
        Read about including and excluding files and directories here:
        https://docs.garden.io/using-garden/configuration-overview#including-excluding-files-and-directories`,
      })
    }
    config.include = []
  }

  const treeVersion =
    config.internal.treeVersion ||
    (await garden.vcs.getTreeVersion({ log, projectName: garden.projectName, config, scanRoot }))

  let variables = await mergeVariables({
    basePath: config.internal.basePath,
    variables: config.variables,
    varfiles: config.varfiles,
  })

  // override the variables if there's any matching variables in variable overrides
  // passed via --var cli flag. variables passed via --var cli flag have highest precedence
  const variableOverrides = garden.variableOverrides || {}
  variables = overrideVariables(variables ?? {}, variableOverrides)

  const params: ActionWrapperParams<any> = {
    baseBuildDirectory: garden.buildStaging.buildDirPath,
    compatibleTypes,
    config,
    uid: uuidv4(),
    dependencies,
    graph,
    projectRoot: garden.projectRoot,
    treeVersion,
    variables,
    linkedSource: linked,
    remoteSourcePath,
    moduleName: config.internal.moduleName,
    moduleVersion: config.internal.moduleVersion,
    mode,
    supportedModes,
  }

  if (isBuildActionConfig(config)) {
    return new BuildAction(params)
  } else if (isDeployActionConfig(config)) {
    return new DeployAction(params)
  } else if (isRunActionConfig(config)) {
    return new RunAction(params)
  } else if (isTestActionConfig(config)) {
    return new TestAction(params)
  } else {
    return config satisfies never
  }
})

export function actionNameConflictError(configA: ActionConfig, configB: ActionConfig, rootPath: string) {
  return new ConfigurationError({
    message: dedent`
    Found two actions of the same name and kind (and neither is disabled):
      - ${describeActionConfigWithPath(configA, rootPath)}
      - ${describeActionConfigWithPath(configB, rootPath)}
    Please rename or disable one of the two to avoid the conflict.
    `,
    detail: { configA, configB },
  })
}

/**
 * Helper for resolving a single action.
 *
 * This runs the GraphSolver as needed to resolve dependencies and fully resolve the action's spec.
 */
export async function resolveAction<T extends Action>({
  garden,
  graph,
  action,
  log,
}: {
  garden: Garden
  graph: ConfigGraph
  action: T
  log: Log
}): Promise<Resolved<T>> {
  log.info(`Resolving ${action.longDescription()}`)

  const task = new ResolveActionTask({
    garden,
    action,
    graph,
    log,
    force: true,
  })

  const results = await garden.processTasks({ tasks: [task], log, throwOnError: true })

  log.info(`Done!`)

  return <Resolved<T>>(<unknown>results.results.getResult(task)!.result!.outputs.resolvedAction)
}

export interface ResolvedActions<T extends Action> {
  [key: string]: Resolved<T>
}

/**
 * Helper for resolving specific actions.
 *
 * This runs the GraphSolver as needed to resolve dependencies and fully resolve the action specs.
 */
export async function resolveActions<T extends Action>({
  garden,
  graph,
  actions,
  log,
}: {
  garden: Garden
  graph: ConfigGraph
  actions: T[]
  log: Log
}): Promise<ResolvedActions<T>> {
  const tasks = actions.map(
    (action) =>
      new ResolveActionTask({
        garden,
        action,
        graph,
        log,
        force: true,
      })
  )

  const results = await garden.processTasks({ tasks, log, throwOnError: true })

  return <ResolvedActions<T>>(<unknown>mapValues(results.results.getMap(), (r) => r!.result!.outputs.resolvedAction))
}

/**
 * Helper for executing a single action.
 *
 * This runs the GraphSolver as needed to resolve dependencies and execute the action if needed.
 */
export async function executeAction<T extends Action>({
  garden,
  graph,
  action,
  log,
  statusOnly,
}: {
  garden: Garden
  graph: ConfigGraph
  action: T
  log: Log
  statusOnly?: boolean
}): Promise<Executed<T>> {
  const task = getExecuteTaskForAction(action, {
    garden,
    graph,
    log,
    force: true,
  })

  const results = await garden.processTasks({ tasks: [task], log, throwOnError: true, statusOnly })

  return <Executed<T>>(<unknown>results.results.getResult(task)!.result!.executedAction)
}

const getBuiltinConfigContextKeys = memoize(() => {
  const keys: string[] = []

  for (const schema of [buildActionConfigSchema(), baseRuntimeActionConfigSchema()]) {
    const configKeys = schema.describe().keys

    for (const [k, v] of Object.entries(configKeys)) {
      if ((<JoiDescription>v).metas?.find((m) => m.templateContext === ActionConfigContext)) {
        keys.push(k)
      }
    }
  }

  return uniq(keys)
})

function getActionSchema(kind: ActionKind) {
  switch (kind) {
    case "Build":
      return buildActionConfigSchema()
    case "Deploy":
      return deployActionConfigSchema()
    case "Run":
      return runActionConfigSchema()
    case "Test":
      return testActionConfigSchema()
    default:
      return kind satisfies never
  }
}

export const preprocessActionConfig = profileAsync(async function preprocessActionConfig({
  garden,
  config,
  mode,
  router,
  log,
}: {
  garden: Garden
  config: ActionConfig
  router: ActionRouter
  mode: ActionMode
  log: Log
}) {
  const description = describeActionConfig(config)
  const templateName = config.internal.templateName

  // in pre-processing, only use varfiles that are not template strings
  const resolvedVarFiles = config.varfiles?.filter((f) => !maybeTemplateString(f))
  const variables = await mergeVariables({
    basePath: config.internal.basePath,
    variables: config.variables,
    varfiles: resolvedVarFiles,
  })
  const resolvedVariables = resolveTemplateStrings(
    variables,
    new ActionConfigContext({
      garden,
      config: { ...config, internal: { ...config.internal, inputs: {} } },
      thisContextParams: {
        mode,
        name: config.name,
      },
      variables,
    }),
    { allowPartial: true }
  )

  if (templateName) {
    // Partially resolve inputs
    const partiallyResolvedInputs = resolveTemplateStrings(
      config.internal.inputs || {},
      new ActionConfigContext({
        garden,
        config: { ...config, internal: { ...config.internal, inputs: {} } },
        thisContextParams: {
          mode,
          name: config.name,
        },
        variables: resolvedVariables,
      }),
      { allowPartial: true }
    )

    const template = garden.configTemplates[templateName]

    // Note: This shouldn't happen in normal user flows
    if (!template) {
      throw new InternalError({
        message: `${description} references template '${
          config.internal.templateName
        }' which cannot be found. Available templates: ${naturalList(Object.keys(garden.configTemplates)) || "(none)"}`,
        detail: { templateName },
      })
    }

    // Validate inputs schema
    config.internal.inputs = validateWithPath({
      config: cloneDeep(partiallyResolvedInputs),
      configType: `inputs for ${description}`,
      path: config.internal.basePath,
      schema: template.inputsSchema,
      projectRoot: garden.projectRoot,
      yamlDoc: undefined,
      yamlDocBasePath: [],
    })
  }

  const builtinConfigKeys = getBuiltinConfigContextKeys()
  const builtinFieldContext = new ActionConfigContext({
    garden,
    config,
    thisContextParams: {
      mode,
      name: config.name,
    },
    variables: resolvedVariables,
  })

  function resolveTemplates() {
    // Fully resolve built-in fields that only support `ActionConfigContext`.
    // TODO-0.13.1: better error messages when something goes wrong here (missing inputs for example)
    const resolvedBuiltin = resolveTemplateStrings(pick(config, builtinConfigKeys), builtinFieldContext, {
      allowPartial: false,
    })
    config = { ...config, ...resolvedBuiltin }
    const { spec = {} } = config

    // Validate fully resolved keys (the above + those that don't allow any templating)
    // TODO-0.13.1: better error messages when something goes wrong here
    config = validateWithPath({
      config: {
        ...config,
        variables: {},
        spec: {},
      },
      schema: getActionSchema(config.kind),
      configType: describeActionConfig(config),
      name: config.name,
      path: config.internal.basePath,
      projectRoot: garden.projectRoot,
      yamlDoc: config.internal.yamlDoc,
      yamlDocBasePath: [],
    })

    config = { ...config, variables: resolvedVariables, spec }

    // Partially resolve other fields
    // TODO-0.13.1: better error messages when something goes wrong here (missing inputs for example)

    const resolvedOther = resolveTemplateStrings(omit(config, builtinConfigKeys), builtinFieldContext, {
      allowPartial: true,
    })
    config = { ...config, ...resolvedOther }
  }

  resolveTemplates()

  const { config: updatedConfig, supportedModes } = await router.configureAction({ config, log })

  // -> Throw if trying to modify no-template fields
  for (const field of noTemplateFields) {
    if (!isEqual(config[field], updatedConfig[field])) {
      throw new PluginError({
        message: `Configure handler for ${description} attempted to modify the ${field} field, which is not allowed. Please report this as a bug.`,
        detail: { config, field, original: config[field], modified: updatedConfig[field] },
      })
    }
  }

  // for an Deploy/Test/Run action, when build is specified
  // we set the include field to [] unless either of include or exclude
  // is explicitly set on the config.
  if (config.kind !== "Build" && config.build) {
    if (!updatedConfig.include && !updatedConfig.exclude) {
      updatedConfig.include = []
    }
  }

  config = updatedConfig

  // -> Resolve templates again after configure handler
  // TODO: avoid this if nothing changed in the configure handler
  try {
    resolveTemplates()
  } catch (error) {
    throw new ConfigurationError({
      message: `Configure handler for ${config.type} ${config.kind} set a templated value on a config field which could not be resolved. This may be a bug in the plugin, please report this. Error: ${error}`,
      detail: { config, error },
    })
  }

  return { config, supportedModes, templateContext: builtinFieldContext }
})

function dependenciesFromActionConfig(
  log: Log,
  config: ActionConfig,
  configsByKey: ActionConfigsByKey,
  definition: MaybeUndefined<ActionTypeDefinition<any>>,
  templateContext: ConfigContext,
  actionTypes: ActionDefinitionMap
) {
  const description = describeActionConfig(config)

  if (!config.dependencies) {
    config.dependencies = []
  }

  const deps: ActionDependency[] = config.dependencies.map((d) => {
    try {
      const { kind, name } = parseActionReference(d)
      return { kind, name, explicit: true, needsExecutedOutputs: false, needsStaticOutputs: false }
    } catch (error) {
      throw new ValidationError({
        message: `Invalid dependency specified: ${error.message}`,
        detail: { error, config },
      })
    }
  })

  function addDep(ref: ActionReference, attributes: ActionDependencyAttributes) {
    addActionDependency({ ...ref, ...attributes }, deps)
  }

  if (config.kind === "Build") {
    // -> Build copyFrom field
    for (const copyFrom of config.copyFrom || []) {
      // TODO: need to update this for parameterized actions
      const ref: ActionReference = { kind: "Build", name: copyFrom.build }
      const buildKey = actionReferenceToString(ref)

      if (!configsByKey[buildKey]) {
        throw new ConfigurationError({
          message: `${description} references Build ${copyFrom.build} in the \`copyFrom\` field, but no such Build action could be found`,
          detail: { config, buildName: copyFrom.build },
        })
      }

      addDep(ref, { explicit: true, needsExecutedOutputs: false, needsStaticOutputs: false })
    }
  } else if (config.build) {
    // -> build field on runtime actions
    const ref: ActionReference = { kind: "Build", name: config.build }
    const buildKey = actionReferenceToString(ref)

    if (!configsByKey[buildKey]) {
      throw new ConfigurationError({
        message: `${description} references Build ${config.build} in the \`build\` field, but no such Build action could be found`,
        detail: { config, buildName: config.build },
      })
    }

    addDep(ref, { explicit: true, needsExecutedOutputs: false, needsStaticOutputs: false })
  }

  // Action template references in spec/variables
  // -> We avoid depending on action execution when referencing static output keys
  const staticOutputKeys = definition?.staticOutputsSchema ? describeSchema(definition.staticOutputsSchema).keys : []

  for (const ref of getActionTemplateReferences(config)) {
    let needsExecuted = false

    const outputKey = ref.fullRef[4] as string

    if (maybeTemplateString(ref.name)) {
      try {
        ref.name = resolveTemplateString(ref.name, templateContext, { allowPartial: false })
      } catch (err) {
        log.warn(
          `Unable to infer dependency from action reference in ${description}, because template string '${ref.name}' could not be resolved. Either fix the dependency or specify it explicitly.`
        )
        continue
      }
    }
    // also avoid execution when referencing the static output keys of the ref action type.
    // e.g. a helm deploy referencing container build static output deploymentImageName
    // ${actions.build.my-container.outputs.deploymentImageName}
    const refActionKey = actionReferenceToString(ref)
    const refActionType = configsByKey[refActionKey]?.type
    let refStaticOutputKeys: string[] = []
    if (refActionType) {
      const refActionSpec = actionTypes[ref.kind][refActionType]?.spec
      refStaticOutputKeys = refActionSpec?.staticOutputsSchema
        ? describeSchema(refActionSpec.staticOutputsSchema).keys
        : []
    }

    if (
      ref.fullRef[3] === "outputs" &&
      outputKey &&
      !staticOutputKeys.includes(outputKey) &&
      !refStaticOutputKeys.includes(outputKey)
    ) {
      needsExecuted = true
    }

    addDep(ref, { explicit: false, needsExecutedOutputs: needsExecuted, needsStaticOutputs: !needsExecuted })
  }

  return deps
}
