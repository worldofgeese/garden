/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { performance } from "perf_hooks"
import { sum, sortBy } from "lodash"
import { gardenEnv } from "../constants"
import { renderTable, tablePresets } from "./string"
import chalk from "chalk"
import { isPromise } from "./objects"

const skipProfiling = process.env.GARDEN_SKIP_TEST_PROFILING

const maxReportRows = 60

// Just storing the invocation duration for now
type Invocation = number

interface Profiles {
  [key: string]: Invocation[]
}

export class Profiler {
  private data: Profiles

  constructor(private enabled = true) {
    this.data = {}
  }

  isEnabled() {
    return this.enabled
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled
  }

  getData() {
    return this.data
  }

  report() {
    if (skipProfiling) {
      return
    }

    function formatKey(key: string) {
      const split = key.split("#")

      if (split.length === 1) {
        return chalk.greenBright(key)
      } else {
        return chalk.cyan(split[0]) + "#" + chalk.greenBright(split[1])
      }
    }

    function formatDuration(duration: number) {
      return duration.toFixed(2) + chalk.gray(" ms")
    }

    const keys = Object.keys(this.data)

    const heading = ["Function/method", "# Invocations", "Total ms", "Avg. ms", "First ms"].map((h) =>
      chalk.white.underline(h)
    )
    const tableData = sortBy(
      keys.map((key) => {
        const invocations = this.data[key].length
        const total = sum(this.data[key])
        const average = total / invocations
        const first = this.data[key][0]
        return [formatKey(key), invocations, total, average, first]
      }),
      // Sort by total duration
      (row) => -row[2]
    )
      .map((row) => [
        row[0],
        row[1],
        formatDuration(<number>row[2]),
        formatDuration(<number>row[3]),
        formatDuration(<number>row[4]),
      ])
      .slice(0, maxReportRows)

    const totalRows = keys.length

    if (totalRows > maxReportRows) {
      tableData.push([chalk.gray("...")])
    }

    const table = renderTable([heading, [], ...tableData], tablePresets["no-borders"])

    return `
 ${chalk.white.bold("Profiling data:")}
 ─────────────────────────────────────────────────────────────────────────────────────────
${table}
 ─────────────────────────────────────────────────────────────────────────────────────────
    `
  }

  reset() {
    this.data = {}
  }

  log(key: string, start: number) {
    if (!this.enabled) {
      return
    }

    const duration = performance.now() - start
    if (this.data[key]) {
      this.data[key].push(duration)
    } else {
      this.data[key] = [duration]
    }
  }
}

const defaultProfiler = new Profiler(gardenEnv.GARDEN_ENABLE_PROFILING)

export function getDefaultProfiler() {
  return defaultProfiler
}

/**
 * Class decorator that collects profiling data on every method invocation (if GARDEN_ENABLE_PROFILING is true).
 */
export function Profile(profiler?: Profiler) {
  if (!profiler) {
    profiler = getDefaultProfiler()
  }

  return function (target: Function) {
    if (!profiler!.isEnabled()) {
      return
    }

    for (const propertyName of Object.getOwnPropertyNames(target.prototype)) {
      const propertyValue = target.prototype[propertyName]
      const isMethod = propertyValue instanceof Function
      if (!isMethod) {
        continue
      }

      const descriptor = Object.getOwnPropertyDescriptor(target.prototype, propertyName)!
      const originalMethod = descriptor.get || descriptor.value

      const timingKey = `${target.name}#${propertyName}`

      const wrapped = function (this: any, ...args: any[]) {
        const start = performance.now()
        // eslint-disable-next-line no-invalid-this
        const result = originalMethod.apply(this, args)

        if (!profiler!.isEnabled()) {
          return result
        } else if (isPromise(result)) {
          return result
            .catch((err: Error) => {
              profiler!.log(timingKey, start)
              throw err
            })
            .then((v) => {
              profiler!.log(timingKey, start)
              return v
            })
        } else {
          profiler!.log(timingKey, start)
          return result
        }
      }

      if (descriptor.get) {
        descriptor.get = wrapped
      } else {
        descriptor.value = wrapped
      }

      Object.defineProperty(target.prototype, propertyName, descriptor)
    }
  }
}

/**
 * Function decorator that collects profiling data on every function invocation (if GARDEN_ENABLE_PROFILING is true).
 */
export const profile = <T extends Array<any>, U>(fn: (...args: T) => U, profiler?: Profiler) => {
  if (!profiler) {
    profiler = getDefaultProfiler()
  }

  if (!profiler!.isEnabled()) {
    return fn
  }

  const timingKey = fn.name

  return (...args: T): U => {
    const result = fn(...args)
    const start = performance.now()

    if (!profiler!.isEnabled()) {
      return result
    } else {
      profiler!.log(timingKey, start)
      return result
    }
  }
}

/**
 * Async function decorator that collects profiling data on every function invocation (if GARDEN_ENABLE_PROFILING is
 * true).
 */
export const profileAsync = <T extends Array<any>, U>(fn: (...args: T) => Promise<U>, profiler?: Profiler) => {
  if (!profiler) {
    profiler = getDefaultProfiler()
  }

  if (!profiler!.isEnabled()) {
    return fn
  }

  const timingKey = fn.name

  return async (...args: T): Promise<U> => {
    const start = performance.now()

    if (!profiler!.isEnabled()) {
      return fn(...args)
    } else {
      return fn(...args)
        .catch((err: Error) => {
          profiler!.log(timingKey, start)
          throw err
        })
        .then((v) => {
          profiler!.log(timingKey, start)
          return v
        })
    }
  }
}
