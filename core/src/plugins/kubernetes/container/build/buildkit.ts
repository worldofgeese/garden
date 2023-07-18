/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import AsyncLock from "async-lock"
import chalk from "chalk"
import split2 = require("split2")
import { isEmpty } from "lodash"
import {
  buildSyncVolumeName,
  buildkitContainerName,
  buildkitDeploymentName,
  buildkitImageName,
  buildkitRootlessImageName,
  dockerAuthSecretKey,
} from "../../constants"
import { KubeApi } from "../../api"
import { KubernetesDeployment } from "../../types"
import { Log } from "../../../../logger/log-entry"
import { waitForResources, compareDeployedResources } from "../../status/status"
import { KubernetesProvider, KubernetesPluginContext, ClusterBuildkitCacheConfig } from "../../config"
import { PluginContext } from "../../../../plugin-context"
import {
  BuildStatusHandler,
  skopeoBuildStatus,
  BuildHandler,
  syncToBuildSync,
  getUtilContainer,
  ensureBuilderSecret,
  builderToleration,
} from "./common"
import { getNamespaceStatus } from "../../namespace"
import { sleep } from "../../../../util/util"
import { ContainerBuildAction, ContainerModuleOutputs } from "../../../container/moduleConfig"
import { getDockerBuildArgs } from "../../../container/build"
import { Resolved } from "../../../../actions/types"
import { PodRunner } from "../../run"
import { prepareSecrets } from "../../secrets"
import { getRunningDeploymentPod } from "../../util"
import { defaultDockerfileName } from "../../../container/config"
import { k8sGetContainerBuildActionOutputs } from "../handlers"
import { stringifyResources } from "../util"

const deployLock = new AsyncLock()

export const getBuildkitBuildStatus: BuildStatusHandler = async (params) => {
  const { ctx, action, log } = params
  const k8sCtx = ctx as KubernetesPluginContext
  const provider = k8sCtx.provider

  const api = await KubeApi.factory(log, ctx, provider)
  const namespace = (await getNamespaceStatus({ log, ctx: k8sCtx, provider })).namespaceName

  const { authSecret } = await ensureBuildkit({
    ctx,
    provider,
    log,
    api,
    namespace,
  })

  return skopeoBuildStatus({
    namespace,
    deploymentName: buildkitDeploymentName,
    containerName: getUtilContainer(authSecret.metadata.name, provider).name,
    log,
    api,
    ctx,
    provider,
    action,
  })
}

export const buildkitBuildHandler: BuildHandler = async (params) => {
  const { ctx, action, log } = params
  const spec = action.getSpec()
  const k8sCtx = ctx as KubernetesPluginContext

  const provider = <KubernetesProvider>ctx.provider
  const api = await KubeApi.factory(log, ctx, provider)
  const namespace = (await getNamespaceStatus({ log, ctx: k8sCtx, provider })).namespaceName

  await ensureBuildkit({
    ctx,
    provider,
    log,
    api,
    namespace,
  })

  const outputs = k8sGetContainerBuildActionOutputs({ provider, action })

  const localId = outputs.localImageId
  const dockerfile = spec.dockerfile || defaultDockerfileName

  const { contextPath } = await syncToBuildSync({
    ...params,
    ctx: k8sCtx,
    api,
    namespace,
    deploymentName: buildkitDeploymentName,
  })

  log.info(`Buildkit Building image ${localId}...`)

  const logEventContext = {
    origin: "buildkit",
    level: "verbose" as const,
  }

  const outputStream = split2()
  outputStream.on("error", () => {})
  outputStream.on("data", (line: Buffer) => {
    ctx.events.emit("log", { timestamp: new Date().toISOString(), msg: line.toString(), ...logEventContext })
  })

  const command = [
    "buildctl",
    "build",
    "--frontend=dockerfile.v0",
    "--local",
    "context=" + contextPath,
    "--local",
    "dockerfile=" + contextPath,
    "--opt",
    "filename=" + dockerfile,
    ...getBuildkitImageFlags(
      provider.config.clusterBuildkit!.cache,
      outputs,
      provider.config.deploymentRegistry!.insecure
    ),
    ...getBuildkitFlags(action),
  ]

  // Execute the build
  const buildTimeout = action.getConfig("timeout")

  const pod = await getRunningDeploymentPod({ api, deploymentName: buildkitDeploymentName, namespace })

  const runner = new PodRunner({
    api,
    ctx,
    provider,
    namespace,
    pod,
  })

  const buildRes = await runner.exec({
    log,
    command,
    timeoutSec: buildTimeout,
    containerName: buildkitContainerName,
    stdout: outputStream,
    stderr: outputStream,
    buffer: true,
  })

  const buildLog = buildRes.log

  log.silly(buildLog)

  return {
    state: "ready",
    outputs,
    detail: {
      buildLog,
      fetched: false,
      fresh: true,
      outputs,
    },
  }
}

export async function ensureBuildkit({
  ctx,
  provider,
  log,
  api,
  namespace,
}: {
  ctx: PluginContext
  provider: KubernetesProvider
  log: Log
  api: KubeApi
  namespace: string
}) {
  return deployLock.acquire(namespace, async () => {
    const deployLog = log.createLog()

    // Make sure auth secret is in place
    const { authSecret, updated: secretUpdated } = await ensureBuilderSecret({
      provider,
      log,
      api,
      namespace,
    })

    const imagePullSecrets = await prepareSecrets({ api, namespace, secrets: provider.config.imagePullSecrets, log })

    // Check status of the buildkit deployment
    const manifest = getBuildkitDeployment(provider, authSecret.metadata.name, imagePullSecrets)
    const status = await compareDeployedResources({
      ctx: ctx as KubernetesPluginContext,
      api,
      namespace,
      manifests: [manifest],
      log: deployLog,
    })

    if (status.state === "ready") {
      // Need to wait a little to ensure the secret is updated in the deployment
      if (secretUpdated) {
        await sleep(1000)
      }
      return { authSecret, updated: false }
    }

    // Deploy the buildkit daemon
    deployLog.info(
      chalk.gray(`-> Deploying ${buildkitDeploymentName} daemon in ${namespace} namespace (was ${status.state})`)
    )

    await api.upsert({ kind: "Deployment", namespace, log: deployLog, obj: manifest })

    await waitForResources({
      namespace,
      ctx,
      provider,
      actionName: "garden-buildkit",
      resources: [manifest],
      log: deployLog,
      timeoutSec: 600,
    })

    deployLog.info("Done!")

    return { authSecret, updated: true }
  })
}

export function getBuildkitFlags(action: Resolved<ContainerBuildAction>) {
  const args: string[] = []

  const spec = action.getSpec()

  for (const arg of getDockerBuildArgs(action.versionString(), spec.buildArgs)) {
    args.push("--opt", "build-arg:" + arg)
  }

  if (spec.targetStage) {
    args.push("--opt", "target=" + spec.targetStage)
  }

  args.push(...(spec.extraFlags || []))

  return args
}

export function getBuildkitImageFlags(
  cacheConfig: ClusterBuildkitCacheConfig[],
  moduleOutputs: ContainerModuleOutputs,
  deploymentRegistryInsecure: boolean
) {
  const args: string[] = []

  const inlineCaches = cacheConfig.filter(
    (config) => getSupportedCacheMode(config, getCacheImageName(moduleOutputs, config)) === "inline"
  )
  const imageNames = [moduleOutputs["deployment-image-id"]]

  if (inlineCaches.length > 0) {
    args.push("--export-cache", "type=inline")

    for (const cache of inlineCaches) {
      const cacheImageName = getCacheImageName(moduleOutputs, cache)
      imageNames.push(`${cacheImageName}:${cache.tag}`)
    }
  }

  let deploymentRegistryExtraSpec = ""
  if (deploymentRegistryInsecure) {
    deploymentRegistryExtraSpec = ",registry.insecure=true"
  }

  args.push("--output", `type=image,"name=${imageNames.join(",")}",push=true${deploymentRegistryExtraSpec}`)

  for (const cache of cacheConfig) {
    const cacheImageName = getCacheImageName(moduleOutputs, cache)

    let registryExtraSpec = ""
    if (cache.registry === undefined) {
      registryExtraSpec = deploymentRegistryExtraSpec
    } else if (cache.registry?.insecure === true) {
      registryExtraSpec = ",registry.insecure=true"
    }

    // subtle: it is important that --import-cache arguments are in the same order as the cacheConfigs
    // buildkit will go through them one by one, and use the first that has any cache hit for all following
    // layers, so it will actually never use multiple caches at once
    args.push("--import-cache", `type=registry,ref=${cacheImageName}:${cache.tag}${registryExtraSpec}`)

    if (cache.export === false) {
      continue
    }

    const cacheMode = getSupportedCacheMode(cache, cacheImageName)
    // we handle inline caches above
    if (cacheMode === "inline") {
      continue
    }

    args.push(
      "--export-cache",
      `type=registry,ref=${cacheImageName}:${cache.tag},mode=${cacheMode}${registryExtraSpec}`
    )
  }

  return args
}

function getCacheImageName(moduleOutputs: ContainerModuleOutputs, cacheConfig: ClusterBuildkitCacheConfig): string {
  if (cacheConfig.registry === undefined) {
    return moduleOutputs["deployment-image-name"]
  }

  const { hostname, port, namespace } = cacheConfig.registry
  const portPart = port ? `:${port}` : ""
  return `${hostname}${portPart}/${namespace}/${moduleOutputs["local-image-name"]}`
}

export const getSupportedCacheMode = (
  cache: ClusterBuildkitCacheConfig,
  deploymentImageName: string
): ClusterBuildkitCacheConfig["mode"] => {
  if (cache.mode !== "auto") {
    return cache.mode
  }

  // NOTE: If you change this, please make sure to also change the table in our documentation in config.ts
  const allowList = [
    /^([^/]+\.)?pkg\.dev\//i, // Google Package Registry
    /^([^/]+\.)?azurecr\.io\//i, // Azure Container registry
    /^hub\.docker\.com\//i, // DockerHub
    /^ghcr\.io\//i, // GitHub Container registry
  ]

  // use mode=max for all registries that are known to support it
  for (const allowed of allowList) {
    if (allowed.test(deploymentImageName)) {
      return "max"
    }
  }

  // we default to mode=inline for all the other registries, including
  // self-hosted ones. Actually almost all self-hosted registries do support
  // mode=max, but harbor doesn't. As it is hard to auto-detect harbor, we
  // chose to use mode=inline for all unknown registries.
  return "inline"
}

export function getBuildkitDeployment(
  provider: KubernetesProvider,
  authSecretName: string,
  imagePullSecrets: { name: string }[]
) {
  const tolerations = [...(provider.config.clusterBuildkit?.tolerations || []), builderToleration]
  const deployment: KubernetesDeployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      labels: {
        app: buildkitDeploymentName,
      },
      name: buildkitDeploymentName,
      annotations: provider.config.clusterBuildkit?.annotations,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: buildkitDeploymentName,
        },
      },
      template: {
        metadata: {
          labels: {
            app: buildkitDeploymentName,
          },
          annotations: provider.config.clusterBuildkit?.annotations,
        },
        spec: {
          containers: [
            {
              name: buildkitContainerName,
              image: buildkitImageName,
              args: ["--addr", "unix:///run/buildkit/buildkitd.sock"],
              readinessProbe: {
                exec: {
                  command: ["buildctl", "debug", "workers"],
                },
                initialDelaySeconds: 3,
                periodSeconds: 5,
              },
              livenessProbe: {
                exec: {
                  command: ["buildctl", "debug", "workers"],
                },
                initialDelaySeconds: 5,
                periodSeconds: 30,
              },
              securityContext: {
                privileged: true,
              },
              volumeMounts: [
                {
                  name: authSecretName,
                  mountPath: "/.docker",
                  readOnly: true,
                },
                {
                  name: buildSyncVolumeName,
                  mountPath: "/garden-build",
                },
              ],
              env: [
                {
                  name: "DOCKER_CONFIG",
                  value: "/.docker",
                },
              ],
            },
            // Attach the util container
            getUtilContainer(authSecretName, provider),
          ],
          imagePullSecrets,
          volumes: [
            {
              name: authSecretName,
              secret: {
                secretName: authSecretName,
                items: [
                  {
                    key: dockerAuthSecretKey,
                    path: "config.json",
                  },
                ],
              },
            },
            {
              name: buildSyncVolumeName,
              emptyDir: {},
            },
          ],
          tolerations,
        },
      },
    },
  }

  const buildkitContainer = deployment.spec!.template.spec!.containers[0]

  // Optionally run buildkit in rootless mode
  if (!!provider.config.clusterBuildkit?.rootless) {
    deployment.spec!.template.metadata!.annotations = {
      "container.apparmor.security.beta.kubernetes.io/buildkitd": "unconfined",
      "container.seccomp.security.alpha.kubernetes.io/buildkitd": "unconfined",
    }
    buildkitContainer.image = buildkitRootlessImageName
    buildkitContainer.args = [
      "--addr",
      "unix:///run/user/1000/buildkit/buildkitd.sock",
      "--oci-worker-no-process-sandbox",
    ]
    buildkitContainer.securityContext = {
      runAsUser: 1000,
      runAsGroup: 1000,
    }
  }

  buildkitContainer.resources = stringifyResources(provider.config.resources.builder)

  // Set the configured nodeSelector, if any
  if (!isEmpty(provider.config.clusterBuildkit?.nodeSelector)) {
    deployment.spec!.template.spec!.nodeSelector = provider.config.clusterBuildkit?.nodeSelector
  }

  return deployment
}
