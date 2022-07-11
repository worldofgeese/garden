/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import { LogEntry } from "../logger/log-entry"
import { BaseTask, getRunTaskResults, getServiceStatuses, TaskType } from "./base"
import { DeploymentPlan, GardenService } from "../types/service"
import { Garden } from "../garden"
import { ConfigGraph } from "../config-graph"
import { GraphResults } from "../task-graph"
import { getPlanDeps } from "./helpers"
import { GetServiceStatusTask } from "./get-service-status"
import { BuildTask } from "./build"
import { prepareRuntimeContext } from "../runtime-context"

export interface PlanTaskParams {
  garden: Garden
  graph: ConfigGraph
  service: GardenService
  log: LogEntry
  force: boolean
  forceBuild: boolean
  skipRuntimeDependencies: boolean
  devModeServiceNames?: string[]
  hotReloadServiceNames?: string[]
  localModeServiceNames?: string[]
}

export class PlanTask extends BaseTask {
  type: TaskType = "plan"
  concurrencyLimit = 10
  graph: ConfigGraph
  service: GardenService

  forceBuild: boolean
  skipRuntimeDependencies: boolean
  devModeServiceNames: string[]
  hotReloadServiceNames: string[]
  localModeServiceNames: string[]

  constructor({
    garden,
    graph,
    log,
    service,
    devModeServiceNames = [],
    hotReloadServiceNames = [],
    localModeServiceNames = [],
  }: PlanTaskParams) {
    super({ garden, log, force: false, version: service.version })
    this.graph = graph
    this.service = service
    this.forceBuild = false // TODO: Make this a CLI option for the plan command
    this.skipRuntimeDependencies = false // TODO: Make this a CLI option for the plan command
    this.devModeServiceNames = devModeServiceNames
    this.hotReloadServiceNames = hotReloadServiceNames
    this.localModeServiceNames = localModeServiceNames
  }

  async resolveDependencies() {
    const deps = this.graph.getDependencies({
      nodeType: "deploy",
      name: this.getName(),
      recursive: false,
    })

    const statusTask = new GetServiceStatusTask({
      garden: this.garden,
      graph: this.graph,
      log: this.log,
      service: this.service,
      force: false,
      devModeServiceNames: [],
      hotReloadServiceNames: [],
      localModeServiceNames: [],
    })

    const buildTasks = await BuildTask.factory({
      garden: this.garden,
      graph: this.graph,
      log: this.log,
      module: this.service.module,
      force: false,
    })

    return [statusTask, ...buildTasks, ...getPlanDeps(this, deps, false)]
  }

  getName() {
    return this.service.name
  }

  getDescription() {
    return `planning deployment for service '${this.service.name}' (from module '${this.service.module.name}')`
  }

  async process(dependencyResults: GraphResults): Promise<DeploymentPlan> {
    const version = this.version
    const actions = await this.garden.getActionRouter()
    let plan: DeploymentPlan

    let log: LogEntry

    const dependencies = this.graph.getDependencies({
      nodeType: "deploy",
      name: this.getName(),
      recursive: false,
    })

    const serviceStatuses = getServiceStatuses(dependencyResults)
    const taskResults = getRunTaskResults(dependencyResults)

    // TODO: attach runtimeContext to GetServiceStatusTask output
    const runtimeContext = await prepareRuntimeContext({
      garden: this.garden,
      graph: this.graph,
      dependencies,
      version,
      moduleVersion: this.service.module.version.versionString,
      serviceStatuses,
      taskResults,
    })

    try {
      log = this.log.info({
        section: this.getName(),
        msg: `Planning deployment at version ${this.version}...`,
        status: "active",
      })
      plan = await actions.planDeployment({ log: this.log, service: this.service, graph: this.graph, runtimeContext })
      const { summary, description } = plan
      log.setSuccess({
        msg: chalk.white(summary),
        append: true,
      })
      if (description) {
        // this.log.info(`Full diff:\n\n${description}`)
        this.log.verbose(`Full diff:\n\n${description}`)
      }
      log.info("")
    } catch (err) {
      this.log.setError()
      throw err
    }

    return plan
  }
}
