/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { resolve, relative } from "path"
import chalk from "chalk"
import slash from "slash"
import { ExecaReturnValue } from "execa"
import { createGardenPlugin } from "@garden-io/sdk"
import { PluginContext, Log } from "@garden-io/sdk/types"
import { dedent, naturalList } from "@garden-io/sdk/util/string"
import { matchGlobs, listDirectory } from "@garden-io/sdk/util/fs"

// TODO: gradually get rid of these core dependencies, move some to SDK etc.
import { providerConfigBaseSchema, GenericProviderConfig, Provider } from "@garden-io/core/build/src/config/provider"
import { joi, joiIdentifier, joiSparseArray } from "@garden-io/core/build/src/config/common"
import { baseBuildSpecSchema } from "@garden-io/core/build/src/config/module"
import { PluginError, ConfigurationError } from "@garden-io/core/build/src/exceptions"
import { getGitHubUrl } from "@garden-io/core/build/src/docs/common"
import { renderTemplates } from "@garden-io/core/build/src/plugins/kubernetes/helm/common"
import { getK8sProvider } from "@garden-io/core/build/src/plugins/kubernetes/util"
import { TestAction, TestActionConfig } from "@garden-io/core/build/src/actions/test"
import { TestActionHandlers } from "@garden-io/core/build/src/plugin/action-types"
import { uniq } from "lodash"
import { HelmDeployAction } from "@garden-io/core/build/src/plugins/kubernetes/helm/config"
import { actionRefMatches } from "@garden-io/core/build/src/actions/base"
import { Resolved } from "@garden-io/core/build/src/actions/types"
import { DEFAULT_TEST_TIMEOUT_SEC } from "@garden-io/core/build/src/constants"

export interface ConftestProviderConfig extends GenericProviderConfig {
  policyPath: string
  namespace?: string
  testFailureThreshold: "deny" | "warn" | "none"
}

export interface ConftestProvider extends Provider<ConftestProviderConfig> {}

export const configSchema = () =>
  providerConfigBaseSchema()
    .keys({
      policyPath: joi
        .posixPath()
        .relativeOnly()
        .subPathOnly()
        .default("./policy")
        .description("Path to the default policy directory or rego file to use for `conftest` actions."),
      namespace: joi.string().description("Default policy namespace to use for `conftest` actions."),
      testFailureThreshold: joi
        .string()
        .allow("deny", "warn", "none")
        .default("error")
        .description(
          dedent`
          Set this to \`"warn"\` if you'd like tests to be marked as failed if one or more _warn_ rules are matched.
          Set to \`"none"\` to always mark the tests as successful.
        `
        ),
    })
    .unknown(false)

interface ConftestTestSpec {
  policyPath: string
  namespace: string
  files: string[]
  combine?: boolean
}

interface ConftestHelmTestSpec extends ConftestTestSpec {
  helmDeploy: string
}

type ConftestTestConfig = TestActionConfig<"conftest", ConftestTestSpec>
type ConftestHelmTestConfig = TestActionConfig<"conftest", ConftestHelmTestSpec>

const gitHubUrl = getGitHubUrl("examples/conftest")

const commonSchemaKeys = () => ({
  policyPath: joi
    .posixPath()
    .relativeOnly()
    .description(
      dedent`
        POSIX-style path to a directory containing the policies to match the config against, or a
        specific .rego file, relative to the action root.
        Must be a relative path, and should in most cases be within the project root.
        Defaults to the \`policyPath\` set in the provider config.
      `
    ),
  namespace: joi.string().default("main").description("The policy namespace in which to find _deny_ and _warn_ rules."),
  combine: joi.boolean().default(false).description("Set to true to use the conftest --combine flag"),
})

const testActionSchema = () =>
  joi.object().keys({
    ...commonSchemaKeys(),
    build: joiIdentifier().description("Specify a build whose files we want to test."),
    files: joi
      .array()
      .items(joi.posixPath().subPathOnly().relativeOnly().allowGlobs())
      .required()
      .description(
        dedent`
      A list of files to test with the given policy. Must be POSIX-style paths, and may include wildcards.
    `
      ),
  })

const commonModuleSchema = () =>
  joi.object().keys({
    build: baseBuildSpecSchema(),
    sourceModule: joiIdentifier().description("Specify a module whose sources we want to test."),
    ...commonSchemaKeys(),
  })

export const gardenPlugin = () =>
  createGardenPlugin({
    name: "conftest",
    docs: dedent`
    This provider allows you to validate your configuration files against policies that you specify, using the [conftest tool](https://github.com/instrumenta/conftest) and Open Policy Agent rego query files. The provider creates Test action types of the same name, which allow you to specify files to validate.

    Note that, in many cases, you'll actually want to use more specific providers that can automatically configure your \`conftest\` actions, e.g. the [\`conftest-container\`](./conftest-container.md) and/or [\`conftest-kubernetes\`](./conftest-kubernetes.md) providers. See the [conftest example project](${gitHubUrl}) for a simple usage example of the latter.

    If those don't match your needs, you can use this provider directly and manually configure your \`conftest\` actions. Simply add this provider to your project configuration, and see the [conftest action documentation](../action-types/Test/conftest.md) for a detailed reference. Also, check out the below reference for how to configure default policies, default namespaces, and test failure thresholds for all \`conftest\` actions.
  `,
    dependencies: [],
    configSchema: configSchema(),

    createActionTypes: {
      Test: [
        {
          name: "conftest",
          docs: dedent`
          Creates a test that runs \`conftest\` on the specified files, with the specified (or default) policy and namespace.

          > Note: In many cases, you'll let specific conftest providers (e.g. [\`conftest-container\`](../../providers/conftest-container.md) and [\`conftest-kubernetes\`](../../providers/conftest-kubernetes.md) create this automatically, but you may in some cases want or need to manually specify files to test.

          See the [conftest docs](https://github.com/instrumenta/conftest) for details on how to configure policies.
          `,
          schema: testActionSchema(),
          handlers: <TestActionHandlers<TestAction<ConftestTestConfig>>>{
            run: async ({ ctx, action, log }) => {
              const startedAt = new Date()
              const provider = ctx.provider as ConftestProvider

              const spec = action.getSpec()

              const buildPath = action.getBuildPath()
              const buildPathFiles = await listDirectory(buildPath)

              // TODO: throw if a specific file is listed under `spec.files` but isn't found?
              const files = matchGlobs(buildPathFiles, spec.files)

              if (files.length === 0) {
                return {
                  state: "ready",
                  detail: {
                    testName: action.name,
                    moduleName: action.moduleName(),
                    command: [],
                    version: action.versionString(),
                    success: true,
                    startedAt,
                    completedAt: new Date(),
                    log: "No files to test",
                  },
                  outputs: {},
                }
              }

              const args = prepareArgs(ctx, provider, action.basePath(), spec)
              args.push(...files)

              const result = await ctx.tools["conftest.conftest"].exec({ log, args, ignoreError: true, cwd: buildPath })

              const { success, formattedResult } = parseConftestResult(provider, log, result)

              return {
                state: success ? "ready" : "not-ready",
                detail: {
                  testName: action.name,
                  moduleName: action.moduleName(),
                  command: ["conftest", ...args],
                  version: action.versionString(),
                  success,
                  startedAt,
                  completedAt: new Date(),
                  log: formattedResult,
                },
                outputs: {},
              }
            },
          },
        },
        // TODO-G2: move to conftest-kubernetes
        {
          name: "conftest-helm",
          base: "conftest",
          docs: dedent`
          Special Test type for validating helm deploys with conftest. This is necessary in addition to the \`conftest\` Test type in order to be able to properly render the Helm chart ahead of validation, including all runtime values.

          If the helm Deploy requires runtime outputs from other actions, you must list the corresponding dependencies with the \`dependencies\` field.

          > Note: In most cases, you'll let the [\`conftest-kubernetes\`](../../providers/conftest-kubernetes.md) provider create this Test automatically, but you may in some cases want or need to manually specify files to test.

          See the [conftest docs](https://github.com/instrumenta/conftest) for details on how to configure policies.
          `,
          schema: testActionSchema().keys({
            helmDeploy: joi
              .actionReference()
              .kind("Deploy")
              .name("helm")
              .required()
              .description("The Helm Deploy action to validate."),
          }),
          handlers: <TestActionHandlers<TestAction<ConftestHelmTestConfig>>>{
            configure: async ({ ctx, config }) => {
              let files = config.spec.files || []

              if (files.length > 0) {
                if (!config.include) {
                  config.include = []
                }

                try {
                  files = ctx.resolveTemplateStrings(files)
                } catch (error) {
                  throw new ConfigurationError({
                    message: `The spec.files field contains a template string which could not be resolved. Note that some template variables are not available for the field. Error: ${error}`,
                    detail: { config, error },
                  })
                }
                config.include = uniq([...config.include, ...files])
              }

              return { config, supportedModes: {} }
            },

            run: async ({ ctx, log, action }) => {
              const startedAt = new Date()
              const provider = ctx.provider as ConftestProvider
              const spec = action.getSpec()

              // Render the Helm chart
              // TODO: find a way to avoid these direct code dependencies
              const k8sProvider = getK8sProvider(ctx.provider.dependencies)
              const k8sCtx = { ...ctx, provider: k8sProvider }

              const sourceAction = <Resolved<HelmDeployAction> | null>(
                (action
                  .getResolvedDependencies()
                  .find((d) => actionRefMatches(d, { kind: "Deploy", name: spec.helmDeploy })) || null)
              )

              if (!sourceAction) {
                throw new ConfigurationError({
                  message: `Must specify a helm Deploy action in the \`helmDeploy\` field. Could not find Deploy action '${spec.helmDeploy}'.`,
                  detail: {
                    helmDeployRef: spec.helmDeploy,
                  },
                })
              }
              if (sourceAction.type !== "helm") {
                throw new ConfigurationError({
                  message: `Must specify a helm Deploy action in the \`helmDeploy\` field. Deploy action '${spec.helmDeploy}' has type '${sourceAction.type}'.`,
                  detail: {
                    helmDeployRef: spec.helmDeploy,
                    foundDeployType: sourceAction.type,
                  },
                })
              }

              const templates = await renderTemplates({
                ctx: k8sCtx,
                action: sourceAction,

                log,
              })

              // Run conftest, piping the rendered chart to stdin
              const args = prepareArgs(ctx, provider, action.basePath(), spec)
              args.push("-")

              const result = await ctx.tools["conftest.conftest"].exec({
                log,
                args,
                ignoreError: true,
                cwd: sourceAction.getBuildPath(),
                input: templates,
              })

              // Parse and return the results
              const { success, formattedResult } = parseConftestResult(provider, log, result)

              return {
                state: success ? "ready" : "not-ready",
                detail: {
                  testName: action.name,
                  moduleName: action.moduleName(),
                  command: ["conftest", ...args],
                  version: action.versionString(),
                  success,
                  startedAt,
                  completedAt: new Date(),
                  log: formattedResult,
                },
                outputs: {},
              }
            },
          },
        },
      ],
    },

    createModuleTypes: [
      {
        name: "conftest",
        docs: dedent`
        Creates a test that runs \`conftest\` on the specified files, with the specified (or default) policy and
        namespace.

        > Note: In many cases, you'll let specific conftest providers (e.g. [\`conftest-container\`](../providers/conftest-container.md) and [\`conftest-kubernetes\`](../providers/conftest-kubernetes.md) create this action type automatically, but you may in some cases want or need to manually specify files to test.

        See the [conftest docs](https://github.com/instrumenta/conftest) for details on how to configure policies.
      `,
        schema: commonModuleSchema(),
        needsBuild: false,
        handlers: {
          configure: async ({ moduleConfig }) => {
            if (moduleConfig.spec.sourceModule) {
              // TODO-G2: change this to validation instead, require explicit dependency
              moduleConfig.build.dependencies.push({ name: moduleConfig.spec.sourceModule, copy: [] })
            }

            moduleConfig.include = moduleConfig.spec.files
            moduleConfig.testConfigs = [{ name: "test", dependencies: [], spec: {}, disabled: false, timeout: 10 }]
            return { moduleConfig }
          },

          convert: async (params) => {
            const { module, dummyBuild, convertBuildDependency } = params

            return {
              actions: [
                ...(dummyBuild ? [dummyBuild] : []),
                {
                  kind: "Test",
                  type: "conftest",
                  name: module.name + "-conftest",
                  ...params.baseFields,

                  build: module.spec.sourceModule ? convertBuildDependency(module.spec.sourceModule).name : undefined,
                  timeout: 10,
                  include: module.spec.files,

                  spec: {
                    ...module.spec,
                  },
                },
              ],
            }
          },
        },
      },
      {
        name: "conftest-helm",
        docs: dedent`
        Special module type for validating helm modules with conftest. This is necessary in addition to the \`conftest\` module type in order to be able to properly render the Helm chart ahead of validation, including all runtime values.

        If the helm module requires runtime outputs from other actions, you must list the corresponding dependencies with the \`runtimeDependencies\` field.

        > Note: In most cases, you'll let the [\`conftest-kubernetes\`](../providers/conftest-kubernetes.md) provider create this action type automatically, but you may in some cases want or need to manually specify files to test.

        See the [conftest docs](https://github.com/instrumenta/conftest) for details on how to configure policies.
      `,
        schema: commonModuleSchema().keys({
          sourceModule: joiIdentifier().required().description("Specify a helm module whose chart we want to test."),
          runtimeDependencies: joiSparseArray(joiIdentifier()).description(
            "A list of runtime dependencies that need to be resolved before rendering the Helm chart."
          ),
        }),
        needsBuild: false,
        handlers: {
          configure: async ({ moduleConfig }) => {
            // TODO-G2: change this to validation instead, require explicit dependency
            moduleConfig.build.dependencies.push({ name: moduleConfig.spec.sourceModule, copy: [] })
            moduleConfig.include = []
            moduleConfig.testConfigs = [
              {
                name: "test",
                dependencies: moduleConfig.spec.runtimeDependencies,
                spec: {},
                disabled: false,
                timeout: DEFAULT_TEST_TIMEOUT_SEC,
              },
            ]
            return { moduleConfig }
          },
        },
      },
    ],
    tools: [
      {
        name: "conftest",
        version: "0.17.1",
        description: "A rego-based configuration validator.",
        type: "binary",
        _includeInGardenImage: true,
        builds: [
          // this version has no arm support yet. If you add a later release, please add the "arm64" architecture.
          {
            platform: "darwin",
            architecture: "amd64",
            url: "https://github.com/open-policy-agent/conftest/releases/download/v0.17.1/conftest_0.17.1_Darwin_x86_64.tar.gz",
            sha256: "1c97f0e43fab99c94593696d362fc1e00e8e80bd0321729412de51d83ecbfb73",
            extract: {
              format: "tar",
              targetPath: "conftest",
            },
          },
          // this version has no arm support yet. If you add a later release, please add the "arm64" architecture.
          {
            platform: "linux",
            architecture: "amd64",
            url: "https://github.com/open-policy-agent/conftest/releases/download/v0.17.1/conftest_0.17.1_Linux_x86_64.tar.gz",
            sha256: "d18c95a4b04e87bfd59e06cc980801d2df5dabb371b495506ef03f70a0a40624",
            extract: {
              format: "tar",
              targetPath: "conftest",
            },
          },
          {
            platform: "windows",
            architecture: "amd64",
            url:
              "https://github.com/open-policy-agent/conftest/releases/download/v0.17.1/" +
              "conftest_0.17.1_Windows_x86_64.zip",
            sha256: "4c2df80420f2f148ec085bb75a8c5b92e1c665c6a041768a79924c81082527c3",
            extract: {
              format: "zip",
              targetPath: "conftest.exe",
            },
          },
        ],
      },
    ],
  })

function prepareArgs(ctx: PluginContext, provider: ConftestProvider, path: string, spec: ConftestTestSpec) {
  const defaultPolicyPath = relative(path, resolve(ctx.projectRoot, provider.config.policyPath))
  // Make sure the policy path is valid POSIX on Windows
  const policyPath = slash(resolve(path, spec.policyPath || defaultPolicyPath))
  const namespace = spec.namespace || provider.config.namespace

  const args = ["test", "--policy", policyPath, "--output", "json"]
  if (namespace) {
    args.push("--namespace", namespace)
  }
  if (spec.combine) {
    args.push("--combine")
  }
  return args
}

function parseConftestResult(provider: ConftestProvider, log: Log, result: ExecaReturnValue) {
  let success = true
  let parsed: any = []

  try {
    parsed = JSON.parse(result.stdout)
  } catch (err) {
    throw new PluginError({ message: `Error running conftest: ${result.all}`, detail: { result } })
  }

  const allFailures = parsed.filter((p: any) => p.failures?.length > 0)
  const allWarnings = parsed.filter((p: any) => p.warnings?.length > 0)

  const resultCategories: string[] = []
  let formattedResult = "OK"

  if (allFailures.length > 0) {
    resultCategories.push(`${allFailures.length} failure(s)`)
  }

  if (allWarnings.length > 0) {
    resultCategories.push(`${allWarnings.length} warning(s)`)
  }

  let formattedHeader = `conftest reported ${naturalList(resultCategories)}`

  if (allFailures.length > 0 || allWarnings.length > 0) {
    const lines = [`${formattedHeader}:\n`]

    // We let the format match the conftest output
    for (const { filename, warnings, failures } of parsed) {
      for (const failure of failures) {
        lines.push(
          chalk.redBright.bold("FAIL") + chalk.gray(" - ") + chalk.redBright(filename) + chalk.gray(" - ") + failure.msg
        )
      }
      for (const warning of warnings) {
        lines.push(
          chalk.yellowBright.bold("WARN") +
            chalk.gray(" - ") +
            chalk.yellowBright(filename) +
            chalk.gray(" - ") +
            warning.msg
        )
      }
    }

    formattedResult = lines.join("\n")
  }

  const threshold = provider.config.testFailureThreshold

  if (allWarnings.length > 0 && threshold === "warn") {
    success = false
  } else if (allFailures.length > 0 && threshold !== "none") {
    success = false
  } else if (allWarnings.length > 0) {
    log.warn(chalk.yellow(formattedHeader))
  }

  return { success, formattedResult }
}
