/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { performance } from "perf_hooks"
import { isAbsolute, join, posix, relative, resolve } from "path"
import { isString } from "lodash"
import { createReadStream, ensureDir, lstat, pathExists, readlink, realpath, stat, Stats } from "fs-extra"
import { PassThrough } from "stream"
import { GetFilesParams, RemoteSourceParams, VcsFile, VcsHandler, VcsHandlerParams, VcsInfo } from "./vcs"
import { ConfigurationError, RuntimeError } from "../exceptions"
import { getStatsType, joinWithPosix, matchPath } from "../util/fs"
import { dedent, deline, splitLast } from "../util/string"
import { defer, exec } from "../util/util"
import { Log } from "../logger/log-entry"
import parseGitConfig from "parse-git-config"
import { getDefaultProfiler, Profile, Profiler } from "../util/profiling"
import { STATIC_DIR } from "../constants"
import split2 = require("split2")
import execa = require("execa")
import isGlob from "is-glob"
import chalk from "chalk"
import hasha = require("hasha")
import { pMemoizeDecorator } from "../lib/p-memoize"
import AsyncLock from "async-lock"
import PQueue from "p-queue"

const gitConfigAsyncLock = new AsyncLock()

const submoduleErrorSuggestion = `Perhaps you need to run ${chalk.underline(`git submodule update --recursive`)}?`
const currentPlatformName = process.platform

const gitSafeDirs = new Set<string>()
let gitSafeDirsRead = false
let staticDirSafe = false

interface GitEntry extends VcsFile {
  mode: string
}

export function getCommitIdFromRefList(refList: string[]): string {
  try {
    return refList[0].split("\t")[0]
  } catch (err) {
    return refList[0]
  }
}

export function parseGitUrl(url: string) {
  const parts = splitLast(url, "#")
  if (!parts[0]) {
    throw new ConfigurationError({
      message: deline`
        Repository URLs must contain a hash part pointing to a specific branch or tag
        (e.g. https://github.com/org/repo.git#main)`,
      detail: { repositoryUrl: url },
    })
  }
  const parsed = { repositoryUrl: parts[0], hash: parts[1] }
  return parsed
}

export interface GitCli {
  (...args: (string | undefined)[]): Promise<string[]>
}

interface Submodule {
  path: string
  url: string
}

// TODO Consider moving git commands to separate (and testable) functions
@Profile()
export class GitHandler extends VcsHandler {
  name = "git"
  repoRoots = new Map()
  profiler: Profiler
  protected lock: AsyncLock

  constructor(params: VcsHandlerParams) {
    super(params)
    this.profiler = getDefaultProfiler()
    this.lock = new AsyncLock()
  }

  gitCli(log: Log, cwd: string, failOnPrompt = false): GitCli {
    return async (...args: (string | undefined)[]) => {
      log.silly(`Calling git with args '${args.join(" ")}' in ${cwd}`)
      const { stdout } = await exec("git", args.filter(isString), {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        env: failOnPrompt ? { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" } : undefined,
      })
      return stdout.split("\n").filter((line) => line.length > 0)
    }
  }

  private async getModifiedFiles(git: GitCli, path: string) {
    try {
      return await git("diff-index", "--name-only", "HEAD", path)
    } catch (err) {
      if (err.exitCode === 128) {
        // no commit in repo
        return []
      } else {
        throw err
      }
    }
  }

  toGitConfigCompatiblePath(path: string, platformName: string): string {
    // Windows paths require some pre-processing,
    // see the full list of platform names here: https://nodejs.org/api/process.html#process_process_platform
    if (platformName !== "win32") {
      return path
    }

    // Replace back-slashes with forward-slashes to make paths compatible with .gitconfig in Windows
    return path.replace(/\\/g, "/")
  }

  // TODO-0.13.1+ - get rid of this in/after https://github.com/garden-io/garden/pull/4047
  /**
   * Checks if a given {@code path} is a valid and safe Git repository.
   * If it is a valid Git repository owned by another user,
   * then the static dir will be added to the list of safe directories in .gitconfig.
   *
   * Git has stricter repository ownerships checks since 2.36.0,
   * see https://github.blog/2022-04-18-highlights-from-git-2-36/ for more details.
   */
  private async ensureSafeDirGitRepo(log: Log, path: string, failOnPrompt = false): Promise<void> {
    if (gitSafeDirs.has(path)) {
      return
    }

    // Avoid multiple concurrent checks on the same path
    await this.lock.acquire(`safe-dir:${path}`, async () => {
      if (gitSafeDirs.has(path)) {
        return
      }

      const git = this.gitCli(log, path, failOnPrompt)

      if (!gitSafeDirsRead) {
        await gitConfigAsyncLock.acquire(".gitconfig", async () => {
          if (!gitSafeDirsRead) {
            const gitCli = this.gitCli(log, path, failOnPrompt)
            try {
              const safeDirectories = await gitCli("config", "--get-all", "safe.directory")
              safeDirectories.forEach((safeDir) => gitSafeDirs.add(safeDir))
            } catch (err) {
              // ignore the error if there are no safe directories defined
              log.debug(`Error reading safe directories from the .gitconfig: ${err}`)
            }
            gitSafeDirsRead = true
          }
        })
      }

      try {
        await git("status")
        gitSafeDirs.add(path)
      } catch (err) {
        // Git has stricter repo ownerships checks since 2.36.0
        if (err.exitCode === 128 && err.stderr?.toLowerCase().includes("fatal: unsafe repository")) {
          log.warn(
            chalk.yellow(
              `It looks like you're using Git 2.36.0 or newer and the directory "${path}" is owned by someone else. It will be added to safe.directory list in the .gitconfig.`
            )
          )

          if (!gitSafeDirs.has(path)) {
            await gitConfigAsyncLock.acquire(".gitconfig", async () => {
              if (!gitSafeDirs.has(path)) {
                const gitConfigCompatiblePath = this.toGitConfigCompatiblePath(path, currentPlatformName)
                // Add the safe directory globally to be able to run git command outside a (trusted) git repo
                // Wrap the path in quotes to pass it as a single argument in case if it contains any whitespaces
                await git("config", "--global", "--add", "safe.directory", `'${gitConfigCompatiblePath}'`)
                gitSafeDirs.add(path)
                log.debug(`Configured git to trust repository in ${path}`)
              }
            })
          }

          return
        } else if (err.exitCode === 128 && err.stderr?.toLowerCase().includes("fatal: not a git repository")) {
          throw new RuntimeError({ message: notInRepoRootErrorMessage(path), detail: { path } })
        } else {
          log.error(
            `Unexpected Git error occurred while running 'git status' from path "${path}". Exit code: ${err.exitCode}. Error message: ${err.stderr}`
          )
          throw err
        }
      }
      gitSafeDirs.add(path)
    })
  }

  async getRepoRoot(log: Log, path: string, failOnPrompt = false) {
    if (this.repoRoots.has(path)) {
      return this.repoRoots.get(path)
    }

    // Make sure we're not asking concurrently for the same root
    return this.lock.acquire(`repo-root:${path}`, async () => {
      if (this.repoRoots.has(path)) {
        return this.repoRoots.get(path)
      }

      // TODO-0.13.1+ - get rid of this in/after https://github.com/garden-io/garden/pull/4047
      if (!staticDirSafe) {
        staticDirSafe = true
        await this.ensureSafeDirGitRepo(log, STATIC_DIR, failOnPrompt)
      }

      const git = this.gitCli(log, path, failOnPrompt)

      try {
        const repoRoot = (await git("rev-parse", "--show-toplevel"))[0]
        this.repoRoots.set(path, repoRoot)
        return repoRoot
      } catch (err) {
        if (err.exitCode === 128 && err.stderr?.toLowerCase().includes("fatal: unsafe repository")) {
          // Throw nice error when we detect that we're not in a repo root
          throw new RuntimeError({
            message:
              err.stderr +
              `\nIt looks like you're using Git 2.36.0 or newer and the repo directory containing "${path}" is owned by someone else. If this is intentional you can run "git config --global --add safe.directory '<repo root>'" and try again.`,
            detail: { path },
          })
        } else if (err.exitCode === 128) {
          // Throw nice error when we detect that we're not in a repo root
          throw new RuntimeError({ message: notInRepoRootErrorMessage(path), detail: { path, exitCode: err.exitCode } })
        } else {
          throw err
        }
      }
    })
  }

  /**
   * Returns a list of files, along with file hashes, under the given path, taking into account the configured
   * .ignore files, and the specified include/exclude filters.
   */
  async getFiles(params: GetFilesParams): Promise<VcsFile[]> {
    return this._getFiles(params)
  }

  /**
   * In order for `GitRepoHandler` not to enter infinite recursion when scanning submodules,
   * we need to name the function that recurses in here differently from `getFiles` so that `this.getFiles` won't refer
   * to the method in the subclass.
   */
  async _getFiles({
    log,
    path,
    pathDescription = "directory",
    include,
    exclude,
    filter,
    failOnPrompt = false,
  }: GetFilesParams): Promise<VcsFile[]> {
    if (include && include.length === 0) {
      // No need to proceed, nothing should be included
      return []
    }

    if (!exclude) {
      exclude = []
    }
    // Make sure action config is not mutated
    exclude = [...exclude, "**/.garden/**/*"]

    const gitLog = log
      .createLog({ name: "git" })
      .debug(
        `Scanning ${pathDescription} at ${path}\n  → Includes: ${include || "(none)"}\n  → Excludes: ${
          exclude || "(none)"
        }`
      )

    try {
      const pathStats = await stat(path)

      if (!pathStats.isDirectory()) {
        gitLog.warn(`Expected directory at ${path}, but found ${getStatsType(pathStats)}.`)
        return []
      }
    } catch (err) {
      // 128 = File no longer exists
      if (err.exitCode === 128 || err.code === "ENOENT") {
        gitLog.warn(`Attempted to scan directory at ${path}, but it does not exist.`)
        return []
      } else {
        throw err
      }
    }

    let files: VcsFile[] = []

    const git = this.gitCli(gitLog, path, failOnPrompt)
    const gitRoot = await this.getRepoRoot(gitLog, path, failOnPrompt)

    // List modified files, so that we can ensure we have the right hash for them later
    const modified = new Set(
      (await this.getModifiedFiles(git, path))
        // The output here is relative to the git root, and not the directory `path`
        .map((modifiedRelPath) => resolve(gitRoot, modifiedRelPath))
    )

    const absExcludes = exclude.map((p) => resolve(path, p))

    // Apply the include patterns to the ls-files queries. We use the --glob-pathspecs flag
    // to make sure the path handling is consistent with normal POSIX-style globs used generally by Garden.

    // Due to an issue in git, we can unfortunately only use _either_ include or exclude patterns in the
    // ls-files commands, but not both. Trying both just ignores the exclude patterns.

    if (include?.includes("**/*")) {
      // This is redundant
      include = undefined
    }

    const hasIncludes = !!include?.length

    const globalArgs = ["--glob-pathspecs"]
    const lsFilesCommonArgs = ["--cached", "--exclude", this.gardenDirPath]

    if (!hasIncludes) {
      for (const p of exclude) {
        lsFilesCommonArgs.push("--exclude", p)
      }
    }

    // List tracked but ignored files (we currently exclude those as well, so we need to query that specially)
    const trackedButIgnored = new Set(
      !this.ignoreFile
        ? []
        : await git(
            ...globalArgs,
            "ls-files",
            "--ignored",
            ...lsFilesCommonArgs,
            "--exclude-per-directory",
            this.ignoreFile
          )
    )

    // List all submodule paths in the current path
    const submodules = await this.getSubmodules(path)
    const submodulePaths = submodules.map((s) => join(gitRoot, s.path))
    if (submodules.length > 0) {
      gitLog.silly(`Submodules listed at ${submodules.map((s) => `${s.path} (${s.url})`).join(", ")}`)
    }

    let submoduleFiles: Promise<VcsFile[]>[] = []

    // We start processing submodule paths in parallel
    // and don't await the results until this level of processing is completed
    if (submodulePaths.length > 0) {
      // Need to automatically add `**/*` to directory paths, to match git behavior when filtering.
      const augmentedIncludes = await augmentGlobs(path, include)
      const augmentedExcludes = await augmentGlobs(path, exclude)

      // Resolve submodules
      // TODO: see about optimizing this, avoiding scans when we're sure they'll not match includes/excludes etc.
      submoduleFiles = submodulePaths.map(async (submodulePath) => {
        if (!submodulePath.startsWith(path) || absExcludes?.includes(submodulePath)) {
          return []
        }

        // Note: We apply include/exclude filters after listing files from submodule
        const submoduleRelPath = relative(path, submodulePath)

        // Catch and show helpful message in case the submodule path isn't a valid directory
        try {
          const pathStats = await stat(path)

          if (!pathStats.isDirectory()) {
            const pathType = getStatsType(pathStats)
            gitLog.warn(`Expected submodule directory at ${path}, but found ${pathType}. ${submoduleErrorSuggestion}`)
            return []
          }
        } catch (err) {
          // 128 = File no longer exists
          if (err.exitCode === 128 || err.code === "ENOENT") {
            gitLog.warn(
              `Found reference to submodule at ${submoduleRelPath}, but the path could not be found. ${submoduleErrorSuggestion}`
            )
            return []
          } else {
            throw err
          }
        }

        return this._getFiles({
          log: gitLog,
          path: submodulePath,
          pathDescription: "submodule",
          exclude: [],
          filter: (p) =>
            matchPath(join(submoduleRelPath, p), augmentedIncludes, augmentedExcludes) && (!filter || filter(p)),
          scanRoot: submodulePath,
          failOnPrompt,
        })
      })
    }

    // Make sure we have a fresh hash for each file
    let count = 0

    const ensureHash = async (file: VcsFile, stats: Stats | undefined): Promise<void> => {
      if (file.hash === "" || modified.has(file.path)) {
        // Don't attempt to hash directories. Directories (which will only come up via symlinks btw)
        // will by extension be filtered out of the list.
        if (stats && !stats.isDirectory()) {
          const hash = await this.hashObject(stats, file.path)
          if (hash !== "") {
            file.hash = hash
            count++
            files.push(file)
            return
          }
        }
      }
      count++
      files.push(file)
    }

    // This function is called for each line output from the ls-files commands that we run, and populates the
    // `files` array.
    const handleEntry = async (entry: GitEntry | undefined): Promise<void> => {
      if (!entry) {
        return
      }

      let { path: filePath, hash } = entry

      // Check filter function, if provided
      if (filter && !filter(filePath)) {
        return
      }
      // Ignore files that are tracked but still specified in ignore files
      if (trackedButIgnored.has(filePath)) {
        return
      }

      const resolvedPath = resolve(path, filePath)

      // Filter on excludes and submodules
      if (submodulePaths.includes(resolvedPath)) {
        return
      }

      if (hasIncludes && !matchPath(filePath, undefined, exclude)) {
        return
      }

      // We push to the output array if it passes through the exclude filters.
      const output = { path: resolvedPath, hash: hash || "" }

      // No need to stat unless it has no hash, is a symlink, or is modified
      // Note: git ls-files always returns mode 120000 for symlinks
      if (hash && entry.mode !== "120000" && !modified.has(resolvedPath)) {
        return ensureHash(output, undefined)
      }

      try {
        const stats = await lstat(resolvedPath)
        // We need to special-case handling of symlinks. We disallow any "unsafe" symlinks, i.e. any ones that may
        // link outside of `gitRoot`.
        if (stats.isSymbolicLink()) {
          const target = await readlink(resolvedPath)

          // Make sure symlink is relative and points within `path`
          if (isAbsolute(target)) {
            gitLog.verbose(`Ignoring symlink with absolute target at ${resolvedPath}`)
            return
          } else if (target.startsWith("..")) {
            try {
              const realTarget = await realpath(resolvedPath)
              const relPath = relative(path, realTarget)

              if (relPath.startsWith("..")) {
                gitLog.verbose(`Ignoring symlink pointing outside of ${pathDescription} at ${resolvedPath}`)
                return
              }
              return ensureHash(output, stats)
            } catch (err) {
              if (err.code === "ENOENT") {
                gitLog.verbose(`Ignoring dead symlink at ${resolvedPath}`)
                return
              }
              throw err
            }
          } else {
            return ensureHash(output, stats)
          }
        } else {
          return ensureHash(output, stats)
        }
      } catch (err) {
        if (err.code === "ENOENT") {
          return
        }
        throw err
      }
    }

    const queue = new PQueue()
    // Prepare args
    const args = [...globalArgs, "ls-files", "-s", "--others", ...lsFilesCommonArgs]
    if (this.ignoreFile) {
      args.push("--exclude-per-directory", this.ignoreFile)
    }
    args.push(...(include || []))

    // Start git process
    gitLog.silly(`Calling git with args '${args.join(" ")}' in ${path}`)
    let processEnded = defer<void>()

    const proc = execa("git", args, { cwd: path, buffer: false })
    const splitStream = split2()

    // Stream
    const fail = (err: Error) => {
      proc.kill()
      splitStream.end()
      processEnded.reject(err)
    }

    splitStream.on("data", async (line) => {
      try {
        await queue.add(() => {
          return handleEntry(parseLine(line))
        })
      } catch (err) {
        fail(err)
      }
    })

    proc.stdout?.pipe(splitStream)

    void proc.on("error", (err: execa.ExecaError) => {
      if (err.exitCode !== 128) {
        fail(err)
      }
    })

    void splitStream.on("end", () => {
      processEnded.resolve()
    })

    // The stream that adds files to be processed has started
    // We wait until the process is completed and then
    // we wait until the queue is empty
    // After that we're done with all possible files to be processed
    await processEnded.promise
    await queue.onIdle()

    gitLog.debug(`Found ${count} files in ${pathDescription} ${path}`)

    // We have done the processing of this level of files
    // So now we just have to wait for all the recursive submodules to resolve as well
    // before we can return
    const resolvedSubmoduleFiles = await Promise.all(submoduleFiles)

    files = [...files, ...resolvedSubmoduleFiles.flat()]

    return files
  }

  private isHashSHA1(hash: string): boolean {
    const SHA1RegExp = new RegExp(/\b([a-f0-9]{40})\b/)
    return SHA1RegExp.test(hash)
  }

  private async cloneRemoteSource(
    log: Log,
    repositoryUrl: string,
    hash: string,
    absPath: string,
    failOnPrompt = false
  ) {
    await ensureDir(absPath)
    const git = this.gitCli(log, absPath, failOnPrompt)
    // Use `--recursive` to include submodules
    if (!this.isHashSHA1(hash)) {
      return git(
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--recursive",
        "--depth=1",
        "--shallow-submodules",
        `--branch=${hash}`,
        repositoryUrl,
        "."
      )
    }

    // If SHA1 is used we need to fetch the changes as git clone doesn't allow to shallow clone
    // a specific hash
    try {
      await git("init")
      await git("remote", "add", "origin", repositoryUrl)
      await git("-c", "protocol.file.allow=always", "fetch", "--depth=1", "--recurse-submodules=yes", "origin", hash)
      await git("checkout", "FETCH_HEAD")
      return git("-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive")
    } catch (err) {
      throw new RuntimeError({
        message: dedent`Failed to shallow clone with error: \n\n${err}
      Make sure both git client and server are newer than 2.5.0 and that \`uploadpack.allowReachableSHA1InWant=true\`
      is set on the server`,
        detail: {
          message: err.message,
        },
      })
    }
  }

  // TODO Better auth handling
  async ensureRemoteSource({ url, name, log, sourceType, failOnPrompt = false }: RemoteSourceParams): Promise<string> {
    return this.getRemoteSourceLock(sourceType, name, async () => {
      const remoteSourcesPath = this.getRemoteSourcesLocalPath(sourceType)
      await ensureDir(remoteSourcesPath)

      const absPath = this.getRemoteSourceLocalPath(name, url, sourceType)
      const isCloned = await pathExists(absPath)

      if (!isCloned) {
        const gitLog = log.createLog({ name, showDuration: true }).info(`Fetching from ${url}`)
        const { repositoryUrl, hash } = parseGitUrl(url)

        try {
          await this.cloneRemoteSource(log, repositoryUrl, hash, absPath, failOnPrompt)
        } catch (err) {
          gitLog.error(`Failed fetching from ${url}`)
          throw new RuntimeError({
            message: `Downloading remote ${sourceType} failed with error: \n\n${err}`,
            detail: {
              repositoryUrl: url,
              message: err.message,
            },
          })
        }

        gitLog.success("Done")
      }

      return absPath
    })
  }

  async updateRemoteSource({ url, name, sourceType, log, failOnPrompt = false }: RemoteSourceParams) {
    const absPath = this.getRemoteSourceLocalPath(name, url, sourceType)
    const git = this.gitCli(log, absPath, failOnPrompt)
    const { repositoryUrl, hash } = parseGitUrl(url)

    await this.ensureRemoteSource({ url, name, sourceType, log, failOnPrompt })

    await this.getRemoteSourceLock(sourceType, name, async () => {
      const gitLog = log.createLog({ name, showDuration: true }).info("Getting remote state")
      await git("remote", "update")

      const localCommitId = (await git("rev-parse", "HEAD"))[0]
      const remoteCommitId = this.isHashSHA1(hash)
        ? hash
        : getCommitIdFromRefList(await git("ls-remote", repositoryUrl, hash))

      if (localCommitId !== remoteCommitId) {
        gitLog.info(`Fetching from ${url}`)

        try {
          await git("fetch", "--depth=1", "origin", hash)
          await git("reset", "--hard", `origin/${hash}`)
          // Update submodules if applicable (no-op if no submodules in repo)
          await git("-c", "protocol.file.allow=always", "submodule", "update", "--recursive")
        } catch (err) {
          gitLog.error(`Failed fetching from ${url}`)
          throw new RuntimeError({
            message: `Updating remote ${sourceType} failed with error: \n\n${err}`,
            detail: {
              repositoryUrl: url,
              message: err.message,
            },
          })
        }

        gitLog.success("Source updated")
      } else {
        gitLog.success("Source already up to date")
      }
    })
  }

  private getRemoteSourceLock(sourceType: string, name: string, func: () => Promise<any>) {
    return this.lock.acquire(`remote-source-${sourceType}-${name}`, func)
  }

  /**
   * Replicates the `git hash-object` behavior. See https://stackoverflow.com/a/5290484/3290965
   * We deviate from git's behavior when dealing with symlinks, by hashing the target of the symlink and not the
   * symlink itself. If the symlink cannot be read, we hash the link contents like git normally does.
   */
  async hashObject(stats: Stats, path: string): Promise<string> {
    const start = performance.now()
    const hash = hasha.stream({ algorithm: "sha1" })

    if (stats.isSymbolicLink()) {
      // For symlinks, we follow git's behavior, which is to hash the link itself (i.e. the path it contains) as
      // opposed to the file/directory that it points to.
      try {
        const linkPath = await readlink(path)
        hash.update(`blob ${stats.size}\0${linkPath}`)
        hash.end()
        const output = hash.read()
        this.profiler.log("GitHandler#hashObject", start)
        return output
      } catch (err) {
        // Ignore errors here, just output empty hash
        this.profiler.log("GitHandler#hashObject", start)
        return ""
      }
    } else {
      const stream = new PassThrough()
      stream.push(`blob ${stats.size}\0`)

      const result = defer<string>()
      stream
        .on("error", () => {
          // Ignore file read error
          this.profiler.log("GitHandler#hashObject", start)
          result.resolve("")
        })
        .pipe(hash)
        .on("error", (err) => result.reject(err))
        .on("finish", () => {
          const output = hash.read()
          this.profiler.log("GitHandler#hashObject", start)
          result.resolve(output)
        })

      createReadStream(path).pipe(stream)

      return result.promise
    }
  }

  @pMemoizeDecorator()
  private async getSubmodules(gitModulesConfigPath: string) {
    const submodules: Submodule[] = []
    const gitmodulesPath = join(gitModulesConfigPath, ".gitmodules")

    if (await pathExists(gitmodulesPath)) {
      const parsed = await parseGitConfig({ cwd: gitModulesConfigPath, path: ".gitmodules" })

      for (const [key, spec] of Object.entries(parsed || {}) as any) {
        if (!key.startsWith("submodule")) {
          continue
        }
        spec.path && submodules.push(spec)
      }
    }

    return submodules
  }

  async getPathInfo(log: Log, path: string, failOnPrompt = false): Promise<VcsInfo> {
    const git = this.gitCli(log, path, failOnPrompt)

    const output: VcsInfo = {
      branch: "",
      commitHash: "",
      originUrl: "",
    }

    try {
      output.branch = (await git("rev-parse", "--abbrev-ref", "HEAD"))[0]
      output.commitHash = (await git("rev-parse", "HEAD"))[0]
    } catch (err) {
      if (err.exitCode !== 128) {
        throw err
      }
    }

    try {
      output.originUrl = (await git("config", "--get", "remote.origin.url"))[0]
    } catch (err) {
      // Just ignore if not available
      log.silly(`Tried to retrieve git remote.origin.url but encountered an error: ${err}`)
    }

    return output
  }
}

const notInRepoRootErrorMessage = (path: string) => deline`
    Path ${path} is not in a git repository root. Garden must be run from within a git repo.
    Please run \`git init\` if you're starting a new project and repository, or move the project to an
    existing repository, and try again.
  `

/**
 * Given a list of POSIX-style globs/paths and a `basePath`, find paths that point to a directory and append `**\/*`
 * to them, such that they'll be matched consistently between git and our internal pattern matching.
 */
export async function augmentGlobs(basePath: string, globs?: string[]) {
  if (!globs || globs.length === 0) {
    return globs
  }

  return Promise.all(
    globs.map(async (pattern) => {
      if (isGlob(pattern, { strict: false })) {
        // Pass globs through directly (they won't match a specific directory)
        return pattern
      }

      try {
        const isDir = (await stat(joinWithPosix(basePath, pattern))).isDirectory()
        return isDir ? posix.join(pattern, "**", "*") : pattern
      } catch {
        return pattern
      }
    })
  )
}

const parseLine = (data: Buffer): GitEntry | undefined => {
  const line = data.toString().trim()
  if (!line) {
    return undefined
  }

  let filePath: string
  let mode = ""
  let hash = ""

  const split = line.trim().split("\t")

  if (split.length === 1) {
    // File is untracked
    filePath = split[0]
  } else {
    filePath = split[1]
    const info = split[0].split(" ")
    mode = info[0]
    hash = info[1]
  }

  return { path: filePath, hash, mode }
}
