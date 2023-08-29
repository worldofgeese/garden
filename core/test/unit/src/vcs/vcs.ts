/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import {
  VcsHandler,
  TreeVersions,
  TreeVersion,
  getModuleVersionString,
  writeTreeVersionFile,
  readTreeVersionFile,
  GetFilesParams,
  VcsFile,
  getResourceTreeCacheKey,
  hashModuleVersion,
  NamedModuleVersion,
  NamedTreeVersion,
  describeConfig,
  getConfigBasePath,
  getConfigFilePath,
  GetTreeVersionParams,
} from "../../../../src/vcs/vcs"
import { makeTestGardenA, makeTestGarden, getDataDir, TestGarden, defaultModuleConfig } from "../../../helpers"
import { expect } from "chai"
import cloneDeep from "fast-copy"

import { ModuleConfig } from "../../../../src/config/module"
import { GitHandler } from "../../../../src/vcs/git"
import { resolve, join } from "path"
import td from "testdouble"
import tmp from "tmp-promise"
import { realpath, readFile, writeFile, rm, rename } from "fs-extra"
import { DEFAULT_BUILD_TIMEOUT_SEC, GARDEN_VERSIONFILE_NAME, GardenApiVersion } from "../../../../src/constants"
import { defaultDotIgnoreFile, fixedProjectExcludes } from "../../../../src/util/fs"
import { createActionLog } from "../../../../src/logger/log-entry"
import { BaseActionConfig } from "../../../../src/actions/types"
import { TreeCache } from "../../../../src/cache"

export class TestVcsHandler extends VcsHandler {
  name = "test"
  private testTreeVersions: TreeVersions = {}

  async getRepoRoot() {
    return "/foo"
  }

  async getFiles(_: GetFilesParams): Promise<VcsFile[]> {
    return []
  }

  async getPathInfo() {
    return {
      branch: "main",
      commitHash: "acbdefg",
      originUrl: "git@github.com:garden-io/foo.git",
    }
  }

  override async getTreeVersion(params: GetTreeVersionParams) {
    return this.testTreeVersions[getConfigBasePath(params.config)] || super.getTreeVersion(params)
  }

  setTestTreeVersion(path: string, version: TreeVersion) {
    this.testTreeVersions[path] = version
  }

  setTestModuleVersion(path: string, version: TreeVersion) {
    this.testTreeVersions[path] = version
  }

  async ensureRemoteSource(): Promise<string> {
    return ""
  }

  async updateRemoteSource() {
    return
  }
}

describe("VcsHandler", () => {
  let handlerA: TestVcsHandler
  let gardenA: TestGarden

  beforeEach(async () => {
    gardenA = await makeTestGardenA()
    handlerA = new TestVcsHandler({
      garden: gardenA,
      projectRoot: gardenA.projectRoot,
      gardenDirPath: join(gardenA.projectRoot, ".garden"),
      ignoreFile: defaultDotIgnoreFile,
      cache: new TreeCache(),
    })
  })

  describe("getTreeVersion", () => {
    it("should sort the list of files in the returned version", async () => {
      const moduleConfig = await gardenA.resolveModule("module-a")
      handlerA.getFiles = async () => [
        { path: "c", hash: "c" },
        { path: "b", hash: "b" },
        { path: "d", hash: "d" },
      ]
      const version = await handlerA.getTreeVersion({
        log: gardenA.log,
        projectName: gardenA.projectName,
        config: moduleConfig,
      })
      expect(version.files).to.eql(["b", "c", "d"])
    })

    it("should not include the module config file in the file list", async () => {
      const moduleConfig = await gardenA.resolveModule("module-a")
      handlerA.getFiles = async () => [
        { path: moduleConfig.configPath!, hash: "c" },
        { path: "b", hash: "b" },
        { path: "d", hash: "d" },
      ]
      const version = await handlerA.getTreeVersion({
        log: gardenA.log,
        projectName: gardenA.projectName,
        config: moduleConfig,
      })
      expect(version.files).to.eql(["b", "d"])
    })

    it("should respect the include field, if specified", async () => {
      const projectRoot = getDataDir("test-projects", "include-exclude")
      const garden = await makeTestGarden(projectRoot)
      const moduleConfig = await garden.resolveModule("module-a")
      const handler = new GitHandler({
        garden,
        projectRoot: garden.projectRoot,
        gardenDirPath: garden.gardenDirPath,
        ignoreFile: garden.dotIgnoreFile,
        cache: garden.treeCache,
      })

      const version = await handler.getTreeVersion({
        log: gardenA.log,
        projectName: gardenA.projectName,
        config: moduleConfig,
      })

      expect(version.files).to.eql([
        resolve(moduleConfig.path, "somedir/yes.txt"),
        resolve(moduleConfig.path, "yes.txt"),
      ])
    })

    it("should respect the exclude field, if specified", async () => {
      const projectRoot = getDataDir("test-projects", "include-exclude")
      const garden = await makeTestGarden(projectRoot)
      const moduleConfig = await garden.resolveModule("module-b")
      const handler = new GitHandler({
        garden,
        projectRoot: garden.projectRoot,
        gardenDirPath: garden.gardenDirPath,
        ignoreFile: garden.dotIgnoreFile,
        cache: garden.treeCache,
      })

      const version = await handler.getTreeVersion({
        log: garden.log,
        projectName: garden.projectName,
        config: moduleConfig,
      })

      expect(version.files).to.eql([resolve(moduleConfig.path, "yes.txt")])
    })

    it("should respect both include and exclude fields, if specified", async () => {
      const projectRoot = getDataDir("test-projects", "include-exclude")
      const garden = await makeTestGarden(projectRoot)
      const moduleConfig = await garden.resolveModule("module-c")

      const handler = new GitHandler({
        garden,
        projectRoot: garden.projectRoot,
        gardenDirPath: garden.gardenDirPath,
        ignoreFile: garden.dotIgnoreFile,
        cache: garden.treeCache,
      })

      const version = await handler.getTreeVersion({
        log: garden.log,
        projectName: garden.projectName,
        config: moduleConfig,
      })

      expect(version.files).to.eql([resolve(moduleConfig.path, "yes.txt")])
    })

    it("should not be affected by changes to the module's garden.yml that don't affect the module config", async () => {
      const projectRoot = getDataDir("test-projects", "multiple-module-config")
      const garden = await makeTestGarden(projectRoot)
      const moduleConfigA1 = await garden.resolveModule("module-a1")
      const configPath = moduleConfigA1.configPath!
      const orgConfig = await readFile(configPath)

      try {
        const version1 = await garden.vcs.getTreeVersion({
          log: garden.log,
          projectName: garden.projectName,
          config: moduleConfigA1,
        })
        await writeFile(configPath, orgConfig + "\n---")
        const version2 = await garden.vcs.getTreeVersion({
          log: garden.log,
          projectName: garden.projectName,
          config: moduleConfigA1,
        })
        expect(version1).to.eql(version2)
      } finally {
        await writeFile(configPath, orgConfig)
      }
    })

    it("should apply project-level excludes if module's path is same as root and no include is set", async () => {
      td.replace(handlerA, "getFiles", async ({ exclude }: GetFilesParams) => {
        expect(exclude).to.eql(fixedProjectExcludes)
        return [{ path: "foo", hash: "abcdef" }]
      })
      const moduleConfig = await gardenA.resolveModule("module-a")
      moduleConfig.path = gardenA.projectRoot
      const result = await handlerA.getTreeVersion({
        log: gardenA.log,
        projectName: gardenA.projectName,
        config: moduleConfig,
      })
      expect(result.files).to.eql(["foo"])
    })

    it("should not apply project-level excludes if module's path is same as root but include is set", async () => {
      td.replace(handlerA, "getFiles", async ({ exclude }: GetFilesParams) => {
        expect(exclude).to.be.undefined
        return [{ path: "foo", hash: "abcdef" }]
      })
      const moduleConfig = await gardenA.resolveModule("module-a")
      moduleConfig.path = gardenA.projectRoot
      moduleConfig.include = ["foo"]
      const result = await handlerA.getTreeVersion({
        log: gardenA.log,
        projectName: gardenA.projectName,
        config: moduleConfig,
      })
      expect(result.files).to.eql(["foo"])
    })

    it("should not call getFiles is include: [] is set on the module", async () => {
      td.replace(handlerA, "getFiles", async () => {
        throw new Error("Nope!")
      })
      const moduleConfig = await gardenA.resolveModule("module-a")
      moduleConfig.include = []
      await handlerA.getTreeVersion({ log: gardenA.log, projectName: gardenA.projectName, config: moduleConfig })
    })

    it("should get a cached tree version if available", async () => {
      const moduleConfig = await gardenA.resolveModule("module-a")
      const cacheKey = getResourceTreeCacheKey(moduleConfig)

      const cachedResult = { contentHash: "abcdef", files: ["foo"] }
      handlerA["cache"].set(gardenA.log, cacheKey, cachedResult, ["foo", "bar"])

      const result = await handlerA.getTreeVersion({
        log: gardenA.log,
        projectName: gardenA.projectName,
        config: moduleConfig,
      })
      expect(result).to.eql(cachedResult)
    })

    it("should cache the resolved version", async () => {
      const moduleConfig = await gardenA.resolveModule("module-a")
      const cacheKey = getResourceTreeCacheKey(moduleConfig)

      const result = await handlerA.getTreeVersion({
        log: gardenA.log,
        projectName: gardenA.projectName,
        config: moduleConfig,
      })
      const cachedResult = handlerA["cache"].get(gardenA.log, cacheKey)

      expect(result).to.eql(cachedResult)
    })

    it("should update content hash when include is set and there's a change in included files of module", async () => {
      const projectRoot = getDataDir("test-projects", "include-exclude")
      const garden = await makeTestGarden(projectRoot)
      const moduleConfigA1 = await garden.resolveModule("module-a")
      const newFilePathModuleA = join(garden.projectRoot, "module-a", "somedir", "foo")
      try {
        const version1 = await garden.vcs.getTreeVersion({
          log: garden.log,
          projectName: garden.projectName,
          config: moduleConfigA1,
        })
        await writeFile(newFilePathModuleA, "abcd")
        const version2 = await garden.vcs.getTreeVersion({
          log: garden.log,
          projectName: garden.projectName,
          config: moduleConfigA1,
          force: true,
        })
        expect(version1).to.not.eql(version2)
      } finally {
        await rm(newFilePathModuleA)
      }
    })

    it("should not update content hash for Deploy, when there's no change in included files of Build", async () => {
      const projectRoot = getDataDir("test-projects", "config-action-include")
      const garden = await makeTestGarden(projectRoot)
      const log = createActionLog({ log: garden.log, actionName: "", actionKind: "" })
      const graph = await garden.getConfigGraph({ emit: false, log })
      const build = graph.getActionByRef("build.test-build")
      const deploy = graph.getActionByRef("deploy.test-deploy")
      const resolvedBuild = await garden.resolveAction({ action: build, graph, log })
      const resolvedDeploy = await garden.resolveAction({ action: deploy, graph, log })
      const newFilePath = join(garden.projectRoot, "foo")
      try {
        const buildVersion1 = await garden.vcs.getTreeVersion({
          log: garden.log,
          projectName: garden.projectName,
          config: resolvedBuild.getConfig(),
        })

        const deployVersion1 = await garden.vcs.getTreeVersion({
          log: garden.log,
          projectName: garden.projectName,
          config: resolvedDeploy.getConfig(),
        })
        await writeFile(newFilePath, "abcd")

        const buildVersion2 = await garden.vcs.getTreeVersion({
          log: garden.log,
          projectName: garden.projectName,
          config: resolvedBuild.getConfig(),
          force: true,
        })
        const deployVersion2 = await garden.vcs.getTreeVersion({
          log: garden.log,
          projectName: garden.projectName,
          config: resolvedDeploy.getConfig(),
          force: true,
        })

        expect(buildVersion1).to.eql(buildVersion2)
        expect(deployVersion1.contentHash).to.eql(deployVersion2.contentHash)
      } finally {
        await rm(newFilePath)
      }
    })

    it("should update content hash, when a file is renamed", async () => {
      const projectRoot = getDataDir("test-projects", "include-exclude")
      const garden = await makeTestGarden(projectRoot)
      const newFilePathModuleA = join(garden.projectRoot, "module-a", "somedir", "foo")
      const renamedFilePathModuleA = join(garden.projectRoot, "module-a", "somedir", "bar")
      try {
        await writeFile(newFilePathModuleA, "abcd")
        const moduleConfigA1 = await garden.resolveModule("module-a")
        const version1 = await garden.vcs.getTreeVersion({
          log: garden.log,
          projectName: garden.projectName,
          config: moduleConfigA1,
        })
        // rename file foo to bar
        await rename(newFilePathModuleA, renamedFilePathModuleA)
        const version2 = await garden.vcs.getTreeVersion({
          log: garden.log,
          projectName: garden.projectName,
          config: moduleConfigA1,
          force: true,
        })
        expect(version1).to.not.eql(version2)
      } finally {
        await rm(renamedFilePathModuleA)
      }
    })
  })
})

describe("getModuleVersionString", () => {
  const namedVersionA: NamedModuleVersion = {
    name: "module-a",
    contentHash: "qwerty",
    versionString: "qwerty",
    dependencyVersions: {},
    files: [],
  }
  const treeVersionA: NamedTreeVersion = {
    name: namedVersionA.name,
    contentHash: namedVersionA.versionString,
    files: [],
  }
  const namedVersionB: NamedModuleVersion = {
    name: "module-b",
    contentHash: "qwerty",
    versionString: "qwerty",
    dependencyVersions: { "module-a": namedVersionA.versionString },
    files: [],
  }

  const namedVersionC: NamedModuleVersion = {
    name: "module-c",
    contentHash: "qwerty",
    versionString: "qwerty",
    dependencyVersions: { "module-b": namedVersionB.versionString },
    files: [],
  }

  const dependencyVersions: NamedModuleVersion[] = [namedVersionB, namedVersionC]
  const dummyTreeVersion = { name: "module-a", contentHash: "00000000000", files: [] }

  it("should return a different version for a module when a variable used by it changes", async () => {
    const templateGarden = await makeTestGarden(getDataDir("test-project-variable-versioning"))
    templateGarden["cacheKey"] = "" // Disable caching of the config graph
    const before = await templateGarden.resolveModule("module-a")

    templateGarden.variables["echo-string"] = "something-else"

    const after = await templateGarden.resolveModule("module-a")

    expect(getModuleVersionString(before, dummyTreeVersion, [])).to.not.eql(
      getModuleVersionString(after, dummyTreeVersion, [])
    )
  })

  it("should return the same version for a module when a variable not used by it changes", async () => {
    const templateGarden = await makeTestGarden(getDataDir("test-project-variable-versioning"))
    templateGarden["cacheKey"] = "" // Disable caching of the config graph
    const before = await templateGarden.resolveModule("module-a")

    templateGarden.variables["bla"] = "ble"

    const after = await templateGarden.resolveModule("module-a")

    expect(getModuleVersionString(before, dummyTreeVersion, [])).to.eql(
      getModuleVersionString(after, dummyTreeVersion, [])
    )
  })

  it("is stable with respect to key order in moduleConfig", async () => {
    const originalConfig = defaultModuleConfig
    const stirredConfig: any = cloneDeep(originalConfig)
    delete stirredConfig.name
    stirredConfig.name = originalConfig.name

    expect(getModuleVersionString(originalConfig, treeVersionA, dependencyVersions)).to.eql(
      getModuleVersionString(stirredConfig, treeVersionA, dependencyVersions)
    )
  })

  it("is stable with respect to dependency version order", async () => {
    const config = defaultModuleConfig

    expect(getModuleVersionString(config, treeVersionA, [namedVersionB, namedVersionC])).to.eql(
      getModuleVersionString(config, treeVersionA, [namedVersionC, namedVersionB])
    )
  })

  it("should be stable between runtimes", async () => {
    const projectRoot = getDataDir("test-projects", "fixed-version-hashes-1")

    // fixed-version-hashes-1 expects this var to be set
    process.env.MODULE_A_TEST_ENV_VAR = "foo"

    const garden = await makeTestGarden(projectRoot, { noCache: true })
    const module = await garden.resolveModule("module-a")

    const fixedVersionString = "v-e3eed855ed"
    expect(module.version.versionString).to.eql(fixedVersionString)

    delete process.env.TEST_ENV_VAR
  })
})

describe("writeTreeVersionFile", () => {
  let tmpDir: tmp.DirectoryResult
  let tmpPath: string

  beforeEach(async () => {
    tmpDir = await tmp.dir({ unsafeCleanup: true })
    tmpPath = await realpath(tmpDir.path)
  })

  afterEach(async () => {
    await tmpDir.cleanup()
  })

  describe("writeVersionFile", () => {
    it("should write relative paths for files", async () => {
      await writeTreeVersionFile(tmpPath, {
        contentHash: "foo",
        files: [join(tmpPath, "some", "file")],
      })
      expect(await readTreeVersionFile(join(tmpPath, GARDEN_VERSIONFILE_NAME))).to.eql({
        contentHash: "foo",
        files: ["some/file"],
      })
    })

    it("should handle relative paths in input", async () => {
      await writeTreeVersionFile(tmpPath, {
        contentHash: "foo",
        files: ["some/file"],
      })
      expect(await readTreeVersionFile(join(tmpPath, GARDEN_VERSIONFILE_NAME))).to.eql({
        contentHash: "foo",
        files: ["some/file"],
      })
    })

    it("should normalize Windows-style paths to POSIX-style", async () => {
      await writeTreeVersionFile(tmpPath, {
        contentHash: "foo",
        files: [`some\\file`],
      })
      expect(await readTreeVersionFile(join(tmpPath, GARDEN_VERSIONFILE_NAME))).to.eql({
        contentHash: "foo",
        files: ["some/file"],
      })
    })
  })
})

describe("hashModuleVersion", () => {
  function baseConfig(): ModuleConfig {
    return {
      apiVersion: GardenApiVersion.v0,
      type: "test",
      path: "/tmp",
      name: "foo",
      allowPublish: false,
      build: { dependencies: [], timeout: DEFAULT_BUILD_TIMEOUT_SEC },
      disabled: false,
      serviceConfigs: [],
      taskConfigs: [],
      testConfigs: [],
      spec: {},
    }
  }

  context("buildConfig is set", () => {
    it("only uses the buildConfig for the module config hash", () => {
      const config = {
        ...baseConfig(),
        buildConfig: {
          something: "build specific",
        },
      }
      const a = hashModuleVersion(config, { name: "foo", contentHash: "abcdefabced", files: [] }, [])
      const b = hashModuleVersion(
        {
          ...config,
          serviceConfigs: [{ name: "bla", dependencies: [], disabled: false, spec: {} }],
          taskConfigs: [{ name: "bla", dependencies: [], disabled: false, spec: {}, timeout: 123, cacheResult: false }],
          testConfigs: [{ name: "bla", dependencies: [], disabled: false, spec: {}, timeout: 123 }],
          spec: { foo: "bar" },
        },
        { name: "foo", contentHash: "abcdefabced", files: [] },
        []
      )
      expect(a).to.equal(b)
    })

    it("factors in dependency versions", () => {
      const config = {
        ...baseConfig(),
        buildConfig: {
          something: "build specific",
        },
      }
      const a = hashModuleVersion(config, { name: "foo", contentHash: "abcdefabced", files: [] }, [])
      const b = hashModuleVersion(config, { name: "foo", contentHash: "abcdefabced", files: [] }, [
        { name: "dep", contentHash: "abcdefabced", versionString: "blabalbalba", files: [], dependencyVersions: {} },
      ])
      expect(a).to.not.equal(b)
    })
  })

  context("buildConfig is not set", () => {
    it("is affected by changes to the spec field", () => {
      const config = {
        ...baseConfig(),
      }
      const a = hashModuleVersion(config, { name: "foo", contentHash: "abcdefabced", files: [] }, [])
      const b = hashModuleVersion(
        {
          ...config,
          spec: { foo: "bar" },
        },
        { name: "foo", contentHash: "abcdefabced", files: [] },
        []
      )
      expect(a).to.not.equal(b)
    })

    it("omits generally-considered runtime fields", () => {
      const config = {
        ...baseConfig(),
      }
      const a = hashModuleVersion(config, { name: "foo", contentHash: "abcdefabced", files: [] }, [])
      const b = hashModuleVersion(
        {
          ...config,
          serviceConfigs: [{ name: "bla", dependencies: [], disabled: false, spec: {} }],
          taskConfigs: [{ name: "bla", dependencies: [], disabled: false, spec: {}, timeout: 123, cacheResult: false }],
          testConfigs: [{ name: "bla", dependencies: [], disabled: false, spec: {}, timeout: 123 }],
        },
        { name: "foo", contentHash: "abcdefabced", files: [] },
        []
      )
      expect(a).to.equal(b)
    })

    it("factors in dependency versions", () => {
      const config = {
        ...baseConfig(),
      }
      const a = hashModuleVersion(config, { name: "foo", contentHash: "abcdefabced", files: [] }, [])
      const b = hashModuleVersion(config, { name: "foo", contentHash: "abcdefabced", files: [] }, [
        { name: "dep", contentHash: "abcdefabced", versionString: "blabalbalba", files: [], dependencyVersions: {} },
      ])
      expect(a).to.not.equal(b)
    })
  })
})

describe("helpers", () => {
  context("BaseActionConfig", () => {
    const baseActionConfig: BaseActionConfig = {
      internal: { basePath: "/path/to/build-action", configFilePath: "/path/to/build-action/garden.yml" },
      kind: "Build",
      name: "build-action",
      spec: {},
      type: "",
      timeout: DEFAULT_BUILD_TIMEOUT_SEC,
    }

    it("getConfigFilePath", () => {
      const configFilePath = getConfigFilePath(baseActionConfig)
      expect(configFilePath).to.equal(baseActionConfig.internal.configFilePath)
    })

    it("getConfigBasePath", () => {
      const configBasePath = getConfigBasePath(baseActionConfig)
      expect(configBasePath).to.equal(baseActionConfig.internal.basePath)
    })

    it("describeConfig", () => {
      const configDescription = describeConfig(baseActionConfig)
      expect(configDescription).to.equal(`${baseActionConfig.kind} action ${baseActionConfig.name}`)
    })
  })

  context("ModuleConfig", () => {
    const moduleConfig: ModuleConfig = {
      allowPublish: false,
      apiVersion: GardenApiVersion.v0,
      build: { dependencies: [], timeout: DEFAULT_BUILD_TIMEOUT_SEC },
      disabled: false,
      name: "module-a",
      path: "/path/to/module/a",
      configPath: "/path/to/module/a/garden.yml",
      serviceConfigs: [],
      spec: undefined,
      taskConfigs: [],
      testConfigs: [],
      type: "",
    }

    it("getConfigFilePath", () => {
      const configFilePath = getConfigFilePath(moduleConfig)
      expect(configFilePath).to.equal(moduleConfig.configPath)
    })

    it("getConfigBasePath", () => {
      const configBasePath = getConfigBasePath(moduleConfig)
      expect(configBasePath).to.equal(moduleConfig.path)
    })

    it("describeConfig", () => {
      const configDescription = describeConfig(moduleConfig)
      expect(configDescription).to.equal(`module ${moduleConfig.name}`)
    })
  })
})
