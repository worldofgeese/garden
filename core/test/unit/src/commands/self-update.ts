/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import finalhandler from "finalhandler"
import serveStatic from "serve-static"
import { expect } from "chai"
import { readdir } from "fs-extra"
import getPort from "get-port"
import { dirname } from "path"
import { ParameterValues } from "../../../../src/cli/params"
import {
  GitHubReleaseApi,
  isEdgeVersion,
  isPreReleaseVersion,
  SelfUpdateArgs,
  SelfUpdateCommand,
  SelfUpdateOpts,
  VersionScope,
} from "../../../../src/commands/self-update"
import { DummyGarden, makeDummyGarden } from "../../../../src/garden"
import { makeTempDir, TempDirectory } from "../../../../src/util/fs"
import { getPackageVersion } from "../../../../src/util/util"
import { getDataDir, withDefaultGlobalOpts } from "../../../helpers"
import { createServer, Server } from "http"
import semver from "semver"

describe("version helpers", () => {
  describe("isEdgeVersion", () => {
    it("should be true for 'edge' version name", () => {
      expect(isEdgeVersion("edge")).to.be.true
    })

    it("should be true for a version name starting with 'edge-'", () => {
      expect(isEdgeVersion("edge-bonsai")).to.be.true
    })

    it("should be false for a pre-release version name", () => {
      expect(isEdgeVersion("0.13.0-0")).to.be.false
    })

    it("should be false for a stable version name", () => {
      expect(isEdgeVersion("0.13.0")).to.be.false
    })
  })

  describe("isPreReleaseVersion", () => {
    it("should be false for 'edge' version name", () => {
      const version = semver.parse("edge")
      expect(isPreReleaseVersion(version)).to.be.false
    })

    it("should be false for a version name starting with 'edge-'", () => {
      const version = semver.parse("edge-bonsai")
      expect(isPreReleaseVersion(version)).to.be.false
    })

    it("should be true for a pre-release version name", () => {
      const version = semver.parse("0.13.0-0")
      expect(isPreReleaseVersion(version)).to.be.true
    })

    it("should be false for a stable version name", () => {
      const version = semver.parse("0.13.0")
      expect(isPreReleaseVersion(version)).to.be.false
    })
  })
})

describe("SelfUpdateCommand", () => {
  const command = new SelfUpdateCommand()

  let server: Server
  let garden: DummyGarden
  let tempDir: TempDirectory

  before(async () => {
    garden = await makeDummyGarden("/tmp", { commandInfo: { name: command.name, args: {}, opts: {} } })

    // Serve small static files to avoid slow HTTP requests during testing
    const staticServerPort = await getPort()
    const serve = serveStatic(getDataDir("self-update"))

    server = createServer((req, res) => {
      serve(req, res, finalhandler(req, res))
    })
    server.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error(err)
    })
    server.listen(staticServerPort)

    command._baseReleasesUrl = `http://127.0.0.1:${staticServerPort}/`
  })

  beforeEach(async () => {
    tempDir = await makeTempDir()
  })

  afterEach(async () => {
    try {
      if (tempDir) {
        await tempDir.cleanup()
      }
    } catch {}
  })

  after(() => {
    server?.close()
  })

  async function action(args: ParameterValues<SelfUpdateArgs>, opts: ParameterValues<SelfUpdateOpts>) {
    return command.action({
      garden,
      log: garden.log,
      args,
      opts: withDefaultGlobalOpts(opts),
    })
  }

  it(`detects the current installation directory if none is provided`, async () => {
    const { result } = await action(
      { version: "" },
      {
        "force": false,
        "install-dir": "",
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )
    expect(result?.installationDirectory).to.equal(dirname(process.execPath))
  })

  it(`uses the specified --install-dir if set`, async () => {
    const { result } = await action(
      { version: "edge" },
      {
        "force": false,
        "install-dir": tempDir.path,
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )

    expect(result?.installationDirectory).to.equal(tempDir.path)
  })

  it(`aborts if desired version is the same as the current version`, async () => {
    const { result } = await action(
      { version: getPackageVersion() },
      {
        "force": false,
        "install-dir": "",
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )
    expect(result?.installedVersion).to.be.undefined
    expect(result?.abortReason).to.equal("Version already installed")
  })

  it(`proceeds if desired version is the same as the current version and --force is set`, async () => {
    const { result } = await action(
      { version: getPackageVersion() },
      {
        "force": true,
        "install-dir": "",
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )
    expect(result?.installedVersion).to.be.undefined
    // The command will abort because we're running a dev build
    expect(result?.abortReason).to.not.equal("Version already installed")
  })

  it(`aborts if trying to run from a dev build`, async () => {
    const { result } = await action(
      { version: "" },
      {
        "force": true,
        "install-dir": "",
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )
    expect(result?.installedVersion).to.be.undefined
    expect(result?.abortReason).to.equal("Not running from binary installation")
  })

  it(`aborts cleanly if desired version isn't found`, async () => {
    const { result } = await action(
      { version: "foo" },
      {
        "force": true,
        "install-dir": tempDir.path,
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )
    expect(result?.installedVersion).to.be.undefined
    expect(result?.abortReason).to.equal("Version not found")
  })

  it(`installs successfully to an empty --install-dir`, async () => {
    const { result } = await action(
      { version: "edge" },
      {
        "force": false,
        "install-dir": tempDir.path,
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )
    expect(result?.installedVersion).to.equal("edge")
    expect(result?.abortReason).to.be.undefined

    const extracted = await readdir(tempDir.path)
    expect(extracted).to.include("garden")
    expect(extracted).to.include("static")
  })

  it(`installs successfully to an --install-dir with a previous release and creates a backup`, async () => {
    await action(
      { version: "edge" },
      {
        "force": false,
        "install-dir": tempDir.path,
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )
    const { result } = await action(
      { version: "edge" },
      {
        "force": false,
        "install-dir": tempDir.path,
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )
    expect(result?.installedVersion).to.equal("edge")
    expect(result?.abortReason).to.be.undefined

    const extracted = await readdir(tempDir.path)
    expect(extracted).to.include("garden")
    expect(extracted).to.include("static")
    expect(extracted).to.include(".backup")
  })

  it(`installs successfully to an --install-dir with a previous release and overwrites a backup`, async () => {
    await action(
      { version: "edge" },
      {
        "force": false,
        "install-dir": tempDir.path,
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )
    await action(
      { version: "edge" },
      {
        "force": false,
        "install-dir": tempDir.path,
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )
    const { result } = await action(
      {
        version: "edge",
      },
      {
        "force": false,
        "install-dir": tempDir.path,
        "platform": "",
        "major": false,
        // "minor": false,
      }
    )
    expect(result?.installedVersion).to.equal("edge")
    expect(result?.abortReason).to.be.undefined

    const extracted = await readdir(tempDir.path)
    expect(extracted).to.include("garden")
    expect(extracted).to.include("static")
    expect(extracted).to.include(".backup")
  })

  it(`handles --platform=windows and zip archives correctly`, async () => {
    await action(
      { version: "edge" },
      {
        "force": false,
        "install-dir": tempDir.path,
        "platform": "windows",
        "major": false,
        // "minor": false,
      }
    )

    const extracted = await readdir(tempDir.path)
    expect(extracted).to.include("garden.exe")
    expect(extracted).to.include("static")
  })

  it(`handles --platform=macos and tar.gz archives correctly`, async () => {
    await action(
      { version: "edge" },
      {
        "force": false,
        "install-dir": tempDir.path,
        "platform": "macos",
        "major": false,
        // "minor": false,
      }
    )

    const extracted = await readdir(tempDir.path)
    expect(extracted).to.include("garden")
    expect(extracted).to.include("static")
  })

  describe("getTargetVersionPredicate", () => {
    function expectAccepted(
      release: { tag_name: string; draft: boolean; prerelease: boolean },
      currentSemVer: semver.SemVer,
      versionScope: VersionScope
    ) {
      const predicate = command.getTargetVersionPredicate(currentSemVer, versionScope)
      expect(predicate(release)).to.be.true
    }

    function expectSkipped(
      release: { tag_name: string; draft: boolean; prerelease: boolean },
      currentSemVer: semver.SemVer,
      versionScope: VersionScope
    ) {
      const predicate = command.getTargetVersionPredicate(currentSemVer, versionScope)
      expect(predicate(release)).to.be.false
    }

    context("stable patch versions", () => {
      it("should accept a newer stable patch version", () => {
        expectAccepted({ tag_name: "0.12.51", draft: false, prerelease: false }, semver.parse("0.12.50")!, "patch")
      })

      it("should accept the same stable patch version", () => {
        expectAccepted({ tag_name: "0.12.50", draft: false, prerelease: false }, semver.parse("0.12.50")!, "patch")
      })

      it("should skip an older stable patch version", () => {
        expectSkipped({ tag_name: "0.12.49", draft: false, prerelease: false }, semver.parse("0.12.50")!, "patch")
      })
    })

    // TODO: change this to test minor versions in 1.0 release
    context("stable major versions", () => {
      it("should accept a newer major patch version", () => {
        expectAccepted({ tag_name: "0.13.0", draft: false, prerelease: false }, semver.parse("0.12.50")!, "major")
      })

      it("should skip the same stable major version", () => {
        expectSkipped({ tag_name: "0.13.0", draft: false, prerelease: false }, semver.parse("0.13.0")!, "major")
      })

      it("should skip an older stable major version", () => {
        expectSkipped({ tag_name: "0.12.50", draft: false, prerelease: false }, semver.parse("0.13.0")!, "major")
      })
    })

    // VersionScope doesn't matter in this context
    context("skipped versions", () => {
      context("skip any pre-release", () => {
        it("should skip an older pre-release version", () => {
          expectSkipped({ tag_name: "0.12.50-0", draft: false, prerelease: true }, semver.parse("0.12.50-1")!, "patch")
        })

        it("should skip the same pre-release version", () => {
          expectSkipped({ tag_name: "0.12.50-0", draft: false, prerelease: true }, semver.parse("0.12.50-0")!, "patch")
        })

        it("should skip a newer pre-release version", () => {
          expectSkipped({ tag_name: "0.12.50-1", draft: false, prerelease: true }, semver.parse("0.12.50-0")!, "patch")
        })
      })
    })

    context("skip any draft", () => {
      it("should skip an older pre-release version", () => {
        expectSkipped({ tag_name: "0.12.53-0", draft: true, prerelease: false }, semver.parse("0.13.0")!, "patch")
      })

      it("should skip the same pre-release version", () => {
        expectSkipped({ tag_name: "0.13", draft: true, prerelease: false }, semver.parse("0.13.0")!, "patch")
      })

      it("should skip a newer pre-release version", () => {
        expectSkipped({ tag_name: "0.13.1-0", draft: true, prerelease: false }, semver.parse("0.13.0")!, "patch")
      })
    })

    context("skip any edge", () => {
      it("should skip an edge version", () => {
        expectSkipped({ tag_name: "edge", draft: false, prerelease: false }, semver.parse("0.13.0")!, "patch")
      })

      it("should skip edge-* versions", () => {
        expectSkipped({ tag_name: "edge-bonsai", draft: false, prerelease: false }, semver.parse("0.13.0")!, "patch")
      })
    })
  })

  describe("GitHubReleaseApi", () => {
    describe("findRelease", () => {
      const currentSemVer = semver.parse("0.12.57")!

      it("should find the latest minor release if there are multiple minor versions", async () => {
        // Mock the data fetcher to return only one page
        const fetcher = async (pagination: GitHubReleaseApi.Pagination) => {
          if (pagination.pageNumber > 1) {
            return []
          }
          return [
            { tag_name: "0.12.58", prerelease: false, draft: false },
            { tag_name: "0.13.1", prerelease: false, draft: false },
            { tag_name: "0.13.0", prerelease: false, draft: false },
            { tag_name: "0.12.57", prerelease: false, draft: false },
          ]
        }
        const primaryPredicate = command.getTargetVersionPredicate(currentSemVer, "minor")
        const release = await GitHubReleaseApi.findRelease({ primaryPredicate, fetcher })
        expect(release.tag_name).to.eql("0.13.1")
      })

      it("should fallback to the latest patch release if no minor version found", async () => {
        // Mock the data fetcher to return only one page
        const fetcher = async (pagination: GitHubReleaseApi.Pagination) => {
          if (pagination.pageNumber > 1) {
            return []
          }
          return [
            { tag_name: "0.12.58", prerelease: false, draft: false },
            { tag_name: "0.12.57", prerelease: false, draft: false },
          ]
        }
        const primaryPredicate = command.getTargetVersionPredicate(currentSemVer, "minor")
        const fallbackPredicate = command.getTargetVersionPredicate(currentSemVer, "patch")
        const release = await GitHubReleaseApi.findRelease({
          primaryPredicate,
          fallbackPredicates: [fallbackPredicate],
          fetcher,
        })
        expect(release.tag_name).to.eql("0.12.58")
      })
    })
  })
})
