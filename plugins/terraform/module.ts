/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { join } from "path"
import { pathExists } from "fs-extra"
import { joi } from "@garden-io/core/build/src/config/common"
import { GardenModule, ModuleActionHandlers, PluginContext } from "@garden-io/sdk/types"
import { ConfigurationError } from "@garden-io/sdk/exceptions"
import { dependenciesSchema } from "@garden-io/core/build/src/config/service"
import { TerraformBaseSpec } from "./helpers"
import { TerraformProvider, TerraformProviderConfig } from "./provider"
import { baseBuildSpecSchema } from "@garden-io/core/build/src/config/module"
import { terraformDeploySchemaKeys } from "./action"

export interface TerraformModuleSpec extends TerraformBaseSpec {
  root: string
  dependencies: string[]
}

export interface TerraformModule extends GardenModule<TerraformModuleSpec> {}

type TerraformModuleConfig = TerraformModule["_config"]

export const terraformModuleSchema = () =>
  joi.object().keys({
    build: baseBuildSpecSchema(),
    dependencies: dependenciesSchema(),
    ...terraformDeploySchemaKeys(),
  })

export const configureTerraformModule: ModuleActionHandlers<TerraformModule>["configure"] = async (params) => {
  const ctx = params.ctx as PluginContext<TerraformProviderConfig>
  const moduleConfig = params.moduleConfig as TerraformModuleConfig
  // Make sure the configured root path exists
  const root = moduleConfig.spec.root
  if (root) {
    const absRoot = join(moduleConfig.path, root)
    const exists = await pathExists(absRoot)

    if (!exists) {
      throw new ConfigurationError({
        message: `Terraform: configured working directory '${root}' does not exist`,
        detail: {
          moduleConfig,
        },
      })
    }
  }

  const provider = ctx.provider as TerraformProvider

  // Use the provider config if no value is specified for the module
  if (moduleConfig.spec.autoApply === null) {
    moduleConfig.spec.autoApply = provider.config.autoApply
  }
  if (!moduleConfig.spec.version) {
    moduleConfig.spec.version = provider.config.version
  }

  moduleConfig.serviceConfigs = [
    {
      name: moduleConfig.name,
      dependencies: moduleConfig.spec.dependencies,
      disabled: false,
      spec: moduleConfig.spec,
    },
  ]

  return { moduleConfig }
}
