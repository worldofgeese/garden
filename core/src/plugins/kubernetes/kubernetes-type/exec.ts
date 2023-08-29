/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { includes } from "lodash"
import { ConfigurationError, DeploymentError } from "../../../exceptions"
import { getAppNamespace } from "../namespace"
import { KubernetesPluginContext } from "../config"
import { execInWorkload, getTargetResource } from "../util"
import { DeployActionHandler } from "../../../plugin/action-types"
import { KubernetesDeployAction } from "./config"
import { getKubernetesDeployStatus } from "./handlers"
import chalk from "chalk"

export const execInKubernetesDeploy: DeployActionHandler<"exec", KubernetesDeployAction> = async (params) => {
  const { ctx, log, action, command, interactive, target: containerName } = params
  const k8sCtx = <KubernetesPluginContext>ctx
  const provider = k8sCtx.provider

  // TODO: We should allow for alternatives here
  const defaultTarget = action.getSpec("defaultTarget")

  if (!defaultTarget) {
    throw new ConfigurationError({
      message: `${action.longDescription()} does not specify a defaultTarget. Please configure this in order to be able to use this command with. This is currently necessary for the ${chalk.white(
        "exec"
      )} command to work with kubernetes Deploy actions.`,
      detail: {
        name: action.name,
      },
    })
  }

  const status = await getKubernetesDeployStatus({
    ctx,
    action,
    log,
  })
  const namespace = await getAppNamespace(k8sCtx, log, k8sCtx.provider)

  const manifests = status.detail?.detail.remoteResources || []

  const target = await getTargetResource({
    ctx,
    log,
    provider,
    action,
    manifests,
    query: defaultTarget,
  })

  // TODO: this check should probably live outside of the plugin
  if (!target || !includes(["ready", "outdated"], status.detail?.state)) {
    throw new DeploymentError({
      message: `${action.longDescription()} is not running`,
      detail: {
        name: action.name,
        state: status.state,
      },
    })
  }

  return execInWorkload({ ctx, provider, log, namespace, workload: target, containerName, command, interactive })
}
