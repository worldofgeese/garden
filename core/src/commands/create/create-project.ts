/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import dedent from "dedent"
import { pathExists, writeFile, copyFile } from "fs-extra"
import { Command, CommandResult, CommandParams } from "../base"
import { printHeader } from "../../logger/util"
import { isDirectory } from "../../util/fs"
import { loadConfigResources } from "../../config/base"
import { resolve, basename, relative, join } from "path"
import { GardenBaseError, ParameterError } from "../../exceptions"
import { renderProjectConfigReference } from "../../docs/config"
import { addConfig } from "./helpers"
import { wordWrap } from "../../util/string"
import { PathParameter, StringParameter, BooleanParameter, StringOption } from "../../cli/params"
import { userPrompt } from "../../util/util"
import { DOCS_BASE_URL, GardenApiVersion } from "../../constants"

const ignorefileName = ".gardenignore"
const defaultIgnorefile = dedent`
# Add paths here that you would like Garden to ignore when building modules and computing versions,
# using the same syntax as .gitignore files.
# For more info, see ${DOCS_BASE_URL}/using-garden/configuration-overview#including-excluding-files-and-directories
`

export const defaultProjectConfigFilename = "project.garden.yml"

const createProjectArgs = {}
const createProjectOpts = {
  dir: new PathParameter({
    help: "Directory to place the project in (defaults to current directory).",
    defaultValue: ".",
  }),
  filename: new StringParameter({
    help: "Filename to place the project config in (defaults to project.garden.yml).",
    defaultValue: defaultProjectConfigFilename,
  }),
  interactive: new BooleanParameter({
    aliases: ["i"],
    help: "Set to false to disable interactive prompts.",
    defaultValue: true,
  }),
  name: new StringOption({
    help: "Name of the project (defaults to current directory name).",
  }),
}

type CreateProjectArgs = typeof createProjectArgs
type CreateProjectOpts = typeof createProjectOpts

interface CreateProjectResult {
  configPath: string
  ignoreFileCreated: boolean
  ignoreFilePath: string
  name: string
}

class CreateError extends GardenBaseError {
  type: "create"
}

export class CreateProjectCommand extends Command<CreateProjectArgs, CreateProjectOpts> {
  name = "project"
  help = "Create a new Garden project."
  override noProject = true
  override cliOnly = true

  override description = dedent`
    Creates a new Garden project configuration. The generated config includes some default values, as well as the
    schema of the config in the form of commentented-out fields. Also creates a default (blank) .gardenignore file
    in the same path.

    Examples:

        garden create project                     # create a Garden project config in the current directory
        garden create project --dir some-dir      # create a Garden project config in the ./some-dir directory
        garden create project --name my-project   # set the project name to my-project
        garden create project --interactive=false # don't prompt for user inputs when creating the config
  `

  override arguments = createProjectArgs
  override options = createProjectOpts

  override printHeader({ log }) {
    printHeader(log, "Create new project", "✏️")
  }

  // Defining it like this because it'll stall on waiting for user input.
  override maybePersistent() {
    return true
  }

  override allowInDevCommand() {
    return false
  }

  async action({
    opts,
    log,
  }: CommandParams<CreateProjectArgs, CreateProjectOpts>): Promise<CommandResult<CreateProjectResult>> {
    const configDir = resolve(process.cwd(), opts.dir)

    if (!(await isDirectory(configDir))) {
      throw new ParameterError({ message: `${configDir} is not a directory`, detail: { configDir } })
    }

    const configPath = join(configDir, opts.filename)

    // Throw if a project config already exists in the config path
    if (await pathExists(configPath)) {
      const configs = await loadConfigResources(log, configDir, configPath)

      if (configs.filter((c) => c.kind === "Project").length > 0) {
        throw new CreateError({
          message: `A Garden project already exists in ${configPath}`,
          detail: { configDir, configPath },
        })
      }
    }

    let name = opts.name || basename(configDir)

    if (opts.interactive && !opts.name) {
      const answer = await userPrompt({
        name: "name",
        message: "Project name:",
        type: "input",
        default: name,
      })

      name = answer.name

      log.info("")
    }

    let { yaml } = renderProjectConfigReference({
      yamlOpts: {
        onEmptyValue: "remove",
        filterMarkdown: true,
        renderBasicDescription: !opts["skip-comments"],
        renderFullDescription: false,
        renderValue: "preferExample",
        presetValues: {
          kind: "Project",
          name,
          apiVersion: GardenApiVersion.v1,
          environments: [{ name: "default" }],
          providers: [{ name: "local-kubernetes" }],
        },
      },
    })

    const projectDocURL = `${DOCS_BASE_URL}/using-garden/projects`
    const projectReferenceURL = `${DOCS_BASE_URL}/reference/project-config`
    yaml =
      dedent`
    # Documentation about Garden projects can be found at ${projectDocURL}
    # Reference for Garden projects can be found at ${projectReferenceURL}` + `\n\n${yaml}`

    await addConfig(configPath, yaml)

    log.info(chalk.green(`-> Created new project config in ${chalk.bold.white(relative(process.cwd(), configPath))}`))

    const ignoreFilePath = resolve(configDir, ignorefileName)
    let ignoreFileCreated = false

    if (!(await pathExists(ignoreFilePath))) {
      const gitIgnorePath = resolve(configDir, ".gitignore")

      if (await pathExists(gitIgnorePath)) {
        await copyFile(gitIgnorePath, ignoreFilePath)
        const gitIgnoreRelPath = chalk.bold.white(relative(process.cwd(), ignoreFilePath))
        log.info(
          chalk.green(
            `-> Copied the .gitignore file at ${gitIgnoreRelPath} to a new .gardenignore in the same directory. Please edit the .gardenignore file if you'd like Garden to include or ignore different files.`
          )
        )
      } else {
        await writeFile(ignoreFilePath, defaultIgnorefile + "\n")
        const gardenIgnoreRelPath = chalk.bold.white(relative(process.cwd(), ignoreFilePath))
        log.info(
          chalk.green(
            `-> Created default .gardenignore file at ${gardenIgnoreRelPath}. Please edit the .gardenignore file to add files or patterns that Garden should ignore when scanning and building.`
          )
        )
      }

      ignoreFileCreated = true
    }

    log.info("")

    // This is to avoid `prettier` messing with the string formatting...
    const configFilesUrl = chalk.cyan.underline(`${DOCS_BASE_URL}/using-garden/configuration-overview`)
    const referenceUrl = chalk.cyan.underline(projectReferenceURL)

    log.info(
      wordWrap(
        dedent`
        For more information about Garden configuration files, please check out ${configFilesUrl}, and for a detailed reference, take a look at ${referenceUrl}.
        `,
        120
      )
    )

    log.info("")

    return { result: { configPath, ignoreFileCreated, ignoreFilePath, name } }
  }
}
