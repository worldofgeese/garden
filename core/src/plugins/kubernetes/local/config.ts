/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import {
  KubernetesConfig,
  kubernetesConfigBase,
  k8sContextSchema,
  KubernetesProvider,
  namespaceSchema,
} from "../config"
import { ConfigureProviderParams } from "../../../plugin/handlers/Provider/configureProvider"
import { joiProviderName, joi } from "../../../config/common"
import { getKubeConfig } from "../api"
import { configureMicrok8sAddons } from "./microk8s"
import { setMinikubeDockerEnv } from "./minikube"
import { exec } from "../../../util/util"
import { remove } from "lodash"
import chalk from "chalk"
import { isKindCluster } from "./kind"
import { isK3sFamilyCluster } from "./k3s"
import { getK8sClientServerVersions, K8sClientServerVersions } from "../util"

// TODO: split this into separate plugins to handle Docker for Mac and Minikube
// note: this is in order of preference, in case neither is set as the current kubectl context
// and none is explicitly configured in the garden.yml
const supportedContexts = [
  "docker-for-desktop",
  "docker-desktop",
  "microk8s",
  "minikube",
  "kind-kind",
  "colima",
  "rancher-desktop",
  "k3d-k3s-default",
]
const nginxServices = ["ingress-controller", "default-backend"]

function isSupportedContext(context: string) {
  return supportedContexts.includes(context) || context.startsWith("kind-")
}

export interface LocalKubernetesConfig extends KubernetesConfig {
  setupIngressController: string | null
}

export const configSchema = () =>
  kubernetesConfigBase()
    .keys({
      name: joiProviderName("local-kubernetes"),
      context: k8sContextSchema().optional(),
      namespace: namespaceSchema().description(
        "Specify which namespace to deploy services to (defaults to the project name). " +
          "Note that the framework generates other namespaces as well with this name as a prefix."
      ),
      setupIngressController: joi
        .string()
        .allow("nginx", false, null)
        .default("nginx")
        .description("Set this to null or false to skip installing/enabling the `nginx` ingress controller."),
    })
    .description("The provider configuration for the local-kubernetes plugin.")

export async function configureProvider(params: ConfigureProviderParams<LocalKubernetesConfig>) {
  const { base, log, projectName, ctx } = params

  let { config } = await base!(params)
  const providerLog = log.createLog({ name: config.name })

  const provider = ctx.provider as KubernetesProvider
  provider.config = config
  const _systemServices = config._systemServices

  const kubeConfig: any = await getKubeConfig(providerLog, ctx, provider)

  const currentContext = kubeConfig["current-context"]!

  if (!config.context) {
    // automatically detect supported kubectl context if not explicitly configured
    if (currentContext && isSupportedContext(currentContext)) {
      // prefer current context if set and supported
      config.context = currentContext
      providerLog.debug(`Using current context: ${config.context}`)
    } else {
      const availableContexts = kubeConfig.contexts?.map((c: any) => c.name) || []

      for (const context of availableContexts) {
        if (isSupportedContext(context)) {
          config.context = context
          providerLog.debug(`Using detected context: ${config.context}`)
          break
        }
      }
    }

    if (!config.context && kubeConfig.contexts?.length > 0) {
      config.context = kubeConfig.contexts[0]!.name
      providerLog.debug(`No kubectl context auto-detected, using first available: ${config.context}`)
    }
  }

  // TODO: change this in 0.12 to use the current context
  if (!config.context) {
    config.context = supportedContexts[0]
    providerLog.debug(`No kubectl context configured, using default: ${config.context}`)
  }

  if (await isK3sFamilyCluster(ctx, provider, providerLog)) {
    config.clusterType = "k3s"
    if (config.setupIngressController === "nginx") {
      providerLog.debug("Using k3s conformant nginx ingress controller")
      remove(_systemServices, (s) => nginxServices.includes(s))
      _systemServices.push("nginx-k3s")
    }
  }

  if (await isKindCluster(ctx, provider, providerLog)) {
    config.clusterType = "kind"

    if (config.setupIngressController === "nginx") {
      providerLog.debug("Using nginx-kind service for ingress")
      remove(_systemServices, (s) => nginxServices.includes(s))
      let versions: K8sClientServerVersions | undefined
      try {
        versions = await getK8sClientServerVersions(config.context)
      } catch (err) {
        providerLog.debug("failed to get k8s version with error: " + err)
      }
      // TODO: remove this once we no longer support k8s v1.20
      if (versions && versions.serverVersion.minor >= 21) {
        _systemServices.push("nginx-kind-new")
      } else {
        _systemServices.push("nginx-kind-old")
      }
    }
  } else if (config.context === "minikube") {
    await exec("minikube", ["config", "set", "WantUpdateNotification", "false"])

    config.clusterType = "minikube"

    if (!config.defaultHostname) {
      // use the nip.io service to give a hostname to the instance, if none is explicitly configured
      const { stdout } = await exec("minikube", ["ip"])
      config.defaultHostname = `${projectName}.${stdout}.nip.io`
    }

    if (config.setupIngressController === "nginx") {
      providerLog.debug("Using minikube's ingress addon")
      try {
        await exec("minikube", ["addons", "enable", "ingress"])
      } catch (err) {
        providerLog.warn(chalk.yellow(`Unable to enable minikube ingress addon: ${err.all}`))
      }
      remove(_systemServices, (s) => nginxServices.includes(s))
    }

    await setMinikubeDockerEnv()
  } else if (config.context === "microk8s") {
    const addons = ["dns", "registry", "storage"]

    config.clusterType = "microk8s"

    if (config.setupIngressController === "nginx") {
      providerLog.debug("Using microk8s's ingress addon")
      addons.push("ingress")
      remove(_systemServices, (s) => nginxServices.includes(s))
      _systemServices.push("nginx-ingress-class")
    }

    await configureMicrok8sAddons(providerLog, addons)
  }

  if (!config.defaultHostname) {
    config.defaultHostname = `${projectName}.local.demo.garden`
  }

  return { config }
}
