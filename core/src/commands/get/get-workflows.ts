/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Command, CommandResult, CommandParams } from "../base"
import { printHeader } from "../../logger/util"
import { StringsParameter } from "../../cli/params"
import { prettyPrintWorkflow } from "../helpers"

const getWorkflowsArgs = {
  workflows: new StringsParameter({
    help: "Specify workflow(s) to list. You may specify multiple workflows, separated by spaces.",
    spread: true,
    getSuggestions: ({ configDump }) => {
      return Object.keys(configDump.workflowConfigs)
    },
  }),
}

type Args = typeof getWorkflowsArgs

export class GetWorkflowsCommand extends Command<Args> {
  name = "workflows"
  help = "Lists the workflows defined in your project."

  override arguments = getWorkflowsArgs

  override printHeader({ log }) {
    printHeader(log, "Workflows", "📖")
  }

  async action({ args, garden, log }: CommandParams<Args>): Promise<CommandResult> {
    const workflows = (await garden.getRawWorkflowConfigs(args.workflows)).sort((w1, w2) =>
      w1.name.localeCompare(w2.name)
    )

    if (workflows.length > 0) {
      workflows.forEach((w) => log.info(prettyPrintWorkflow(w)))
      log.info("")
    } else {
      log.info(`No workflows defined for project ${garden.projectName}`)
    }

    return { result: workflows }
  }
}
