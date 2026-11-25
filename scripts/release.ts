// Decide the next release from the Conventional Commits made since the latest vX.Y.Z tag.
//
//   bun scripts/release.ts                       print the plan for HEAD (read-only)
//   bun scripts/release.ts --notes notes.md      also write the release notes (used by CI)
//
// Before 1.0.0 a breaking change bumps the minor version, as semver allows.
import { execFileSync } from "node:child_process"
import { appendFileSync, writeFileSync } from "node:fs"

export type Version = readonly [number, number, number]
export type Bump = "major" | "minor" | "patch"

export interface Commit {
  readonly sha: string
  readonly subject: string
  readonly body: string
}

export interface Change {
  readonly type: string
  readonly breaking: boolean
  readonly description: string
  readonly sha: string
}

export type Plan =
  | { readonly release: false; readonly reason: string }
  | {
      readonly release: true
      readonly tag: string
      readonly version: string
      readonly previous: string | undefined
      readonly bump: Bump
      readonly changes: readonly Change[]
    }

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/

export function parseCommit(commit: Commit): Change | undefined {
  const match = /^(\w+)(?:\([^)]*\))?(!)?: (.+)$/.exec(commit.subject)
  if (!match) return undefined
  return {
    type: match[1]!.toLowerCase(),
    breaking: match[2] === "!" || /^BREAKING[ -]CHANGE:/m.test(commit.body),
    description: match[3]!,
    sha: commit.sha,
  }
}

const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** The highest vX.Y.Z tag. Other tags, such as release candidates, are ignored. */
export function latestTag(tags: readonly string[]): { tag: string; version: Version } | undefined {
  const found = tags.flatMap((tag) => {
    const match = TAG.exec(tag)
    return match ? [{ tag, version: [Number(match[1]), Number(match[2]), Number(match[3])] as const }] : []
  })
  return found.sort((a, b) => compare(b.version, a.version))[0]
}

export function bumpFor(version: Version, changes: readonly Change[]): Bump | undefined {
  if (changes.some((change) => change.breaking)) return version[0] === 0 ? "minor" : "major"
  if (changes.some((change) => change.type === "feat")) return "minor"
  if (changes.some((change) => change.type === "fix" || change.type === "perf")) return "patch"
  return undefined
}

export function applyBump(version: Version, bump: Bump): Version {
  if (bump === "major") return [version[0] + 1, 0, 0]
  if (bump === "minor") return [version[0], version[1] + 1, 0]
  return [version[0], version[1], version[2] + 1]
}

export function plan(tags: readonly string[], commits: readonly Commit[]): Plan {
  const latest = latestTag(tags)
  const changes = commits.flatMap((commit) => parseCommit(commit) ?? [])
  const base: Version = latest?.version ?? [0, 0, 0]
  const bump = bumpFor(base, changes)
  if (!bump) return { release: false, reason: "no feat, fix, perf or breaking commit since the last release" }
  const version = applyBump(base, bump).join(".")
  return { release: true, tag: `v${version}`, version, previous: latest?.tag, bump, changes }
}

const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
]

export function notes(release: Extract<Plan, { release: true }>, repository: string | undefined): string {
  const line = (change: Change) => `- ${change.description} (${change.sha.slice(0, 7)})`
  const lines = [`## ${release.tag}`, ""]
  const breaking = release.changes.filter((change) => change.breaking)
  if (breaking.length) lines.push("### Breaking changes", "", ...breaking.map(line), "")
  for (const [type, title] of SECTIONS) {
    const section = release.changes.filter((change) => change.type === type && !change.breaking)
    if (section.length) lines.push(`### ${title}`, "", ...section.map(line), "")
  }
  if (repository) {
    lines.push("### Install", "", "```sh", `opencode plugin add github:${repository}#${release.tag}`, "```", "")
    if (release.previous) lines.push(`Full changelog: https://github.com/${repository}/compare/${release.previous}...${release.tag}`, "")
  }
  return lines.join("\n")
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim()

function readCommits(since: string | undefined): Commit[] {
  const range = since ? [`${since}..HEAD`] : ["HEAD"]
  return git("log", "--format=%H%x1f%s%x1f%b%x1e", ...range)
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, body] = entry.split("\x1f")
      return { sha: sha!, subject: subject!, body: body ?? "" }
    })
}

if (import.meta.main) {
  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean)
  const atHead = git("tag", "--points-at", "HEAD").split("\n").filter((tag) => TAG.test(tag))
  const result: Plan = atHead.length
    ? { release: false, reason: `HEAD is already released as ${atHead.join(", ")}` }
    : plan(tags, readCommits(latestTag(tags)?.tag))

  const output = process.env.GITHUB_OUTPUT
  const emit = (key: string, value: string) => output && appendFileSync(output, `${key}=${value}\n`)

  if (!result.release) {
    console.log(`No release: ${result.reason}`)
    emit("release", "false")
  } else {
    console.log(`Next release: ${result.tag} (${result.bump}, from ${result.previous ?? "the first commit"})`)
    for (const change of result.changes) console.log(`  ${change.type}${change.breaking ? "!" : ""}: ${change.description}`)
    emit("release", "true")
    emit("tag", result.tag)
    const file = process.argv[process.argv.indexOf("--notes") + 1]
    if (process.argv.includes("--notes") && file) writeFileSync(file, notes(result, process.env.GITHUB_REPOSITORY))
  }
}
