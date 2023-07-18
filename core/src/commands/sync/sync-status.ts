/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import chalk from "chalk"

import { BooleanParameter, StringsParameter } from "../../cli/params"
import { joi } from "../../config/common"
import { printHeader } from "../../logger/util"
import { dedent, deline, naturalList } from "../../util/string"
import { Command, CommandParams } from "../base"
import { createActionLog, Log } from "../../logger/log-entry"
import { PluginEventBroker } from "../../plugin-context"
import { resolvedActionToExecuted } from "../../actions/helpers"
import { GetSyncStatusResult, SyncState } from "../../plugin/handlers/Deploy/get-sync-status"
import { isEmpty, omit } from "lodash"
import { Garden } from "../.."
import { ResolvedDeployAction } from "../../actions/deploy"
import { ResolvedConfigGraph } from "../../graph/config-graph"
import { DOCS_BASE_URL } from "../../constants"

const syncStatusArgs = {
  names: new StringsParameter({
    help: deline`
      The name(s) of the Deploy(s) to get the sync status for (skip to get status from
      all Deploys in the project). You may specify multiple names, separated by space.
    `,
    required: false,
    spread: true,
    getSuggestions: ({ configDump }) => {
      return Object.keys(configDump.actionConfigs.Deploy)
    },
  }),
}

const syncStatusOpts = {
  "skip-detail": new BooleanParameter({
    help: deline`
      Skip plugin specific sync details. Only applicable when using the --output=json|yaml option.
      Useful for trimming down the output.
    `,
  }),
}

type Args = typeof syncStatusArgs
type Opts = typeof syncStatusOpts

interface SyncStatusCommandResult {
  result: {
    actions: {
      [actionName: string]: GetSyncStatusResult
    }
  }
}

export class SyncStatusCommand extends Command<Args, Opts> {
  name = "status"
  help = "Get sync statuses."

  override protected = true

  override arguments = syncStatusArgs
  override options = syncStatusOpts

  override description = dedent`
    Get the current status of the configured syncs for this project.

    Examples:
        # get all sync statuses
        garden sync status

        # get sync statuses for the 'api' Deploy
        garden sync status api

        # output detailed sync statuses in JSON format
        garden sync status -o json

        # output detailed sync statuses in YAML format
        garden sync status -o yaml
  `

  override outputsSchema = () => joi.object()

  override printHeader({ log }) {
    printHeader(log, "Getting sync statuses", "📟")
  }

  async action({ garden, log, args, opts }: CommandParams<Args, Opts>): Promise<SyncStatusCommandResult> {
    // TODO: Use regular graph and resolve only the needed Deploys below
    const graph = await garden.getResolvedConfigGraph({ log, emit: true })
    const skipDetail = opts["skip-detail"]

    const deployActions = graph
      .getDeploys({ includeDisabled: false, names: args.names })
      .sort((a, b) => (a.name > b.name ? 1 : -1))

    const syncStatuses = await getSyncStatuses({ garden, graph, skipDetail, log, deployActions })

    if (isEmpty(syncStatuses) && args.names && args.names.length > 0) {
      log.warn(`No syncs have been configured for the requested Deploys (${naturalList(args.names!)}).`)
    } else if (isEmpty(syncStatuses)) {
      log.warn(deline`
        No syncs have been configured in this project.

        Follow the link below to learn how to enable live code syncing with Garden:
      `)
      log.info("")
      log.info(chalk.cyan.underline(`${DOCS_BASE_URL}/guides/code-synchronization`))
    }

    return { result: { actions: syncStatuses } }
  }
}

function stateStyle(state: SyncState, msg: string) {
  const styleFn =
    {
      "active": chalk.green,
      "failed": chalk.red,
      "not-active": chalk.yellow,
    }[state] || chalk.bold.dim
  return styleFn(msg)
}

function describeState(state: SyncState) {
  return state.replace("-", " ")
}

export async function getSyncStatuses({
  deployActions,
  skipDetail,
  garden,
  log,
  graph,
}: {
  log: Log
  deployActions: ResolvedDeployAction[]
  skipDetail: boolean
  garden: Garden
  graph: ResolvedConfigGraph
}) {
  const router = await garden.getActionRouter()

  const syncStatuses: { [actionName: string]: GetSyncStatusResult } = {}
  // This is fairly arbitrary
  const concurrency = 5

  await Bluebird.map(
    deployActions,
    async (action) => {
      const events = new PluginEventBroker(garden)
      const actionLog = createActionLog({ log, actionName: action.name, actionKind: action.kind })
      const { result: status } = await router.deploy.getStatus({
        graph,
        action,
        log: actionLog,
      })
      const executedAction = resolvedActionToExecuted(action, { status })
      const syncStatus = omit(
        (
          await router.deploy.getSyncStatus({
            log: actionLog,
            action: executedAction,
            monitor: false,
            graph,
            events,
          })
        ).result,
        skipDetail ? "detail" : ""
      )

      const syncs = syncStatus.syncs
      if (!syncs || syncs.length === 0) {
        return
      }

      // Return the syncs sorted
      const sorted = syncs.sort((a, b) => {
        const keyA = a.source + a.target + a.mode
        const keyB = b.source + b.target + b.mode
        return keyA > keyB ? 1 : -1
      })
      syncStatus["syncs"] = sorted

      const verbMap = {
        "active": "is",
        "failed": "has",
        "not-active": "is",
      }

      const syncCount = syncStatus.syncs.length
      const pluralizedSyncs = syncCount === 1 ? "sync" : "syncs"
      log.info(
        `The ${chalk.cyan(action.name)} Deploy action has ${chalk.cyan(syncCount)} ${pluralizedSyncs} configured:`
      )
      const leftPad = "  →"
      syncs.forEach((sync, idx) => {
        const state = sync.state
        log.info(
          `${leftPad} Sync from ${chalk.cyan(sync.source)} to ${chalk.cyan(sync.target)} ${verbMap[state]} ${stateStyle(
            state,
            describeState(state)
          )}`
        )
        sync.mode && log.info(chalk.bold(`${leftPad} Mode: ${sync.mode}`))
        sync.syncCount && log.info(chalk.bold(`${leftPad} Number of completed syncs: ${sync.syncCount}`))
        if (state === "failed" && sync.message) {
          log.info(`${chalk.bold(leftPad)} ${chalk.yellow(sync.message)}`)
        }
        idx !== syncs.length - 1 && log.info("")
      })
      log.info("")

      syncStatuses[action.name] = syncStatus
    },
    { concurrency }
  )

  return syncStatuses
}
