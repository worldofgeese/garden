/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import {
  ActionTaskProcessParams,
  ActionTaskStatusParams,
  ExecuteActionTask,
  emitGetStatusEvents,
  emitProcessingEvents,
} from "../tasks/base"
import { Profile } from "../util/profiling"
import { BuildAction, BuildActionConfig, ResolvedBuildAction } from "../actions/build"
import pluralize from "pluralize"
import { BuildStatus } from "../plugin/handlers/Build/get-status"
import { resolvedActionToExecuted } from "../actions/helpers"
import { renderDuration } from "../logger/util"
import { OtelTraced } from "../util/open-telemetry/decorators"
import { wrapActiveSpan } from "../util/open-telemetry/spans"

@Profile()
export class BuildTask extends ExecuteActionTask<BuildAction, BuildStatus> {
  type = "build" as const
  override concurrencyLimit = 5
  eventName = "buildStatus" as const

  getDescription() {
    return this.action.longDescription()
  }

  @OtelTraced({
    name(_params) {
      return `${this.action.key()}.getBuildStatus`
    },
    getAttributes(_params) {
      return {
        key: this.action.key(),
        kind: this.action.kind,
      }
    },
  })
  @(emitGetStatusEvents<BuildAction>)
  async getStatus({ statusOnly, dependencyResults }: ActionTaskStatusParams<BuildAction>) {
    const router = await this.garden.getActionRouter()
    const action = this.getResolvedAction(this.action, dependencyResults)

    const output = await router.build.getStatus({ log: this.log, graph: this.graph, action })
    const status = output.result

    if (status.state === "ready" && !statusOnly && !this.force) {
      this.log.info(`Already built`)
      await this.ensureBuildContext(action)
    }

    return { ...status, version: action.versionString(), executedAction: resolvedActionToExecuted(action, { status }) }
  }

  @OtelTraced({
    name(_params) {
      return `${this.action.key()}.build`
    },
    getAttributes(_params) {
      return {
        key: this.action.key(),
        kind: this.action.kind,
      }
    },
  })
  @(emitProcessingEvents<BuildAction>)
  async process({ dependencyResults }: ActionTaskProcessParams<BuildAction, BuildStatus>) {
    const router = await this.garden.getActionRouter()
    const action = this.getResolvedAction(this.action, dependencyResults)

    if (action.isDisabled()) {
      this.log.info(
        `${action.longDescription()} is disabled, but is being executed because another action depends on it.`
      )
    }

    const log = this.log
    await this.buildStaging(action)

    try {
      const { result } = await wrapActiveSpan("build", () =>
        router.build.build({
          graph: this.graph,
          action,
          log,
        })
      )
      log.success(`Done`)

      return {
        ...result,
        version: action.versionString(),
        executedAction: resolvedActionToExecuted(action, { status: result }),
      }
    } catch (err) {
      log.error(`Build failed`)

      throw err
    }
  }

  private async ensureBuildContext(action: ResolvedBuildAction<BuildActionConfig>) {
    const buildContextExists = await this.garden.buildStaging.actionBuildPathExists(action)
    if (!buildContextExists) {
      await this.buildStaging(action)
    }
  }

  private async buildStaging(action: ResolvedBuildAction<BuildActionConfig>) {
    const log = this.log
    const files = action.getFullVersion().files

    if (files.length > 0) {
      log.verbose(`Syncing sources (${pluralize("file", files.length, true)})...`)
    }

    await wrapActiveSpan("syncSources", async (span) => {
      span.setAttributes({
        "garden.filesSynced": files.length,
      })
      await this.garden.buildStaging.syncFromSrc({
        action,
        log: log || this.log,
      })
    })

    log.verbose(chalk.green(`Done syncing sources ${renderDuration(log.getDuration(1))}`))

    await wrapActiveSpan("syncDependencyProducts", async () => {
      await this.garden.buildStaging.syncDependencyProducts(action, log)
    })
  }
}
