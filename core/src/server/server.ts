/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Server } from "http"

import chalk from "chalk"
import Koa from "koa"
import Router = require("koa-router")
import type PTY from "node-pty-prebuilt-multiarch"
import websockify from "koa-websocket"
import bodyParser = require("koa-bodyparser")
import getPort = require("get-port")
import { isArray, omit } from "lodash"

import { BaseServerRequest, resolveRequest, serverRequestSchema, shellCommandParamsSchema } from "./commands"
import { DEFAULT_GARDEN_DIR_NAME, gardenEnv } from "../constants"
import { Log } from "../logger/log-entry"
import { Command, CommandResult } from "../commands/base"
import { toGardenError, GardenError, GardenBaseError } from "../exceptions"
import { EventName, Events, EventBus, shouldStreamWsEvent } from "../events/events"
import type { ValueOf } from "../util/util"
import { joi } from "../config/common"
import { randomString } from "../util/string"
import { authTokenHeader } from "../cloud/auth"
import { ApiEventBatch, BufferedEventStream, LogEntryEventPayload } from "../cloud/buffered-event-stream"
import { eventLogLevel, LogLevel } from "../logger/logger"
import { EventEmitter } from "eventemitter3"
import { sanitizeValue } from "../util/logging"
import { uuidv4 } from "../util/random"
import { renderCommandErrors } from "../cli/helpers"
import { GardenInstanceManager } from "./instance-manager"
import { LocalConfigStore } from "../config-store/local"
import { join } from "path"
import { GlobalConfigStore } from "../config-store/global"
import { validateSchema } from "../config/validation"
import { ConfigGraph } from "../graph/config-graph"
import { getGardenCloudDomain } from "../cloud/api"
import type { ServeCommand } from "../commands/serve"
import type { AutocompleteSuggestion } from "../cli/autocomplete"
import execa = require("execa")
import { z } from "zod"
import { omitUndefined } from "../util/objects"

const pty = require("node-pty-prebuilt-multiarch")

// Note: This is different from the `garden serve` default port.
// We may no longer embed servers in watch processes from 0.13 onwards.
export const defaultWatchServerPort = 9777

const skipLogsForCommands = ["autocomplete"]

const skipAnalyticsForCommands = ["sync status"]

interface WebsocketCloseEvent {
  code: number
  message: string
}

type EventPipeListener = (name: EventName, payload: any) => void

// Using the websocket closed private range (4000-4999) for the closed codes
// and adding normal HTTP status codes. So something that would be a 503 HTTP code translates to 4503.
// See also: https://www.iana.org/assignments/websocket/websocket.xhtml
const websocketCloseEvents = {
  badRequest: {
    code: 4400,
    message: "Bad request",
  },
  internalError: {
    code: 4500,
    message: "Internal error",
  },
  notReady: {
    code: 4503,
    message: "Not ready",
  },
  ok: {
    code: 4200,
    message: "OK",
  },
  unauthorized: {
    code: 4401,
    message: "Unauthorized",
  },
} satisfies { [name: string]: WebsocketCloseEvent }

interface GardenServerParams {
  log: Log
  manager: GardenInstanceManager
  defaultProjectRoot: string
  serveCommand: ServeCommand
  port?: number
}

interface ServerConnection {
  id: string
  websocket: Koa.Context["websocket"]
  subscribedGardenKeys: Set<string>
  eventListener: EventPipeListener
  logListener: EventPipeListener
}

/**
 * Start an HTTP server that exposes commands and events for the given Garden instance.
 *
 * Please look at the tests for usage examples.
 *
 * NOTES:
 * If `port` is not specified, the default is used or a random free port is chosen if default is not available.
 * This is done so that a process can always create its own server, but we won't need that functionality once we
 * run a shared service across commands.
 */
export async function startServer(params: GardenServerParams) {
  // Start HTTP API server.
  // allow overriding automatic port picking
  if (gardenEnv.GARDEN_SERVER_PORT) {
    params.port = gardenEnv.GARDEN_SERVER_PORT
  }
  const server = new GardenServer(params)
  await server.start()
  return server
}

export class GardenServer extends EventEmitter {
  private log: Log
  private debugLog: Log
  private statusLog: Log

  private server: Server
  private app: websockify.App

  private manager: GardenInstanceManager
  private incomingEvents: EventBus
  private globalConfigStore: GlobalConfigStore
  private serveCommand: ServeCommand

  private defaultProjectRoot: string
  private defaultEnv?: string

  private activePersistentRequests: { [requestId: string]: { command: Command; connection: ServerConnection } }
  private openConnections: Map<string, ServerConnection>

  public port: number | undefined
  public readonly authKey: string
  public readonly sessionId: string

  constructor({ log, manager, port, defaultProjectRoot, serveCommand }: GardenServerParams) {
    super()
    this.log = log
    this.debugLog = this.log.createLog({ fixLevel: LogLevel.debug })
    this.manager = manager
    this.openConnections = new Map()
    this.globalConfigStore = new GlobalConfigStore()
    this.port = port
    this.defaultProjectRoot = defaultProjectRoot
    this.sessionId = manager.sessionId
    this.authKey = randomString(24)
    this.incomingEvents = new EventBus()
    this.activePersistentRequests = {}
    this.serveCommand = serveCommand
  }

  async start() {
    if (this.server) {
      return
    }
    this.app = await this.createApp()

    const hostname = gardenEnv.GARDEN_SERVER_HOSTNAME || "localhost"

    const _start = async () => {
      // TODO: pipe every event
      return new Promise<void>((resolve, reject) => {
        this.server = this.app.listen(this.port, hostname)
        this.server.on("error", (error) => {
          this.emit("error", error)
          reject(error)
        })
        this.server.on("close", () => {
          this.emit("close")
        })
        this.server.once("listening", () => {
          resolve()
        })
      })
    }

    if (this.port) {
      await _start()
    } else {
      do {
        try {
          this.port = await getPort({ port: defaultWatchServerPort })
          await _start()
        } catch {}
      } while (!this.server)
    }

    const processRecord = await this.globalConfigStore.get("activeProcesses", String(process.pid))

    if (processRecord) {
      await this.globalConfigStore.update("activeProcesses", String(process.pid), {
        sessionId: this.sessionId,
        serverHost: this.getBaseUrl(),
        serverAuthKey: this.authKey,
      })
    }

    this.statusLog = this.log.createLog()
  }

  getBaseUrl() {
    return `http://localhost:${this.port}`
  }

  getUrl() {
    return `${this.getBaseUrl()}?key=${this.authKey}`
  }

  showUrl(url?: string) {
    this.statusLog.info("🌻 " + chalk.cyan("Garden server running at ") + chalk.blueBright(url || this.getUrl()))
  }

  async close() {
    // Note: This will stop monitors. The CLI wrapper will wait for those to halt.
    this.manager.getAll().forEach((garden) => garden.events.emit("_exit", {}))
    for (const conn of this.openConnections.values()) {
      conn.websocket.close(1000, "Server closing")
    }
    return this.server.close()
  }

  async getDefaultEnv(projectRoot: string) {
    if (this.defaultEnv) {
      return this.defaultEnv
    }

    const localConfig = new LocalConfigStore(join(projectRoot, DEFAULT_GARDEN_DIR_NAME))
    return localConfig.get("defaultEnv")
  }

  async resolveRequest(ctx: Router.IRouterContext | Koa.ParameterizedContext, request: BaseServerRequest) {
    // Perform basic validation and find command.
    try {
      request = validateSchema(request, serverRequestSchema(), { context: "API request" })
    } catch (err) {
      return ctx.throw(400, "Invalid request format: " + err.message)
    }

    try {
      const result = await resolveRequest({
        log: this.log,
        request,
        manager: this.manager,
        defaultProjectRoot: this.defaultProjectRoot,
        globalConfigStore: this.globalConfigStore,
      })

      if (result.error) {
        let msg = result.error.message
        if (result.error.detail) {
          msg += ": " + result.error.detail
        }
        return ctx.throw(result.error.code, msg)
      }

      return result
    } catch (error) {
      if (error.status) {
        throw error
      }
      this.log.error({ msg: error.message, error })
      return ctx.throw(500, `Unable to process request: ${error.message}`)
    }
  }

  private async createApp() {
    // prepare request-command map
    const app = websockify(new Koa())
    const http = new Router()

    http.use((ctx, next) => {
      const authToken = ctx.header[authTokenHeader] || ctx.query.key
      const sessionId = ctx.query.sessionId

      // We allow either sessionId or authKey ro authorize
      if (authToken !== this.authKey && sessionId !== this.sessionId) {
        return ctx.throw(401, `Unauthorized request`)
      }
      return next()
    })

    /**
     * HTTP API endpoint (POST /api)
     *
     * We don't expose a different route per command, but rather accept a JSON object via POST on /api
     * with a `command` key. The API wouldn't be RESTful in any meaningful sense anyway, and this
     * means we can keep a consistent format across mechanisms.
     */
    http.post("/api", async (ctx) => {
      this.debugLog.debug(`Received request: ${JSON.stringify(ctx.request.body)}`)

      const { garden, command, log, args, opts } = await this.resolveRequest(ctx, ctx.request.body as BaseServerRequest)

      if (!command) {
        return ctx.throw(400, "Must specify command parameter.")
      }

      const prepareParams = {
        log,
        args,
        opts,
        parentCommand: this.serveCommand,
      }

      const persistent = command.maybePersistent(prepareParams)

      if (persistent) {
        return ctx.throw(400, "Attempted to run persistent command (e.g. a dev/follow command). Aborting.")
      }

      this.debugLog.debug(`Running command '${command.name}'`)

      await command.prepare(prepareParams)

      ctx.status = 200

      try {
        const result = await command.run({
          ...prepareParams,
          garden,
          sessionId: uuidv4(),
          parentSessionId: this.sessionId,
        })
        this.debugLog.debug(`Command '${command.name}' completed successfully`)

        ctx.response.body = sanitizeValue(result)
      } catch (error) {
        // Return 200 with errors attached, since commands can legitimately fail (e.g. tests erroring etc.)
        ctx.response.body = sanitizeValue({ errors: [error] })
      }
      return
    })

    // TODO: remove this once it has another place
    /**
     * Resolves the URL for the given provider dashboard page, and redirects to it.
     */
    http.get("/dashboardPages/:pluginName/:pageName", async (ctx) => {
      const { garden } = await this.resolveRequest(ctx, ctx.request.body as BaseServerRequest)

      const { pluginName, pageName } = ctx.params

      const actions = await garden!.getActionRouter()
      const plugin = await garden!.getPlugin(pluginName)
      const page = plugin.dashboardPages.find((p) => p.name === pageName)

      if (!page) {
        ctx.throw(400, `Could not find page ${pageName} from provider ${pluginName}`)
        return
      }

      const { url } = await actions.provider.getDashboardPage({ log: this.log, page, pluginName })
      ctx.redirect(url)
    })

    /**
     * Events endpoint, for ingesting events from other Garden processes, and piping to any open websocket connections.
     * Requires a valid auth token header, matching `this.authKey`.
     *
     * The API matches that of the Garden Cloud /events endpoint.
     */
    http.post("/events", async (ctx) => {
      // TODO: validate the input
      const batch = ctx.request.body as ApiEventBatch
      this.debugLog.debug(`Received ${batch.events.length} events from session ${batch.sessionId}`)

      // Pipe the events to the incoming stream, which websocket listeners will then receive
      batch.events.forEach((e) => this.incomingEvents.emit(e.name, e.payload))

      ctx.status = 200
    })

    app.use(bodyParser())

    app.use(http.routes())
    app.use(http.allowedMethods())

    app.on("error", (err, ctx) => {
      this.debugLog.info(`API server request failed with status ${ctx.status}: ${err.message}`)
    })

    this.addWebsocketEndpoint(app)

    return app
  }

  /**
   * Add the /ws endpoint to the Koa app. Every event emitted to the event bus is forwarded to open
   * Websocket connections, and clients can send commands over the socket and receive results on the
   * same connection.
   */
  private addWebsocketEndpoint(app: websockify.App) {
    // TODO: split this method up
    const wsRouter = new Router()

    wsRouter.get("/ws", async (ctx) => {
      // The typing for koa-router isn't working currently
      const websocket: Koa.Context["websocket"] = ctx["websocket"]

      const connectionId = uuidv4()

      // Helper to make JSON messages, make them type-safe, and to log errors.
      const send: SendWrapper = (type, payload) => {
        // Need to make sure that the log entries created here aren't emitted to prevent
        // an infinite loop.
        const skipEmit = true
        const event = { type, ...(<object>payload) }
        const jsonEvent = JSON.stringify(event)
        this.log.debug({ msg: `Send ${type} event: ${jsonEvent}`, skipEmit })
        websocket.send(jsonEvent, (err?: Error) => {
          if (err) {
            this.debugLog.debug({ error: toGardenError(err), skipEmit })
          }
        })
      }

      if (ctx.query.key !== this.authKey && ctx.query.sessionId !== this.sessionId) {
        send("error", { message: `401 Unauthorized` })
        const wsUnauthorizedEvent = websocketCloseEvents.unauthorized
        websocket.close(wsUnauthorizedEvent.code, wsUnauthorizedEvent.message)
        return
      }

      const subscribedGardenKeys: Set<string> = new Set()

      const eventListener: EventPipeListener = (name, payload) => {
        if (shouldStreamWsEvent(name, payload)) {
          send("event", { name, payload })
        }
      }

      const logListener: EventPipeListener = (name: EventName, payload) => {
        const gardenKey = payload?.context?.gardenKey
        if (name === "logEntry" && gardenKey) {
          send(name, payload)
        }
      }

      const connection = {
        id: connectionId,
        websocket,
        subscribedGardenKeys,
        eventListener,
        logListener,
      }

      this.openConnections.set(connectionId, connection)

      send("event", { name: "connectionReady", payload: {} })

      const cleanup = () => {
        this.log.debug(`Connection ${connectionId} terminated, cleaning up.`)

        this.manager.events.offAny(eventListener)
        this.log.root.events.offAny(logListener)

        for (const [id, req] of Object.entries(this.activePersistentRequests)) {
          if (connectionId === req.connection.id) {
            req.command.terminate()

            delete this.activePersistentRequests[id]
          }
        }

        this.openConnections.delete(connectionId)
      }

      // Set up heartbeat to detect dead connections
      this.setupWsHeartbeat(connectionId, websocket, cleanup)

      this.manager.events.ensureAny(eventListener)
      // TODO: scope and filter logs instead of emitting everything from all instances
      this.log.root.events.ensureAny(logListener)

      // Make sure we clean up listeners when connections end.
      websocket.on("close", cleanup)

      // Respond to commands.
      websocket.on("message", (msg: string | Buffer) => {
        this.handleWsMessage({ msg, ctx, send, connection }).catch((err) => {
          send("error", { message: err.message })
        })
      })
    })

    wsRouter.get("/pty", async (ctx) => {
      const websocket: Koa.Context["websocket"] = ctx["websocket"]

      const connectionId = uuidv4()

      // args may not just be a single value
      if (ctx.query.args && !isArray(ctx.query.args)) {
        ctx.query.args = [ctx.query.args]
      }

      const validation = shellCommandBodySchema.safeParse(ctx.query)

      if (!validation.success) {
        const event = websocketCloseEvents.badRequest
        const msg = `${event.message}: ${validation.error.message}`
        // We need to send line returns as \r\n, otherwise the terminal will not work correctly
        websocket.send(msg.replace(/\r?\n/g, "\r\n") + "\r\n")
        websocket.close(event.code, msg)
        return
      }

      const { command, args, cwd, key, columns, rows } = validation.data

      // It's crucial to authenticate here because running shell commands locally is sensitive
      if (key !== this.authKey) {
        const event = websocketCloseEvents.unauthorized
        websocket.close(event.code, event.message)
        return
      }

      let proc: PTY.IPty
      let cleanedUp = false

      const cleanup = () => {
        if (cleanedUp) {
          return
        }
        cleanedUp = true
        this.log.info(`Connection ${connectionId} terminated, cleaning up.`)
        proc?.kill()
      }

      try {
        proc = pty.spawn("sh", ["-c", `sleep 1; ${command} ${args.join(" ")}`], {
          name: "xterm-256color",
          cols: columns,
          rows,
          cwd,
          env: { ...omitUndefined(process.env) }, // TODO: support this
        })

        proc.onData((data) => {
          websocket.OPEN && websocket.send(data)
        })

        proc.onExit(({ exitCode, signal }) => {
          const msg = `Command '${command}' exited with code ${exitCode}, signal ${signal}`
          this.log.info(msg)
          const event = websocketCloseEvents.ok
          if (websocket.OPEN) {
            if (exitCode !== 0) {
              websocket.send(msg + "\r\n")
            } else {
              websocket.send(chalk.green("\r\n\r\nDone!\r\n"))
            }
            // We use 4700 + exitCode because the websocket close code must be a number between 4000 and 4999
            websocket.close(4700 + exitCode, msg)
          }
        })

        this.setupWsHeartbeat(connectionId, websocket, cleanup)

        // Make sure we clean up listeners when connections end.
        websocket.on("close", cleanup)

        // Stream stdin
        websocket.on("message", (stdin: string | Buffer) => {
          proc.write(stdin.toString())
        })
      } catch (err) {
        const msg = `Could not run command '${command}': ${err.message}`
        this.log.error(msg)
        const event = websocketCloseEvents.ok
        if (websocket.OPEN) {
          websocket.send(msg + "\r\n")
          websocket.close(event.code, msg)
        }
        cleanup()
      }
    })

    app.ws.use(<Koa.Middleware<any>>wsRouter.routes())
    app.ws.use(<Koa.Middleware<any>>wsRouter.allowedMethods())
  }

  private setupWsHeartbeat(connectionId: string, websocket: Koa.Context["websocket"], cleanup: () => void) {
    // Set up heartbeat to detect dead connections
    let isAlive = true
    let heartbeatInterval = setInterval(() => {
      if (!isAlive) {
        this.log.debug(`Connection ${connectionId} timed out.`)
        clearInterval(heartbeatInterval)
        cleanup()
        websocket.terminate()
      }

      isAlive = false
      websocket.ping(() => {})
    }, 1000)

    websocket.on("pong", () => {
      isAlive = true
    })
  }

  private async handleWsMessage({
    msg,
    ctx,
    send,
    connection,
  }: {
    msg: string | Buffer
    ctx: Koa.ParameterizedContext
    send: SendWrapper
    connection: ServerConnection
  }) {
    let request: any

    this.log.silly("Got request: " + msg)

    try {
      request = JSON.parse(msg.toString())
    } catch {
      return send("error", { message: "Could not parse message as JSON" })
    }

    const requestId: string = request.id
    const requestType: string = request.type

    try {
      joi.attempt(requestId, joi.string().uuid().required())
    } catch {
      return send("error", { message: "Message should contain an `id` field with a UUID value", requestId })
    }

    try {
      joi.attempt(request.type, joi.string().required())
    } catch {
      return send("error", { message: "Message should contain a type field" })
    }

    if (requestType === "command") {
      // Start a command
      try {
        const resolved = await this.resolveRequest(ctx, omit(request, "type"))
        const { garden, command, log: commandLog, args, opts, internal } = resolved

        if (!command) {
          return send("error", { message: "Command not specified in type=command request" })
        }

        connection.subscribedGardenKeys.add(garden.getInstanceKey())

        const prepareParams = {
          log: commandLog,
          args,
          opts,
          parentCommand: this.serveCommand,
        }

        const persistent = command.maybePersistent(prepareParams)
        // We don't want to print logs on every request for some commands.
        const isInternal = internal || skipLogsForCommands.includes(command.getFullName())
        const requestLog = this.log.createLog({ name: "garden-server" })
        const cmdNameStr = chalk.bold.white(command.getFullName())
        const commandSessionId = requestId

        if (skipAnalyticsForCommands.includes(command.getFullName())) {
          command.enableAnalytics = false
        }

        const commandResponseBase = {
          requestId,
          sessionId: commandSessionId,
          command: command.getFullName(),
          persistent,
          commandRequest: request.command,
        }

        // TODO: convert to async/await (this was previously in a sync method)
        command
          .prepare(prepareParams)
          .then(() => {
            if (persistent) {
              send("commandStart", {
                ...commandResponseBase,
                args,
                opts,
              })
              this.activePersistentRequests[requestId] = { command, connection }

              command.subscribe((data: any) => {
                send("commandOutput", {
                  ...commandResponseBase,
                  data: sanitizeValue(data),
                })
              })
            }

            if (!isInternal) {
              requestLog.info(chalk.grey(`Running command ${cmdNameStr}`))
            }

            return command.run({
              ...prepareParams,
              garden,
              sessionId: commandSessionId,
              parentSessionId: this.sessionId,
              overrideLogLevel: internal ? LogLevel.silly : undefined,
            })
          })
          // Here we check if the command has active monitors and if so,
          // wait for them to stop before handling the command result.
          .then((commandResult) => {
            const req = this.activePersistentRequests[requestId]

            // Request was aborted in-flight so we cleanup its monitors
            if (!req) {
              garden.monitors.unsubscribe(command)
            }

            const monitors = garden?.monitors.getBySubscriber(command) || []
            if (req && monitors.length > 0) {
              const monitorIds = monitors.map((m) => m.id())
              return new Promise<CommandResult>((resolve, reject) => {
                garden.monitors
                  .waitUntilStopped(monitorIds)
                  .then(() => {
                    resolve(commandResult)
                  })
                  .catch((err) => {
                    reject(err)
                  })
              })
            } else {
              return commandResult
            }
          })
          // Here we handle the actual commnad result.
          .then((commandResult) => {
            const { result, errors } = commandResult
            send(
              "commandResult",
              sanitizeValue({
                ...commandResponseBase,
                result,
                errors,
              })
            )
            if (!isInternal) {
              if (errors?.length) {
                renderCommandErrors(requestLog.root, errors, commandLog)
              } else {
                requestLog.success(chalk.green(`Command ${cmdNameStr} completed successfully`))
              }
            }
            delete this.activePersistentRequests[requestId]
          })
          .catch((error) => {
            send("error", { message: error.message, requestId })
            if (!isInternal) {
              requestLog.error({ error: toGardenError(error) })
            }
            delete this.activePersistentRequests[requestId]
          })
      } catch (error) {
        this.log.error({ msg: `Unexpected error handling request ID ${requestId}: ${error.message}`, error })
        return send("error", { message: error.message, requestId })
      }
    } else if (requestType === "commandStatus") {
      // Retrieve the status for an active persistent command
      const r = this.activePersistentRequests[requestId]
      const status = r ? "active" : "not found"
      send("commandStatus", {
        requestId,
        status,
      })
    } else if (requestType === "abortCommand") {
      // Abort a running persistent command
      const req = this.activePersistentRequests[requestId]

      if (req) {
        req.command.terminate()
        this.manager.monitors.unsubscribe(req.command)
      }

      delete this.activePersistentRequests[requestId]
    } else if (requestType === "loadConfig") {
      // Emit the config graph for the project (used for the Cloud dashboard)
      const resolved = await this.resolveRequest(ctx, omit(request, "type"))
      let { garden, log: _log } = resolved
      const log = _log.createLog({ fixLevel: LogLevel.silly })

      const loadConfigLog = this.log.createLog({ name: "garden-server", showDuration: true })
      loadConfigLog.info("Loading config for Live page...")

      const cloudApi = await this.manager.getCloudApi({
        log,
        cloudDomain: getGardenCloudDomain(garden.cloudDomain),
        globalConfigStore: garden.globalConfigStore,
      })

      // Use the server session ID. That is, the "main" session ID that belongs to the parent serve command.
      const sessionIdForConfigLoad = this.sessionId
      garden = garden.cloneForCommand(sessionIdForConfigLoad, cloudApi)

      const cloudSession = garden.cloudApi?.getRegisteredSession(sessionIdForConfigLoad)

      const cloudEventStream = new BufferedEventStream({
        log,
        cloudSession,
        maxLogLevel: eventLogLevel,
        garden,
        streamEvents: true,
        streamLogEntries: false,
      })

      let graph: ConfigGraph | undefined
      let errors: GardenBaseError[] = []

      try {
        graph = await garden.getConfigGraph({ log, emit: true })
        loadConfigLog.success("Config loaded")
      } catch (error) {
        errors.push(toGardenError(error))
      } finally {
        loadConfigLog.success(`Loading config failed with error: ${errors[0].message}`)
        await cloudEventStream.close() // Note: This also flushes events
        send(
          "commandResult",
          sanitizeValue({
            requestId,
            result: graph,
            errors,
          })
        )
      }
    } else if (requestType === "autocomplete") {
      // Provide a much simpler+faster codepath for autocomplete requests
      // Note: If "loadConfig" or a Garden command has not been run, a limited set of results will be returned.
      const input = request.input
      if (!request.input || typeof input !== "string") {
        return send("error", { message: "Message should contain an input field of type string" })
      }

      const projectRoot = request.projectRoot
      if (projectRoot && typeof projectRoot !== "string") {
        return send("error", { message: "projectRoot must be a string" })
      }

      try {
        const suggestions = this.manager.getAutocompleteSuggestions({
          log: this.log,
          projectRoot: projectRoot || this.defaultProjectRoot,
          input,
        })
        return send("autocompleteResult", { requestId, suggestions })
      } catch (error) {
        return send("error", { requestId, message: `Failed computing suggestions for input '${input}': ${error}` })
      }
    } else {
      return send("error", {
        requestId,
        message: `Unsupported request type: ${requestType}`,
      })
    }
  }
}

interface CommandResponseBase {
  requestId: string
  sessionId: string
  command: string
  /**
   * The command string originally requested by the caller if applicable.
   */
  commandRequest?: string
  persistent: boolean
}

interface ServerWebsocketMessages {
  commandOutput: CommandResponseBase & {
    data: string
  }
  commandResult: CommandResponseBase & {
    result: CommandResult<any>
    errors?: GardenError[]
  }
  commandStart: CommandResponseBase & {
    args: object
    opts: object
  }
  commandStatus: {
    requestId: string
    status: "active" | "not found"
  }
  error: {
    requestId?: string
    message: string
  }
  event: {
    name: EventName
    payload: ValueOf<Events>
  }
  logEntry: LogEntryEventPayload
  autocompleteResult: {
    requestId: string
    suggestions: AutocompleteSuggestion[]
  }
}

type ServerWebsocketMessageType = keyof ServerWebsocketMessages

export type ServerWebsocketMessage = ServerWebsocketMessages[ServerWebsocketMessageType] & {
  type: ServerWebsocketMessageType
}

type SendWrapper<T extends ServerWebsocketMessageType = ServerWebsocketMessageType> = (
  type: T,
  payload: ServerWebsocketMessages[T]
) => void

const shellCommandBodySchema = shellCommandParamsSchema.extend({
  key: z.string().describe("The server auth key."),
  columns: z.coerce.number().default(80).describe("Number of columns in the virtual terminal."),
  rows: z.coerce.number().default(30).describe("Number of rows in the virtual terminal."),
})
