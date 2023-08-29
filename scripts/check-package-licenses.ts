#!/usr/bin/env ts-node

/**
 * Scans all package.json files in the repo and throws if one or more packages have a disallowed license
 * (i.e. GPL, other copyleft licenses).
 *
 * Stores a CSV dump
 */

import { dumpLicenses } from "npm-license-crawler"
import { join, resolve } from "path"
import stripAnsi from "strip-ansi"
import chalk from "chalk"
import { promisify } from "util"
import { asTree } from "treeify"
import { stringify } from "csv-stringify/sync"
import { writeFile } from "fs-extra"

const gardenRoot = resolve(__dirname, "..")

const disallowedLicenses = [/^AGPL/, /^copyleft/, "CC-BY-NC", "CC-BY-SA", /^FAL/, /^GPL/]

interface LicenseDump {
  [name: string]: {
    licenses: string
    repository: string
    licenseUrl: string
    parents: string
  }
}

type LicenseDumpOptions = {
  start: string[]
  exclude?: string[]
  json?: string
  unknown?: boolean
}

const dumpLicensesAsync = promisify<LicenseDumpOptions, LicenseDump>(dumpLicenses)

async function checkPackageLicenses(root: string) {
  const res = await dumpLicensesAsync({ start: [root] })

  const disallowedPackages: LicenseDump = {}

  for (const [ansiName, entry] of Object.entries(res)) {
    const name = stripAnsi(ansiName)
    const licenses = entry.licenses.trimEnd().split(" OR ")

    if (licenses[0].startsWith("(")) {
      licenses[0] = licenses[0].slice(1)
    }
    if (licenses[licenses.length - 1].endsWith(")")) {
      licenses[licenses.length - 1] = licenses[licenses.length - 1].slice(0, -1)
    }

    let anyAllowed = false

    for (const license of licenses) {
      let allowed = true
      for (const d of disallowedLicenses) {
        if (license.match(d)) {
          allowed = false
          break
        }
      }
      if (allowed) {
        anyAllowed = true
        break
      }
    }

    if (!anyAllowed) {
      disallowedPackages[chalk.red.bold(name)] = { ...entry, licenses: chalk.red.bold(entry.licenses) }
    }
  }

  // Dump to CSV
  const csvPath = join(gardenRoot, "tmp", "package-licenses.csv")
  console.log("Dumping CSV to " + csvPath)
  const rows = Object.entries(res).map(([name, entry]) => ({ name: stripAnsi(name), ...entry }))
  await writeFile(csvPath, stringify(rows, { header: true }))

  // Throw on disallowed licenses
  const disallowedCount = Object.keys(disallowedPackages).length

  if (disallowedCount > 0) {
    let msg = chalk.red.bold(`\nFound ${disallowedCount} packages with disallowed licenses:\n`)
    msg += asTree(disallowedPackages, true, true)
    throw new Error(msg)
  }
}

if (require.main === module) {
  checkPackageLicenses(gardenRoot).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
