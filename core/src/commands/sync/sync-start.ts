/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { BooleanParameter, StringsParameter } from "../../cli/params"
import { joi } from "../../config/common"
import { printHeader } from "../../logger/util"
import { DeployTask } from "../../tasks/deploy"
import { dedent, naturalList } from "../../util/string"
import { Command, CommandParams, CommandResult, PrepareParams } from "../base"
import chalk from "chalk"
import { ParameterError, RuntimeError } from "../../exceptions"
import { SyncMonitor } from "../../monitors/sync"
import { Log, createActionLog } from "../../logger/log-entry"
import { DeployAction } from "../../actions/deploy"
import { ConfigGraph } from "../../graph/config-graph"
import { Garden } from "../.."

const syncStartArgs = {
  names: new StringsParameter({
    help: "The name(s) of one or more Deploy(s) (or services if using modules) to sync. You may specify multiple names, separated by spaces. To start all possible syncs, specify '*' as an argument.",
    required: false,
    spread: true,
    getSuggestions: ({ configDump }) => {
      return Object.keys(configDump.actionConfigs.Deploy)
    },
  }),
}
type Args = typeof syncStartArgs

const syncStartOpts = {
  "deploy": new BooleanParameter({
    help: "Deploy the specified actions, if they're out of date and/or not deployed in sync mode.",
  }),
  "with-dependencies": new BooleanParameter({
    help: "When deploying actions, also include any runtime dependencies. Ignored if --deploy is not set.",
  }),
  "monitor": new BooleanParameter({
    aliases: ["m"],
    help: "Keep the process running and print sync status logs after starting them.",
  }),
}
type Opts = typeof syncStartOpts

export class SyncStartCommand extends Command<Args, Opts> {
  name = "start"
  help = "Start any configured syncs to the given Deploy action(s)."

  override protected = true

  override arguments = syncStartArgs
  override options = syncStartOpts

  override description = dedent`
    Start a sync between your local project directory and one or more Deploys.

    Examples:
        # start syncing to the 'api' Deploy, fail if it's not already deployed in sync mode
        garden sync start api

        # deploy 'api' in sync mode and dependencies if needed, then start syncing
        garden sync start api --deploy

        # start syncing to every Deploy already deployed in sync mode
        garden sync start

        # start syncing to every Deploy that supports it, deploying if needed
        garden sync start '*' --deploy

        # start syncing to every Deploy that supports it, deploying if needed including runtime dependencies
        garden sync start --deploy --include-dependencies

        # start syncing to the 'api' and 'worker' Deploys
        garden sync start api worker

        # start syncing to the 'api' Deploy and keep the process running, following sync status messages
        garden sync start api -f
  `

  override outputsSchema = () => joi.object()

  override printHeader({ log }) {
    printHeader(log, "Starting sync(s)", "🔁")
  }

  override maybePersistent({ opts }: PrepareParams<Args, Opts>) {
    return !!opts.monitor
  }

  async action(params: CommandParams<Args, Opts>): Promise<CommandResult<{}>> {
    const { garden, log, args, opts } = params

    // We default to starting syncs for all Deploy actions
    const names = args.names || ["*"]

    // We want to stop any started syncs on exit if we're calling `sync start` from inside the `dev` command.
    const stopOnExit = !!params.commandLine

    const graph = await garden.getConfigGraph({
      log,
      emit: true,
      actionModes: {
        sync: names.map((n) => "deploy." + n),
      },
    })

    let actions = graph.getDeploys({ includeNames: names })

    if (actions.length === 0) {
      log.warn({
        msg: `No enabled Deploy actions found (matching argument(s) ${naturalList(
          names.map((n) => `'${n}'`)
        )}). Aborting.`,
      })
      return { result: {} }
    }

    actions = actions.filter((action) => {
      const actionLog = createActionLog({ log, actionName: action.name, actionKind: action.kind })
      if (!action.supportsMode("sync")) {
        if (names.includes(action.name)) {
          actionLog.warn(chalk.yellow(`${action.longDescription()} does not support syncing.`))
        } else {
          actionLog.debug(`${action.longDescription()} does not support syncing.`)
        }
        return false
      }
      return true
    })

    const actionKeys = actions.map((a) => a.key())

    if (actions.length === 0) {
      throw new ParameterError({ message: `No matched action supports syncing. Aborting.`, detail: { actionKeys } })
    }

    if (opts.deploy) {
      // Deploy and start syncs
      const tasks = actions.map((action) => {
        const task = new DeployTask({
          garden,
          graph,
          log,
          action,
          force: false,
          forceActions: [],
          skipRuntimeDependencies: !opts["with-dependencies"],
          startSync: true,
        })
        if (opts.monitor) {
          task.on("ready", ({ result }) => {
            const executedAction = result?.executedAction
            const monitor = new SyncMonitor({ garden, log, action: executedAction, graph, stopOnExit })
            garden.monitors.addAndSubscribe(monitor, this)
          })
        }
        return task
      })
      await garden.processTasks({ tasks, log })
      log.info(chalk.green("\nDone!"))
      return {}
    } else {
      // Don't deploy, just start syncs
      await startSyncWithoutDeploy({
        actions,
        graph,
        garden,
        command: this,
        log,
        monitor: opts.monitor,
        stopOnExit,
      })
      if (garden.monitors.getAll().length === 0) {
        log.info(chalk.green("\nDone!"))
      }
      return {}
    }
  }
}

export async function startSyncWithoutDeploy({
  actions,
  graph,
  garden,
  command,
  log,
  monitor,
  stopOnExit,
}: {
  actions: DeployAction[]
  graph: ConfigGraph
  garden: Garden
  command: Command
  log: Log
  monitor: boolean
  stopOnExit: boolean
}) {
  const actionKeys = actions.map((a) => a.key())
  const tasks = actions.map((action) => {
    return new DeployTask({
      garden,
      graph,
      log,
      action,
      force: false,
      forceActions: [],
      skipRuntimeDependencies: true,
      startSync: true,
    })
  })

  const statusResult = await garden.processTasks({ log, tasks, statusOnly: true })
  let someSyncStarted = false

  const router = await garden.getActionRouter()

  await Promise.all(
    tasks.map(async (task) => {
      const action = task.action
      const result = statusResult.results.getResult(task)

      const mode = result?.result?.detail?.mode
      const state = result?.result?.detail?.state
      const executedAction = result?.result?.executedAction
      const actionLog = createActionLog({ log, actionName: action.name, actionKind: action.kind })

      if (executedAction && (state === "outdated" || state === "ready")) {
        if (mode !== "sync") {
          actionLog.warn(
            chalk.yellow(
              `Not deployed in sync mode, cannot start sync. Try running this command with \`--deploy\` set.`
            )
          )
          return
        }
        // Attempt to start sync even if service is outdated but in sync mode
        try {
          await router.deploy.startSync({ log: actionLog, action: executedAction, graph })
          someSyncStarted = true

          if (monitor) {
            const m = new SyncMonitor({ garden, log, action: executedAction, graph, stopOnExit })
            garden.monitors.addAndSubscribe(m, command)
          }
        } catch (error) {
          actionLog.warn(
            chalk.yellow(dedent`
            Failed starting sync for ${action.longDescription()}: ${error}

            You may need to re-deploy the action. Try running this command with \`--deploy\` set, or running \`garden deploy --sync\` before running this command again.
          `)
          )
        }
      } else {
        actionLog.warn(chalk.yellow(`${action.longDescription()} is not deployed, cannot start sync.`))
      }
    })
  )

  if (!someSyncStarted) {
    throw new RuntimeError({
      message: `Could not start any sync. Aborting.`,
      detail: {
        actionKeys,
      },
    })
  }
}
