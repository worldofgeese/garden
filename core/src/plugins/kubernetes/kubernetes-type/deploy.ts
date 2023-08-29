/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { DeployActionDefinition } from "../../../plugin/action-types"
import { dedent } from "../../../util/string"
import { KubernetesPluginContext } from "../config"
import { getPortForwardHandler } from "../port-forward"
import { getActionNamespace } from "../namespace"
import { KubernetesDeployAction, kubernetesDeploySchema } from "./config"
import { execInKubernetesDeploy } from "./exec"
import {
  deleteKubernetesDeploy,
  getKubernetesDeployLogs,
  getKubernetesDeployStatus,
  kubernetesDeploy,
} from "./handlers"
import { ConfigurationError } from "../../../exceptions"
import { uniq } from "lodash"
import { DOCS_BASE_URL } from "../../../constants"
import { kubernetesGetSyncStatus, kubernetesStartSync } from "./sync"
import { k8sContainerStopSync } from "../container/sync"
import { isTruthy } from "../../../util/util"

export const kubernetesDeployDocs = dedent`
  Specify one or more Kubernetes manifests to deploy.

  You can either (or both) specify the manifests as part of the \`garden.yml\` configuration, or you can refer to one or more files with existing manifests.

  Note that if you include the manifests in the \`garden.yml\` file, you can use [template strings](${DOCS_BASE_URL}/using-garden/variables-and-templating) to interpolate values into the manifests.

  If you need more advanced templating features you can use the [helm](./helm.md) Deploy type.
`

export const kubernetesDeployDefinition = (): DeployActionDefinition<KubernetesDeployAction> => ({
  name: "kubernetes",
  docs: kubernetesDeployDocs,
  schema: kubernetesDeploySchema(),
  // outputsSchema: kubernetesDeployOutputsSchema(),
  handlers: {
    configure: async ({ ctx, config }) => {
      // The `spec` field hasn't been validated here yet,
      // so the value of `files` might be `undefined` instead of a default empty array
      // also we discard any falsy file values in files array
      let files = (config.spec.files || []).filter(isTruthy)

      if (files.length > 0 && !config.spec.kustomize) {
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

      return { config, supportedModes: { sync: !!config.spec.sync, local: !!config.spec.localMode } }
    },

    deploy: kubernetesDeploy,
    delete: deleteKubernetesDeploy,
    exec: execInKubernetesDeploy,
    getLogs: getKubernetesDeployLogs,
    getStatus: getKubernetesDeployStatus,

    startSync: kubernetesStartSync,
    stopSync: k8sContainerStopSync,
    getSyncStatus: kubernetesGetSyncStatus,

    getPortForward: async (params) => {
      const { ctx, log, action } = params
      const k8sCtx = <KubernetesPluginContext>ctx
      const namespace = await getActionNamespace({
        ctx: k8sCtx,
        log,
        action,
        provider: k8sCtx.provider,
        skipCreate: true,
      })
      return getPortForwardHandler({ ...params, namespace })
    },
  },
})
