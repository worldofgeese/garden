/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Task, ValidResultType } from "../tasks/base"
import { GardenBaseError, InternalError, isGardenError } from "../exceptions"
import { GraphResult, GraphResultFromTask, GraphResults } from "./results"
import type { GraphSolver } from "./solver"
import { ValuesType } from "utility-types"
import chalk from "chalk"
import { metadataForLog } from "./common"
import { Profile } from "../util/profiling"

export interface InternalNodeTypes {
  status: StatusTaskNode
  process: ProcessTaskNode
}

export type InternalNode = ValuesType<InternalNodeTypes>

export interface NodeTypes extends InternalNodeTypes {
  request: RequestTaskNode
}

export type NodeType = keyof NodeTypes

export interface TaskNodeParams<T extends Task> {
  solver: GraphSolver
  task: T
  dependant?: TaskNode
  statusOnly: boolean
}

@Profile()
export abstract class TaskNode<T extends Task = Task> {
  abstract readonly executionType: NodeType

  public readonly type: string
  public startedAt?: Date
  public readonly task: T
  public readonly statusOnly: boolean

  protected solver: GraphSolver
  protected dependants: { [key: string]: TaskNode }
  protected result?: GraphResult<any>

  constructor({ solver, task, statusOnly }: TaskNodeParams<T>) {
    this.task = task
    this.type = task.type
    this.solver = solver
    this.statusOnly = statusOnly
    this.dependants = {}
  }

  abstract describe(): string
  abstract getDependencies(): TaskNode[]
  abstract execute(): Promise<T["_resultType"] | null>

  getKey() {
    return getNodeKey(this.task, this.executionType)
  }

  addDependant(node: TaskNode) {
    const key = node.getKey()
    if (!this.dependants[key]) {
      this.dependants[key] = node
    }
  }

  /**
   * Returns all dependencies that does not yet have a result, i.e. is not resolved.
   */
  getRemainingDependencies(): TaskNode[] {
    return this.getDependencies().filter((d) => this.getDependencyResult(d) === undefined)
  }

  /**
   * Get the result for the given dependency node. Returns undefined if result is not yet set.
   */
  getDependencyResult<A extends Task>(node: TaskNode<A>): GraphResult<A["_resultType"]> | undefined {
    return node.getResult()
  }

  /**
   * Returns all dependency results.
   */
  getDependencyResults(): GraphResults {
    const deps = this.getDependencies()
    const results = new GraphResults(deps.map((d) => d.task))

    for (const dep of deps) {
      const result = this.getDependencyResult(dep)
      result && results.setResult(dep.task, result)
    }

    return results
  }

  isComplete() {
    return !!this.result
  }

  /**
   * Completes the node, setting its result and propagating it to each dependant node.
   *
   * If the node is aborted or an error is set, dependants are aborted.
   *
   * If the node was already completed, this is a no-op (may e.g. happen if the node has been completed
   * but a dependency fails and is aborting dependants).
   */
  complete({ startedAt, error, result, aborted }: CompleteTaskParams): GraphResult {
    if (this.result) {
      return this.result
    }

    const task = this.task
    const dependencyResults = this.getDependencyResults()
    const inputVersion = task.getInputVersion()

    task.log.silly({
      msg: `Completing node ${chalk.underline(this.getKey())}. aborted=${aborted}, error=${
        error ? error.message : null
      }`,
      metadata: metadataForLog(task, error ? "error" : "success", inputVersion),
    })

    this.result = {
      type: task.type,
      description: task.getDescription(),
      key: task.getKey(),
      name: task.getName(),
      result,
      dependencyResults: dependencyResults.filterForGraphResult(),
      aborted,
      startedAt,
      completedAt: new Date(),
      error,
      inputVersion,
      outputs: result?.outputs,
      task,
      processed: this.executionType === "process",
      success: !error && !aborted,
      attached: !!result?.attached,
    }

    if (aborted || error) {
      // Fail every dependant
      for (const d of Object.values(this.dependants)) {
        d.complete({
          startedAt,
          aborted: true,
          result: null,
          // Note: The error message is constructed in the error constructor
          error: new GraphNodeError({ ...this.result, aborted: true, node: d }),
        })
      }
    }

    return this.result!
  }

  /**
   * Returns the task result if the task is completed. Returns undefined if result is not available.
   */
  getResult() {
    return this.result
  }

  getInputVersion() {
    return this.task.getInputVersion()
  }

  protected getNode<NT extends keyof InternalNodeTypes>(type: NT, task: Task): InternalNodeTypes[NT] {
    return this.solver.getNode({ type, task, statusOnly: this.statusOnly })
  }
}

export interface TaskRequestParams<T extends Task = Task> extends TaskNodeParams<T> {
  batchId: string
  statusOnly: boolean
  completeHandler: CompleteHandler<T["_resultType"]>
}

@Profile()
export class RequestTaskNode<T extends Task = Task> extends TaskNode<T> {
  // FIXME: this is a bit of a TS oddity, but it does work...
  executionType = <NodeType>"request"

  public readonly requestedAt: Date
  public readonly batchId: string

  private completeHandler: CompleteHandler<T["_resultType"]>

  constructor(params: TaskRequestParams<T>) {
    super(params)
    this.requestedAt = new Date()
    this.batchId = params.batchId
    this.completeHandler = params.completeHandler
  }

  describe() {
    return this.task.getDescription()
  }

  override getKey() {
    return `${this.task.getBaseKey()}:request:${this.batchId}`
  }

  getDependencies(): TaskNode[] {
    if (this.statusOnly) {
      return [this.getNode("status", this.task)]
    } else {
      return [this.getNode("process", this.task)]
    }
  }

  override complete(params: CompleteTaskParams) {
    const result = super.complete(params)
    this.completeHandler(result)
    return result
  }

  // NOT USED
  async execute() {
    return null
  }
}

@Profile()
export class ProcessTaskNode<T extends Task = Task> extends TaskNode<T> {
  executionType = <NodeType>"process"

  describe() {
    return `processing ${this.task.getDescription()}`
  }

  getDependencies() {
    const statusTask = this.getNode("status", this.task)
    const statusResult = this.getDependencyResult(statusTask) as GraphResult<any>

    if (statusResult === undefined) {
      // Status is still missing
      return [statusTask]
    }

    // Either forcing, or status is not ready
    const processDeps = this.task.getProcessDependencies({ status: statusResult.result })
    return processDeps.map((task) => this.getNode("process", task))
  }

  async execute() {
    this.task.log.silly(`Executing node ${chalk.underline(this.getKey())}`)

    const statusTask = this.getNode("status", this.task)
    // TODO: make this more type-safe
    const statusResult = this.getDependencyResult(statusTask) as GraphResultFromTask<T>

    if (statusResult === undefined) {
      throw new InternalError({
        message: `Attempted to execute ${this.describe()} before resolving status.`,
        detail: {
          nodeKey: this.getKey(),
        },
      })
    }

    const status = statusResult?.result

    if (!this.task.force && status?.state === "ready") {
      return status
    }

    const dependencyResults = this.getDependencyResults()

    try {
      const processResult: T["_resultType"] = await this.task.process({ status, dependencyResults, statusOnly: false })
      this.task.emit("processed", { result: processResult })
      if (processResult.state === "ready") {
        const msg = `${this.task.getDescription()} is ready.`
        this.statusOnly || this.task.type === "resolve-action" ? this.task.log.debug(msg) : this.task.log.verbose(msg)
      }
      return processResult
    } catch (error) {
      this.task.emit("processed", { error })
      throw error
    }
  }
}

@Profile()
export class StatusTaskNode<T extends Task = Task> extends TaskNode<T> {
  executionType = <NodeType>"status"

  describe() {
    return `resolving status for ${this.task.getDescription()}`
  }

  getDependencies() {
    const statusDeps = this.task.getStatusDependencies()
    // Note: We need to _process_ the status dependencies
    return statusDeps.map((task) => this.getNode("process", task))
  }

  async execute() {
    this.task.log.silly(`Executing node ${chalk.underline(this.getKey())}`)
    const dependencyResults = this.getDependencyResults()

    try {
      const result: T["_resultType"] = await this.task.getStatus({ statusOnly: this.statusOnly, dependencyResults })
      this.task.emit("statusResolved", { result })
      if (!this.task.force && result?.state === "ready") {
        const msg = `${this.task.getDescription()} status is ready.`
        this.statusOnly || this.task.type === "resolve-action" ? this.task.log.debug(msg) : this.task.log.verbose(msg)
      }
      return result
    } catch (error) {
      this.task.emit("statusResolved", { error })
      throw error
    }
  }
}

export function getNodeKey(task: Task, type: NodeType) {
  return `${task.getKey()}:${type}`
}

export type CompleteHandler<R extends ValidResultType> = (result: GraphResult<R>) => void

export interface CompleteTaskParams {
  startedAt: Date | null
  error: Error | null
  result: ValidResultType | null
  aborted: boolean
}

export interface GraphNodeErrorDetail extends GraphResult {
  node: TaskNode
  failedDependency?: TaskNode
}

export interface GraphNodeErrorParams extends GraphNodeErrorDetail {}

export class GraphNodeError extends GardenBaseError<GraphNodeErrorDetail> {
  type = "graph"

  constructor(params: GraphNodeErrorParams) {
    const { node, failedDependency, error } = params

    let message = ""

    if (failedDependency) {
      message = `${node.describe()} aborted because a dependency could not be completed:`

      let nextDep: TaskNode | null = failedDependency

      while (nextDep) {
        const result = nextDep.getResult()

        if (!result) {
          nextDep = null
        } else if (result?.aborted) {
          message += chalk.yellow(`\n↳ ${nextDep.describe()} [ABORTED]`)
          if (result.error instanceof GraphNodeError && result.error.detail?.failedDependency) {
            nextDep = result.error.detail.failedDependency
          } else {
            nextDep = null
          }
        } else if (result?.error) {
          message += chalk.red.bold(`\n↳ ${nextDep.describe()} [FAILED] - ${result.error.message}`)
          nextDep = null
        }
      }
    } else {
      message = `${node.describe()} failed: ${error}`
    }

    const wrappedErrors = isGardenError(error) ? [error] : []
    super({ message, detail: params, wrappedErrors, context: { taskType: node.task.type } })
  }

  aborted() {
    return this.detail?.aborted
  }
}
