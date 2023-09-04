/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Joi from "@hapi/joi"
import { ConfigurationError, LocalConfigError } from "../exceptions"
import chalk from "chalk"
import { relative } from "path"
import { uuidv4 } from "../util/random"
import { metadataFromDescription } from "./common"
import { profile } from "../util/profiling"
import { BaseGardenResource, YamlDocumentWithSource } from "./base"
import { ParsedNode } from "yaml"
import { padEnd } from "lodash"

export const joiPathPlaceholder = uuidv4()
const joiPathPlaceholderRegex = new RegExp(joiPathPlaceholder, "g")
const errorPrefs: any = {
  wrap: {
    label: "⟿↬",
  },
}
const joiLabelPlaceholderRegex = /⟿(.+)↬/g
const joiOptions: Joi.ValidationOptions = {
  abortEarly: false,
  // Overriding some error messages to make them friendlier
  messages: {
    "any.unknown": `{{#label}} is not allowed at path ${joiPathPlaceholder}`,
    "object.missing": `object at ${joiPathPlaceholder} must contain at least one of {{#peersWithLabels}}`,
    "object.nand": `{{#mainWithLabel}} can\'t be specified simultaneously with {{#peersWithLabels}}`,
    "object.unknown": `key "{{#child}}" is not allowed at path ${joiPathPlaceholder}`,
    "object.with": `"{{#mainWithLabel}}" must be specified with "{{#peerWithLabel}}"`,
    "object.without": `"{{#mainWithLabel}}" can\'t be specified with "{{#peerWithLabel}}"`,
    "object.xor": `object at ${joiPathPlaceholder} can only contain one of {{#peersWithLabels}}`,
  },
  errors: errorPrefs,
}

export interface ConfigSource {
  yamlDoc?: YamlDocumentWithSource
  basePath?: (string | number)[]
}

export interface ValidateOptions {
  context?: string // Descriptive text to include in validation error messages, e.g. "module at some/local/path"
  ErrorClass?: typeof ConfigurationError | typeof LocalConfigError
  source?: ConfigSource
}

export interface ValidateWithPathParams<T> {
  config: T
  schema: Joi.Schema
  path: string // Absolute path to the config file, including filename
  projectRoot: string
  name?: string // Name of the top-level entity that the config belongs to, e.g. "some-module" or "some-project"
  configType: string // The type of top-level entity that the config belongs to, e.g. "module" or "project"
  source: ConfigSource | undefined
  ErrorClass?: typeof ConfigurationError | typeof LocalConfigError
}

/**
 * Should be used whenever a path to the corresponding config file is available while validating config
 * files.
 *
 * This is to ensure consistent error messages that include the relative path to the failing file.
 */
export const validateWithPath = profile(function $validateWithPath<T>({
  config,
  schema,
  path,
  projectRoot,
  name,
  configType,
  ErrorClass,
  source,
}: ValidateWithPathParams<T>) {
  const context =
    `${configType} ${name ? `'${name}' ` : ""}` +
    `${path && projectRoot !== path ? "(" + relative(projectRoot, path) + ")" : ""}`

  const validateOpts = {
    context: context.trim(),
    source,
  }

  if (ErrorClass) {
    validateOpts["ErrorClass"] = ErrorClass
  }

  return <T>validateSchema(config, schema, validateOpts)
})

export interface ValidateConfigParams<T extends BaseGardenResource> {
  config: T
  schema: Joi.Schema
  projectRoot: string
  yamlDocBasePath: (string | number)[]
  ErrorClass?: typeof ConfigurationError | typeof LocalConfigError
}

export function validateConfig<T extends BaseGardenResource>(params: ValidateConfigParams<T>): T {
  const { config, schema, projectRoot, ErrorClass, yamlDocBasePath } = params

  const { name, kind } = config
  const path = config.internal.configFilePath || config.internal.basePath

  const context =
    `${kind} ${name ? `'${name}' ` : ""}` +
    `${path && projectRoot !== path ? "(" + relative(projectRoot, path) + ")" : ""}`

  return <T>validateSchema(config, schema, {
    context: context.trim(),
    source: config.internal.yamlDoc ? { yamlDoc: config.internal.yamlDoc, basePath: yamlDocBasePath } : undefined,
    ErrorClass,
  })
}

export const validateSchema = profile(function $validateSchema<T>(
  value: T,
  schema: Joi.Schema,
  { source, context = "", ErrorClass = ConfigurationError }: ValidateOptions = {}
): T {
  const result = schema.validate(value, joiOptions)
  const error = result.error

  if (!error) {
    return result.value
  }

  const description = schema.describe()

  const yamlDoc = source?.yamlDoc
  const rawYaml = yamlDoc?.source
  const yamlBasePath = source?.basePath || []

  const errorDetails = error.details.map((e) => {
    // render the key path in a much nicer way
    let renderedPath = yamlBasePath.join(".")

    if (e.path.length) {
      let d = description

      for (const part of e.path) {
        if (d.keys && d.keys[part]) {
          renderedPath = renderedPath ? renderedPath + "." + part : part.toString()
          d = d.keys[part]
        } else if (d.patterns) {
          for (const p of d.patterns) {
            if (part.toString().match(new RegExp(p.regex.slice(1, -1)))) {
              renderedPath += `[${part}]`
              d = p.rule
              break
            }
          }
        } else {
          renderedPath += `[${part}]`
        }
      }
    }

    // a little hack to always use full key paths instead of just the label
    e.message = e.message.replace(joiLabelPlaceholderRegex, renderedPath ? chalk.bold.underline(renderedPath) : "value")
    e.message = e.message.replace(joiPathPlaceholderRegex, chalk.bold.underline(renderedPath || "."))
    // FIXME: remove once we've customized the error output from AJV in customObject.jsonSchema()
    e.message = e.message.replace(/should NOT have/g, "should not have")

    const node = yamlDoc?.getIn([...yamlBasePath, ...e.path], true) as ParsedNode | undefined
    const range = node?.range

    if (rawYaml && yamlDoc?.contents && range) {
      // Get one line before the error location start, and the line including the error location end
      const toStart = rawYaml.slice(0, range[0])
      let lineNumber = toStart.split("\n").length + 1
      let snippetLines = 1

      const errorLineStart = toStart.lastIndexOf("\n") + 1

      let snippetStart = errorLineStart
      if (snippetStart > 0) {
        snippetStart = rawYaml.slice(0, snippetStart - 1).lastIndexOf("\n") + 1
      }
      if (snippetStart === 0) {
        snippetStart = errorLineStart
      } else {
        snippetLines++
      }

      const snippetEnd = rawYaml.indexOf("\n", range[1] - 1) || rawYaml.length

      const linePrefixLength = lineNumber.toString().length + 2
      let snippet = rawYaml
        .slice(snippetStart, snippetEnd)
        .trimEnd()
        .split("\n")
        .map(
          (l, i) => chalk.gray(padEnd("" + (lineNumber - snippetLines + i), linePrefixLength) + "| ") + chalk.cyan(l)
        )
        .join("\n")

      if (snippetStart > 0) {
        snippet = chalk.gray("...\n") + snippet
      }

      const errorLineOffset = range[0] - errorLineStart + linePrefixLength + 2
      const marker = chalk.red("-".repeat(errorLineOffset)) + chalk.red.bold("^")

      e.message = `\n${snippet}\n${marker}\n${chalk.red.bold(e.message)}`
    }

    return e
  })

  const msgPrefix = context ? `Error validating ${context}` : "Validation error"
  let errorDescription = errorDetails.map((e) => e.message).join("\n")

  const schemaDescription = schema.describe()
  const schemaMetadata = metadataFromDescription(schemaDescription)

  if (schemaDescription.keys && errorDescription.includes("is not allowed at path")) {
    // Not the case e.g. for array schemas
    errorDescription += `. Available keys: ${Object.keys(schema.describe().keys).join(", ")})`
  }

  throw new ErrorClass({
    message: `${msgPrefix}:\n${errorDescription}`,
    detail: {
      value,
      context,
      schemaMetadata,
      errorDescription,
      errorDetails,
    },
  })
})

export interface ArtifactSpec {
  source: string
  target: string
}
