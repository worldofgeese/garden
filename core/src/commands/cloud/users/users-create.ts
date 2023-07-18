/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { CommandError, ConfigurationError } from "../../../exceptions"
import {
  CreateUserBulkRequest,
  CreateUserBulkResponse,
  UserResult as UserResultApi,
} from "@garden-io/platform-api-types"
import { readFile } from "fs-extra"

import { printHeader } from "../../../logger/util"
import { Command, CommandParams, CommandResult } from "../../base"
import { ApiCommandError, handleBulkOperationResult, makeUserFromResponse, noApiMsg, UserResult } from "../helpers"
import { dedent, deline } from "../../../util/string"
import { PathParameter, StringsParameter } from "../../../cli/params"
import { StringMap } from "../../../config/common"
import { chunk } from "lodash"
import dotenv = require("dotenv")
import Bluebird = require("bluebird")

// This is the limit set by the API.
const MAX_USERS_PER_REQUEST = 100

export const secretsCreateArgs = {
  users: new StringsParameter({
    help: deline`The VCS usernames and the names of the users to create, separated by '='.
      You may specify multiple VCS username/name pairs, separated by spaces. Note
      that you can also leave this empty and have Garden read the users from file.`,
    spread: true,
  }),
}

export const secretsCreateOpts = {
  "add-to-groups": new StringsParameter({
    help: deline`Add the user to the group with the given ID. You may add the user to multiple groups by setting this flag multiple times.`,
  }),
  "from-file": new PathParameter({
    help: deline`Read the users from the file at the given path. The file should have standard "dotenv"
    format (as defined by [dotenv](https://github.com/motdotla/dotenv#rules)) where the VCS username is the key and the
    name is the value.`,
  }),
}

type Args = typeof secretsCreateArgs
type Opts = typeof secretsCreateOpts

export class UsersCreateCommand extends Command<Args, Opts> {
  name = "create"
  help = "Create users in Garden Cloud."
  override description = dedent`
    Create users in Garden Cloud and optionally add the users to specific groups.
    You can get the group IDs from the \`garden cloud users list\` command.

    To create a user, you'll need their GitHub or GitLab username, depending on which one is your VCS provider, and the name
    they should have in Garden Cloud. Note that it **must** the their GitHub/GitLab username, not their email, as people
    can have several emails tied to their GitHub/GitLab accounts.

    You can optionally read the users from a file. The file must have the format vcs-username="Actual Username". For example:

    fatema_m="Fatema M"
    gordon99="Gordon G"

    Examples:
        garden cloud users create fatema_m="Fatema M" gordon99="Gordon G"  # create two users
        garden cloud users create fatema_m="Fatema M" --add-to-groups 1,2  # create a user and add two groups with IDs 1,2
        garden cloud users create --from-file /path/to/users.txt           # create users from the key value pairs in the users.txt file
  `

  override arguments = secretsCreateArgs
  override options = secretsCreateOpts

  override printHeader({ log }) {
    printHeader(log, "Create users", "🔒")
  }

  async action({ garden, log, opts, args }: CommandParams<Args, Opts>): Promise<CommandResult<UserResult[]>> {
    const addToGroups: string[] = opts["add-to-groups"] || []
    const fromFile = opts["from-file"] as string | undefined
    let users: StringMap

    if (fromFile) {
      try {
        users = dotenv.parse(await readFile(fromFile))
      } catch (err) {
        throw new CommandError({
          message: `Unable to read users from file at path ${fromFile}: ${err.message}`,
          detail: {
            args,
            opts,
          },
        })
      }
    } else if (args.users) {
      users = args.users.reduce((acc, keyValPair) => {
        try {
          const user = dotenv.parse(keyValPair)
          Object.assign(acc, user)
          return acc
        } catch (err) {
          throw new CommandError({
            message: `Unable to read user from argument ${keyValPair}: ${err.message}`,
            detail: {
              args,
              opts,
            },
          })
        }
      }, {})
    } else {
      throw new CommandError({
        message: dedent`
        No users provided. Either provide users directly to the command or via the --from-file flag.
      `,
        detail: { args, opts },
      })
    }

    const api = garden.cloudApi
    if (!api) {
      throw new ConfigurationError({ message: noApiMsg("create", "users"), detail: {} })
    }

    const cmdLog = log.createLog({ name: "users-command" })
    cmdLog.info("Creating users...")

    const usersToCreate = Object.entries(users).map(([vcsUsername, name]) => ({
      name,
      vcsUsername,
      serviceAccount: false,
    }))
    const batches = chunk(usersToCreate, MAX_USERS_PER_REQUEST)
    // This pretty arbitrary, but the bulk action can create 100 users at a time
    // so the queue shouldn't ever get very long.
    const concurrency = 2
    const nAsyncBatches = Math.ceil(batches.length / concurrency)
    let currentAsyncBatch = 0
    let count = 1

    const errors: ApiCommandError[] = []
    const results: UserResult[] = []
    await Bluebird.map(
      batches,
      async (userBatch) => {
        const asyncBatch = Math.ceil(count / nAsyncBatches)
        if (asyncBatch > currentAsyncBatch) {
          currentAsyncBatch = asyncBatch
          cmdLog.info({ msg: `Creating users... → Batch ${currentAsyncBatch}/${nAsyncBatches}` })
        }
        count++
        try {
          const body: CreateUserBulkRequest = {
            users: userBatch,
            addToGroups,
          }
          const res = await api.post<CreateUserBulkResponse>(`/users/bulk`, { body })
          const successes = res.data.filter((d) => d.statusCode === 200).map((d) => d.user) as UserResultApi[]
          results.push(...successes.map((s) => makeUserFromResponse(s)))

          const failures = res.data
            .filter((d) => d.statusCode !== 200)
            .map((d) => ({
              message: d.message,
              identifier: d.user.vcsUsername || "",
            }))
          errors.push(...failures)
        } catch (err) {
          errors.push({
            identifier: "",
            message: err?.response?.body?.message || err.messsage,
          })
        }
      },
      { concurrency }
    )

    return handleBulkOperationResult({
      log,
      cmdLog,
      errors,
      action: "create",
      resource: "user",
      results,
    })
  }
}
