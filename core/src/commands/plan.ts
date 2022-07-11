/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { StringsParameter } from "../cli/params"
import { printHeader } from "../logger/util"
import { GraphResult, GraphResults } from "../task-graph"
import { PlanTask } from "../tasks/plan"
import { DeploymentPlan } from "../types/service"
import { dedent, deline } from "../util/string"
import { Command, CommandParams, CommandResult, processCommandResultSchema } from "./base"

const planArgs = {
  services: new StringsParameter({
    help: deline`
      The name(s) of the service(s) to plan deployments for. Use comma as a separator to specify multiple services.
    `,
  }),
}
const planOpts = {}

type Args = typeof planArgs
type Opts = typeof planOpts

export class PlanCommand extends Command<Args, Opts> {
  name = "plan"
  help = "Prepare deployment plans."

  protected = true
  streamEvents = true

  description = dedent`
    TODO
  `

  arguments = planArgs
  options = planOpts

  outputsSchema = () => processCommandResultSchema()

  printHeader({ headerLog }) {
    printHeader(headerLog, "Plan", "world_map")
  }

  async action({ garden, log, args }: CommandParams<Args, Opts>): Promise<CommandResult> {
    const graph = await garden.getConfigGraph({ log, emit: true })
    const services = graph.getServices({ names: args.services })

    if (services.length === 0) {
      log.warn({ msg: "No services found. Aborting." })
      return { result: {} }
    }

    const planTasks = services.map(
      (service) =>
        new PlanTask({ garden, graph, force: false, forceBuild: false, skipRuntimeDependencies: false, log, service })
    )
    const result = plannedDeployments(await garden.processTasks(planTasks))

    return { result }
  }
}

export function plannedDeployments(results: GraphResults): { [serviceName: string]: DeploymentPlan } {
  const planned = <GraphResult[]>Object.values(results).filter((r) => r && r.type === "plan")
  const plans = {}

  for (const res of planned) {
    plans[res.name] = res.output
  }

  return plans
}
