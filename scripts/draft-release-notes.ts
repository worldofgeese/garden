#!/usr/bin/env ts-node

import { writeFile } from "fs-extra"
import { execSync } from "child_process"
import { resolve } from "path"
import { dedent } from "@garden-io/sdk/util/string"
import { getChangelog } from "./changelog"
import parseArgs = require("minimist")

const gardenRoot = resolve(__dirname, "..")

function getContributors(prevReleaseTag: string, curReleaseTag: string) {
  try {
    return execSync(
      `git log ${prevReleaseTag}..${curReleaseTag} --no-merges | grep ^Author | sort | uniq -c | sort -nr`
    ).toString()
  } catch (err) {
    throw new Error(`Error generating list of contributors: ${err}`)
  }
}

const releaseNotesDraft = (version: string, changelog: string, contributors: string): string =>
  dedent(`
# Garden ${version} is out! :tada:

[TODO: amend the release description below in necessary.]
This is a maintenance release that includes some bug fixes, features, and improvements.

[TODO: prepare the list of **external** contributors, replace the list in [[]] with the comma-separated list of @github_names.]
Many thanks to [[${contributors}]] for the contributions to this release!

## Assets

Download the Garden binary for your platform from below or simply run \`garden self-update\` if you already have it installed.

* [Garden v${version} for Alpine AMD64 (tar.gz)](https://download.garden.io/core/${version}/garden-${version}-alpine-amd64.tar.gz)
* [Garden v${version} for Linux AMD64 (tar.gz)](https://download.garden.io/core/${version}/garden-${version}-linux-amd64.tar.gz)
* [Garden v${version} for MacOS AMD64 (tar.gz)](https://download.garden.io/core/${version}/garden-${version}-macos-amd64.tar.gz)
* [Garden v${version} for Windows AMD64 (.zip)](https://download.garden.io/core/${version}/garden-${version}-windows-amd64.zip)

## Changelog
[TODO: Remember to put the list of features on top of the list of bug fixes.]
[TODO: Remove all garbage entries from the changelog below.]
${changelog}

## Fixed Issues
[TODO: compose the list of the fixed issues here.]
`)

// todo: for better automation, consider calling this from ./release.ts when RELEASE_TYPE arg is minor|patch
//       and remember to update CONTRIBUTING.md guide
async function draftReleaseNotes() {
  // Parse arguments
  const argv = parseArgs(process.argv.slice(2))
  const prevReleaseTag = argv._[0]
  const curReleaseTag = argv._[1]
  console.log(`Generating release notes draft for ${curReleaseTag}...`)

  // Generate changelog
  // todo: ensure that the list of features on top of the list of bug fixes
  console.log("Generating changelog...")
  const changelog = await getChangelog(curReleaseTag)

  console.log("Generating list of contributors...")
  const contributors = getContributors(prevReleaseTag, curReleaseTag)

  const content = releaseNotesDraft(curReleaseTag, changelog, contributors)
  const filename = `release-notes-${curReleaseTag}-draft.md`
  const outputPath = `${gardenRoot}/${filename}`

  console.log(`Writing release notes draft to ${outputPath}`)
  try {
    await writeFile(outputPath, content, { encoding: "utf-8" })
  } catch (err) {
    throw new Error(`Error writing release notes draft to path ${outputPath}: ${err}`)
  }

  console.log("Done!")
}

;(async () => {
  try {
    await draftReleaseNotes()
    process.exit(0)
  } catch (err) {
    console.log(err)
    process.exit(1)
  }
})().catch(() => {})
