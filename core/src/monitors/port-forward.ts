/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import type { DeployAction } from "../actions/deploy"
import { Executed } from "../actions/types"
import { ConfigGraph } from "../graph/config-graph"
import { Log } from "../logger/log-entry"
import { PluginEventBroker } from "../plugin-context"
import { MonitorBaseParams, Monitor } from "./base"
import { startPortProxies, PortProxy, stopPortProxy } from "../proxy"
import chalk from "chalk"

interface PortForwardMonitorParams extends MonitorBaseParams {
  action: Executed<DeployAction>
  graph: ConfigGraph
  log: Log
}

/**
 * Monitor the sync status for the given Deploy
 */
export class PortForwardMonitor extends Monitor {
  type = "port-forward"

  public action: Executed<DeployAction>
  private graph: ConfigGraph
  private log: Log
  protected events: PluginEventBroker
  private proxies: PortProxy[]

  constructor(params: PortForwardMonitorParams) {
    super(params)
    this.action = params.action
    this.graph = params.graph
    this.proxies = []
    this.log = params.log.createLog({ name: params.action.key(), origin: "proxy" })
    this.events = new PluginEventBroker(params.garden)
  }

  key() {
    return this.action.key()
  }

  description() {
    return `port proxy for ${this.action.longDescription()}`
  }

  async stopProxies() {
    await Promise.all(
      this.proxies.map((proxy) =>
        stopPortProxy({
          garden: this.garden,
          graph: this.graph,
          log: this.log,
          action: this.action,
          proxy,
          spec: proxy.spec,
        })
      )
    )
  }

  async start() {
    await this.stopProxies()

    const status = this.action.getStatus()

    this.proxies = await startPortProxies({
      garden: this.garden,
      graph: this.graph,
      log: this.log,
      action: this.action,
      status: status.detail!,
    })

    for (const proxy of this.proxies) {
      const targetHost = proxy.spec.targetName || this.action.name

      this.log.info(
        chalk.gray(
          `Port forward: ` +
            chalk.underline(proxy.localUrl) +
            ` → ${targetHost}:${proxy.spec.targetPort}` +
            (proxy.spec.name ? ` (${proxy.spec.name})` : "")
        )
      )
    }

    return {}
  }

  async stop() {
    await this.stopProxies()
    return {}
  }
}
