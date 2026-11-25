import { describe, expect, test } from "bun:test"
import { applyBump, bumpFor, latestTag, notes, parseCommit, plan, resolve, type Commit } from "../../scripts/release.ts"

const commit = (subject: string, body = "", sha = "abcdef0123456789"): Commit => ({ sha, subject, body })

describe("parseCommit", () => {
  test("reads the type and the description", () => {
    expect(parseCommit(commit("feat: add a thing"))).toMatchObject({ type: "feat", description: "add a thing", breaking: false })
  })

  test("accepts a scope and is case-insensitive on the type", () => {
    expect(parseCommit(commit("Fix(plugin): handle X"))).toMatchObject({ type: "fix", description: "handle X" })
  })

  test("a ! marks a breaking change", () => {
    expect(parseCommit(commit("feat!: drop the old syntax"))?.breaking).toBe(true)
    expect(parseCommit(commit("feat(api)!: drop it"))?.breaking).toBe(true)
  })

  test("a BREAKING CHANGE footer marks a breaking change", () => {
    expect(parseCommit(commit("fix: x", "details\n\nBREAKING CHANGE: the format changed"))?.breaking).toBe(true)
    expect(parseCommit(commit("fix: x", "BREAKING-CHANGE: also works"))?.breaking).toBe(true)
  })

  test("a mention of breaking changes in prose is not a footer", () => {
    expect(parseCommit(commit("fix: x", "this is not a BREAKING CHANGE: really"))?.breaking).toBe(false)
  })

  test("ignores commits that are not conventional", () => {
    expect(parseCommit(commit("Merge pull request #1 from x/y"))).toBeUndefined()
    expect(parseCommit(commit("fixed a thing"))).toBeUndefined()
  })
})

describe("latestTag", () => {
  test("picks the highest version numerically", () => {
    expect(latestTag(["v0.9.0", "v0.10.0", "v0.2.5"])?.tag).toBe("v0.10.0")
    expect(latestTag(["v1.0.0", "v0.99.9"])?.tag).toBe("v1.0.0")
  })

  test("ignores tags that are not plain vX.Y.Z", () => {
    expect(latestTag(["v1", "v1.0.0-rc1", "foo", "1.2.3", "v1.2"])).toBeUndefined()
    expect(latestTag(["v2.0.0-beta", "v0.3.0"])?.tag).toBe("v0.3.0")
  })

  test("is undefined without tags", () => {
    expect(latestTag([])).toBeUndefined()
  })
})

describe("bumpFor and applyBump", () => {
  const change = (type: string, breaking = false) => ({ type, breaking, description: "d", sha: "s" })

  test("feat is minor, fix and perf are patch", () => {
    expect(bumpFor([1, 2, 3], [change("feat")])).toBe("minor")
    expect(bumpFor([1, 2, 3], [change("fix")])).toBe("patch")
    expect(bumpFor([1, 2, 3], [change("perf")])).toBe("patch")
  })

  test("the highest bump wins", () => {
    expect(bumpFor([1, 2, 3], [change("fix"), change("feat"), change("docs")])).toBe("minor")
  })

  test("a breaking change is major from 1.0.0 and minor before", () => {
    expect(bumpFor([1, 2, 3], [change("feat", true)])).toBe("major")
    expect(bumpFor([0, 4, 0], [change("fix", true)])).toBe("minor")
  })

  test("docs, test, ci, chore and refactor do not release", () => {
    for (const type of ["docs", "test", "ci", "chore", "refactor", "style", "build"]) {
      expect(bumpFor([1, 0, 0], [change(type)])).toBeUndefined()
    }
  })

  test("applyBump resets the lower numbers", () => {
    expect(applyBump([1, 2, 3], "major")).toEqual([2, 0, 0])
    expect(applyBump([1, 2, 3], "minor")).toEqual([1, 3, 0])
    expect(applyBump([1, 2, 3], "patch")).toEqual([1, 2, 4])
  })
})

describe("plan", () => {
  test("v0.1.0 followed by features gives v0.2.0", () => {
    const result = plan(["v0.1.0"], [commit("feat: a"), commit("fix: b"), commit("docs: c")])
    expect(result).toMatchObject({ release: true, tag: "v0.2.0", version: "0.2.0", previous: "v0.1.0", bump: "minor" })
  })

  test("only fixes give a patch release", () => {
    expect(plan(["v0.2.0"], [commit("fix: a")])).toMatchObject({ release: true, tag: "v0.2.1" })
  })

  test("nothing releasable gives no release", () => {
    const result = plan(["v0.2.0"], [commit("docs: a"), commit("test: b"), commit("ci: c"), commit("Merge branch x")])
    expect(result.release).toBe(false)
  })

  test("no commits gives no release", () => {
    expect(plan(["v0.2.0"], []).release).toBe(false)
  })

  test("a breaking change before 1.0.0 is a minor release", () => {
    expect(plan(["v0.2.0"], [commit("feat!: new syntax")])).toMatchObject({ tag: "v0.3.0", bump: "minor" })
  })

  test("a breaking change after 1.0.0 is a major release", () => {
    expect(plan(["v1.4.2"], [commit("fix!: new format")])).toMatchObject({ tag: "v2.0.0", bump: "major" })
  })

  test("without any tag it starts from 0.0.0", () => {
    expect(plan([], [commit("feat: first")])).toMatchObject({ tag: "v0.1.0", previous: undefined })
  })

  test("bases the bump on the highest tag, whatever the order", () => {
    expect(plan(["v0.10.0", "v0.9.0"], [commit("fix: a")])).toMatchObject({ tag: "v0.10.1" })
  })
})

describe("resolve", () => {
  const since = (expected: string | undefined, commits: Commit[]) => (tag: string | undefined) => {
    expect(tag).toBe(expected)
    return commits
  }

  test("plans the next release when HEAD is not tagged", () => {
    expect(resolve(["v0.1.0"], [], since("v0.1.0", [commit("feat: a")]))).toMatchObject({ release: true, tag: "v0.2.0" })
  })

  test("plans again the release HEAD is already tagged with, so that it can be completed", () => {
    const result = resolve(["v0.1.0", "v0.2.0"], ["v0.2.0"], since("v0.1.0", [commit("feat: a"), commit("docs: b")]))
    expect(result).toMatchObject({ release: true, tag: "v0.2.0", previous: "v0.1.0" })
  })

  test("reads the commits since the tag before the one HEAD carries", () => {
    resolve(["v0.1.0", "v0.2.0"], ["v0.2.0"], since("v0.1.0", []))
  })

  test("does not release when HEAD carries a tag the commits do not explain", () => {
    const result = resolve(["v0.1.0", "v5.0.0"], ["v5.0.0"], since("v0.1.0", [commit("feat: a")]))
    expect(result).toEqual({ release: false, reason: "HEAD is already released as v5.0.0" })
  })

  test("does not release when HEAD is tagged and nothing is releasable", () => {
    expect(resolve(["v0.1.0", "v0.1.1"], ["v0.1.1"], since("v0.1.0", [commit("docs: a")])).release).toBe(false)
  })

  test("without tags at all, the first feature is v0.1.0", () => {
    expect(resolve([], [], since(undefined, [commit("feat: first")]))).toMatchObject({ release: true, tag: "v0.1.0" })
  })
})

describe("notes", () => {
  const released = plan(
    ["v0.1.0"],
    [
      commit("feat: add the thing", "", "1111111aaaa"),
      commit("fix(plugin): handle the case", "", "2222222bbbb"),
      commit("docs: explain", "", "3333333cccc"),
      commit("feat!: break it", "", "4444444dddd"),
    ],
  )
  if (!released.release) throw new Error("expected a release")

  test("groups releasable changes and leaves the others out", () => {
    const text = notes(released, undefined)
    expect(text).toContain("## v0.2.0")
    expect(text).toContain("### Breaking changes\n\n- break it (4444444)")
    expect(text).toContain("### Features\n\n- add the thing (1111111)")
    expect(text).toContain("### Fixes\n\n- handle the case (2222222)")
    expect(text).not.toContain("explain")
  })

  test("does not list a breaking change twice", () => {
    expect(notes(released, undefined).match(/break it/g)).toHaveLength(1)
  })

  test("adds the install command and the changelog link when the repository is known", () => {
    const text = notes(released, "Sabbasth/opencode-mcp-keychain")
    expect(text).toContain("opencode plugin add github:Sabbasth/opencode-mcp-keychain#v0.2.0")
    expect(text).toContain("https://github.com/Sabbasth/opencode-mcp-keychain/compare/v0.1.0...v0.2.0")
  })
})
