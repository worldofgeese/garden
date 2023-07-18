/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { difference } from "lodash"
import dedent = require("dedent")
import chalk from "chalk"

import { Command, CommandResult, CommandParams } from "../base"
import { SourceConfig, moduleSourceSchema } from "../../config/project"
import { ParameterError } from "../../exceptions"
import { pruneRemoteSources, updateRemoteSharedOptions } from "./helpers"
import { moduleHasRemoteSource } from "../../util/ext-source-util"
import { printHeader } from "../../logger/util"
import { Garden } from "../../garden"
import { Log } from "../../logger/log-entry"
import { joiArray, joi } from "../../config/common"
import { StringsParameter, ParameterValues } from "../../cli/params"

const updateRemoteModulesArguments = {
  modules: new StringsParameter({
    help: "The name(s) of the remote module(s) to update. You may specify multiple modules, separated by spaces.",
    spread: true,
    getSuggestions: ({ configDump }) => {
      return Object.keys(configDump.moduleConfigs)
    },
  }),
}

type Args = typeof updateRemoteModulesArguments

const updateRemoteModulesOptions = {
  ...updateRemoteSharedOptions,
}

type Opts = typeof updateRemoteModulesOptions

interface Output {
  sources: SourceConfig[]
}

export class UpdateRemoteModulesCommand extends Command<Args, Opts> {
  name = "modules"
  help = "Update remote modules."
  override arguments = updateRemoteModulesArguments
  override options = updateRemoteModulesOptions

  override outputsSchema = () =>
    joi.object().keys({
      sources: joiArray(moduleSourceSchema()).description("A list of all external module sources in the project."),
    })

  override description = dedent`
    Updates remote modules, i.e. modules that have a \`repositoryUrl\` field
    in their \`garden.yml\` config that points to a remote repository.

    Examples:

        garden update-remote modules --parallel # update all remote modules in parallel mode
        garden update-remote modules            # update all remote modules in the project
        garden update-remote modules my-module  # update remote module my-module
  `

  override printHeader({ log }) {
    printHeader(log, "Update remote modules", "🛠️")
  }

  async action({ garden, log, args, opts }: CommandParams<Args, Opts>): Promise<CommandResult<Output>> {
    return updateRemoteModules({ garden, log, args, opts })
  }
}

export async function updateRemoteModules({
  garden,
  log,
  args,
  opts,
}: {
  garden: Garden
  log: Log
  args: ParameterValues<Args>
  opts: ParameterValues<Opts>
}) {
  const { modules: moduleNames } = args
  const graph = await garden.getConfigGraph({ log, emit: false })
  const modules = graph.getModules({ names: moduleNames })

  const moduleSources = <SourceConfig[]>modules
    .filter(moduleHasRemoteSource)
    .filter((src) => (moduleNames ? moduleNames.includes(src.name) : true))
    .map((m) => ({ name: m.name, repositoryUrl: m.repositoryUrl }))

  const names = moduleSources.map((src) => src.name)

  const diff = difference(moduleNames, names)
  if (diff.length > 0) {
    const modulesWithRemoteSource = graph.getModules().filter(moduleHasRemoteSource).sort()

    throw new ParameterError({
      message: `Expected module(s) ${chalk.underline(diff.join(","))} to have a remote source.`,
      detail: {
        modulesWithRemoteSource,
        input: moduleNames ? moduleNames.sort() : undefined,
      },
    })
  }

  const promises: Promise<void>[] = []
  for (const { name, repositoryUrl } of moduleSources) {
    const promise = garden.vcs.updateRemoteSource({
      name,
      url: repositoryUrl,
      sourceType: "module",
      log,
      failOnPrompt: opts.parallel,
    })
    if (opts.parallel) {
      promises.push(promise)
    } else {
      await promise
    }
  }
  await Promise.all(promises)

  await pruneRemoteSources({
    gardenDirPath: garden.gardenDirPath,
    type: "module",
    sources: moduleSources,
  })

  return { result: { sources: moduleSources } }
}
