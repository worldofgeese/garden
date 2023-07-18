/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { resolve } from "path"
import dedent = require("dedent")
import chalk from "chalk"

import { ParameterError } from "../../exceptions"
import { Command, CommandResult } from "../base"
import { addLinkedSources } from "../../util/ext-source-util"
import { LinkedSource } from "../../config-store/local"
import { CommandParams } from "../base"
import { printHeader } from "../../logger/util"
import { joiArray, joi } from "../../config/common"
import { linkedSourceSchema } from "../../config/project"
import { StringParameter, PathParameter } from "../../cli/params"

const linkSourceArguments = {
  source: new StringParameter({
    help: "Name of the source to link as declared in the project config.",
    required: true,
    getSuggestions: ({ configDump }) => {
      return configDump.sources.map((s) => s.name)
    },
  }),
  path: new PathParameter({
    help: "Path to the local directory that contains the source.",
    required: true,
  }),
}

type Args = typeof linkSourceArguments

interface Output {
  sources: LinkedSource[]
}

export class LinkSourceCommand extends Command<Args> {
  name = "source"
  help = "Link a remote source to a local directory."
  override arguments = linkSourceArguments

  override outputsSchema = () =>
    joi.object().keys({
      sources: joiArray(linkedSourceSchema()).description("A list of all locally linked external sources."),
    })

  override description = dedent`
    After linking a remote source, Garden will read it from its local directory instead of
    from the remote URL. Garden can only link remote sources that have been declared in the project
    level \`garden.yml\` config.

    Examples:

        garden link source my-source path/to/my-source # links my-source to its local version at the given path
  `

  override printHeader({ log }) {
    printHeader(log, "Link source", "🔗")
  }

  async action({ garden, log, args }: CommandParams<Args>): Promise<CommandResult<Output>> {
    const sourceType = "project"

    const { source: sourceName, path } = args
    const projectSources = garden.getProjectSources()
    const projectSourceToLink = projectSources.find((src) => src.name === sourceName)

    if (!projectSourceToLink) {
      const availableRemoteSources = projectSources.map((s) => s.name).sort()

      throw new ParameterError({
        message:
          `Remote source ${chalk.underline(sourceName)} not found in project config.` +
          ` Did you mean to use the "link module" command?`,
        detail: {
          availableRemoteSources,
          input: sourceName,
        },
      })
    }

    const absPath = resolve(garden.projectRoot, path)

    const linkedProjectSources = await addLinkedSources({
      garden,
      sourceType,
      sources: [{ name: sourceName, path: absPath }],
    })

    log.info(`Linked source ${sourceName}`)

    return { result: { sources: linkedProjectSources } }
  }
}
