/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { isEmpty, isString } from "lodash"
import { stringify } from "yaml"
import { withoutInternalFields, sanitizeValue } from "./util/logging"
import { SpawnOpts, getGitHubIssueLink, testFlags } from "./util/util"
import dedent from "dedent"
import chalk from "chalk"
import stripAnsi from "strip-ansi"

export type StackTraceMetadata = {
  functionName: string
  relativeFileName?: string
  lineNumber?: number
}

export type GardenErrorStackTrace = {
  metadata: StackTraceMetadata[]
  wrappedMetadata?: StackTraceMetadata[][]
}

export interface GardenErrorParams<D extends object = any> {
  message: string
  readonly detail?: D
  readonly stack?: string
  readonly wrappedErrors?: GardenError[]
  readonly context?: GardenErrorContext
}

export type GardenErrorContext = {
  taskType?: string
}
export abstract class GardenError<D extends object = any | undefined> extends Error {
  abstract type: string
  public override message: string
  public detail: D
  public wrappedErrors?: GardenError<any>[]
  public context?: GardenErrorContext

  constructor({ message, detail, stack, wrappedErrors, context }: GardenErrorParams<D>) {
    super(message)
    // We sanitize the details right here to avoid issues later down the line
    this.detail = withoutInternalFields(sanitizeValue(detail))
    this.stack = stack || this.stack
    this.wrappedErrors = wrappedErrors
    this.context = context
  }

  override toString() {
    if (testFlags.expandErrors) {
      let str = super.toString()

      if (this.wrappedErrors) {
        str += "\n\nWrapped error:\n\n"

        for (const wrappedError in this.wrappedErrors) {
          str += wrappedError + "\n\n"
        }
      }

      return str
    } else {
      return super.toString()
    }
  }

  toJSON() {
    return {
      type: this.type,
      message: this.message,
      stack: this.stack,
      detail: this.detail,
      wrappedErrors: this.wrappedErrors,
    }
  }

  formatWithDetail() {
    return formatGardenErrorWithDetail(this)
  }
}

export class AuthenticationError extends GardenError {
  type = "authentication"
}

export class BuildError extends GardenError {
  type = "build"
}

export class ConfigurationError extends GardenError {
  type = "configuration"
}

export class CommandError extends GardenError {
  type = "command"
}

export class FilesystemError extends GardenError {
  type = "filesystem"
}

export class LocalConfigError extends GardenError {
  type = "local-config"
}

export class ValidationError extends GardenError {
  type = "validation"
}

export class PluginError extends GardenError {
  type = "plugin"
}

export class ParameterError extends GardenError {
  type = "parameter"
}

export class NotImplementedError extends GardenError {
  type = "not-implemented"
}

export class DeploymentError extends GardenError {
  type = "deployment"
}

export class RuntimeError extends GardenError {
  type = "runtime"
}

export class GraphError<D extends object> extends GardenError<D> {
  type = "graph"
}

export class TimeoutError extends GardenError {
  type = "timeout"
}

export class OutOfMemoryError extends GardenError {
  type = "out-of-memory"
}

export class NotFoundError extends GardenError {
  type = "not-found"
}

export class WorkflowScriptError extends GardenError {
  type = "workflow-script"
}

export class CloudApiError extends GardenError {
  type = "cloud-api"
}

export class TemplateStringError extends GardenError {
  type = "template-string"
}

interface ChildProcessErrorDetails {
  cmd: string
  args: string[]
  code: number
  output: string
  stderr: string
  stdout: string
  opts?: SpawnOpts
}
export class ChildProcessError extends GardenError<ChildProcessErrorDetails> {
  type = "childprocess"
}

interface GenericGardenErrorParams extends GardenErrorParams {
  type: string
}
export class GenericGardenError extends GardenError {
  type: string

  constructor(params: GenericGardenErrorParams) {
    super(params)
    this.type = params.type
  }
}

/**
 * Throw this error only when this error condition is definitely a Garden bug.
 *
 * Examples where throwing this error is appropriate:
 * - A Javascript TypeError has occurred, e.g. reading property on undefined.
 * - "This should not happen" kind of situations, e.g. internal data structures are in an invalid state.
 * - An unhandled exception has been thrown by a library. If you don't know what to do with this exception and it is most likely not due to user error, wrap it with "InternalError".
 *
 * In case the network is involved, we should *not* use the "InternalError", because that's usually a situation that the user needs to resolve.
 */
export class InternalError extends GardenError {
  // we want it to be obvious in amplitude data that this is not a normal error condition
  type = "crash"

  // not using object destructuring here on purpose, because errors are of type any and then the error might be passed as the params object accidentally.
  static wrapError(error: Error | string | any, detail?: unknown, prefix?: string): InternalError {
    let message: string | undefined
    let stack: string | undefined

    if (error instanceof Error) {
      message = error.message
      stack = error.stack
    } else if (isString(error)) {
      message = error
    } else if (error) {
      message = error["message"]
      stack = error["stack"]
    }

    message = message ? stripAnsi(message) : ""

    return new InternalError({ message: prefix ? `${stripAnsi(prefix)}: ${message}` : message, stack, detail })
  }
}

export function toGardenError(err: Error | GardenError | string | any): GardenError {
  if (err instanceof GardenError) {
    return err
  } else {
    return InternalError.wrapError(err)
  }
}

export function explainGardenError(rawError: GardenError | Error | string, context?: string) {
  const error = toGardenError(rawError)

  let errorMessage = error.message.trim()

  // If this is an unexpected error, we want to output more details by default and provide some guidance for the user.
  if (error instanceof InternalError) {
    let bugReportInformation = formatGardenErrorWithDetail(error)

    if (context) {
      bugReportInformation = `${stripAnsi(context)}\n${bugReportInformation}`
    }

    return chalk.red(dedent`
    ${chalk.bold("Encountered an unexpected Garden error. This is likely a bug 🍂")}

    You can help by reporting this on GitHub: ${getGitHubIssueLink(`Crash: ${errorMessage}`, "crash")}

    Please attach the following information to the bug report after making sure that the error message does not contain sensitive information:

    ${chalk.gray(bugReportInformation)}
    `)
  }

  // In case this is another Garden error, the error message is already designed to be digestable as-is for the user.
  return chalk.red(errorMessage)
}

export function formatGardenErrorWithDetail(error: GardenError) {
  const { detail, message, stack } = error

  let out = stack || message || ""

  if (!isEmpty(detail || {})) {
    try {
      const yamlDetail = stringify(detail, { blockQuote: "literal", lineWidth: 0 })
      out += `\n\nError Details:\n\n${yamlDetail}`
    } catch (err) {
      out += `\n\nUnable to render error details:\n${err.message}`
    }
  }
  return out
}

function getStackTraceFromString(stack: string): StackTraceMetadata[] {
  // Care about the first line matching our code base
  const lines = stack.split("\n").slice(1)

  return lines.flatMap((l) => {
    // match and extract any line from a stack trace with
    // function, file path, line number, column number
    // we are only interested in the first two for now
    const atLine = l.match(/at (?:(.+?)\s+\()?(?:(.+?):(\d+)(?::(\d+))?|([^)]+))\)?/)

    // ignore this if there is no regex match
    if (!atLine) {
      return []
    }

    const functionName: string = atLine[1] || "<unknown>"
    const filePath = atLine[2] || ""
    let lastFilePos = -1
    let tmpPos = -1

    // Get the slice offset assuming the file path contains a known
    // path component in the source file path.
    if ((tmpPos = filePath.lastIndexOf("src")) > -1) {
      lastFilePos = tmpPos + 4
    } else if ((tmpPos = filePath.lastIndexOf("node_modules")) > -1) {
      lastFilePos = tmpPos + 13
    } else if ((tmpPos = filePath.lastIndexOf("node:internal")) > -1) {
      lastFilePos = tmpPos + 14
    }

    let relativeFileName: string | undefined = undefined

    if (lastFilePos > -1) {
      relativeFileName = filePath.slice(lastFilePos)
    }

    let lineNumber = parseInt(atLine[3], 10) || -1

    return [
      {
        functionName,
        relativeFileName,
        lineNumber,
      },
    ]
  })
}

export function getStackTraceMetadata(error: GardenError): GardenErrorStackTrace {
  if (!error.stack && !error.wrappedErrors) {
    return { metadata: [], wrappedMetadata: undefined }
  }

  const errorMetadata: StackTraceMetadata[] = error.stack ? getStackTraceFromString(error.stack) : []

  const wrappedMetadata: StackTraceMetadata[][] | undefined = error.wrappedErrors?.map((wrappedError) => {
    if (!wrappedError.stack) {
      return []
    }

    return getStackTraceFromString(wrappedError.stack)
  })

  return {
    metadata: errorMetadata,
    wrappedMetadata,
  }
}
