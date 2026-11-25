# Contributing

Thanks for helping with `opencode-mcp-keychain`. This document covers everything about working on the
plugin. For installing and using it, see the [README](README.md).

## Setup

The tooling is [Bun](https://bun.sh), the runtime OpenCode itself is built on.

```sh
bun install
bun run typecheck
bun test
```

The plugin only uses type imports from `@opencode/plugin`, so it has no runtime dependency and loads
from a local directory as is. The dependencies in `package.json` are for type checking and tests.

## Project layout

| Path | Content |
| --- | --- |
| `src/index.ts` | the default export OpenCode loads |
| `src/plugin.ts` | `createPlugin({ lookup, log, platform })`, the plugin logic with injectable dependencies |
| `src/keychain.ts` | reference parsing, platform commands and the keychain lookup |
| `src/substitute.ts` | finding and replacing `{keychain:<name>}` in a configuration |
| `test/` | `unit`, `plugin`, `integration` and `e2e` suites, and shared `helpers` |
| `scripts/release.ts` | decides the next version from the commit messages |
| `.github/` | the CI workflow and the script that creates a throwaway keychain |

## How it works

- OpenCode core substitutes `{env:}` and `{file:}` in the raw config text and has no extension point
  for new keywords. It leaves `{keychain:}` untouched, so the plugin rewrites MCP server configs
  through `ctx.mcp.transform`.
- Transforms are synchronous, so secrets are read asynchronously. A server whose references are not
  resolved yet is kept `disabled`, which means it never connects with a literal placeholder. Once
  every pending lookup settles, the plugin calls `ctx.mcp.reload()` and the server connects with the
  resolved values.
- OpenCode computes a server's status itself and gives plugins no way to set it. To report an
  unreadable secret in a readable way, the plugin swaps the configuration of the affected server for
  a command that prints the message on stderr and exits with 1, which OpenCode shows as the failure
  reason in `/mcps`, in the desktop app and in `opencode mcp list`. The message is a positional
  argument of `sh`, never interpolated into the script. The original configuration is restored as soon
  as every secret can be read.
- Failures are remembered until the next `/reload`. Without that, a missing secret would be looked up
  again on every reload, and each failed lookup triggers a reload.
- Servers the user disabled are skipped entirely, so their secrets are not read.

Only MCP server configuration is handled. Providers could be supported the same way through
`ctx.provider.transform`.

## Running your changes in OpenCode

Point `plugins` at your clone. OpenCode watches the directory and reloads on change.

```jsonc title="opencode.jsonc"
{ "plugins": ["/absolute/path/to/opencode-mcp-keychain"] }
```

Do not keep this entry next to an installed release of the plugin, since both register the same
plugin ID (`mcp-keychain`).

## Tests

`bun test` runs everything that is safe on a developer machine and skips the rest:

| Suite | Directory | What it covers | When it runs |
| --- | --- | --- | --- |
| Unit | `test/unit` | reference parsing, substitution, platform commands, release planning | always |
| Plugin | `test/plugin` | the plugin against a fake `ctx.mcp` that replays transforms like OpenCode | always |
| Keychain | `test/integration` | the real macOS keychain | `KEYCHAIN_INTEGRATION=1`, macOS only |
| End-to-end | `test/e2e` | a real `opencode serve` loading the plugin, read through its API | `OPENCODE_E2E=1` |

The keychain and end-to-end suites store temporary items in the default keychain, so they are meant for
CI, where a throwaway keychain is created first (`.github/scripts/setup-keychain.sh`). The two
end-to-end scenarios that need no stored secret (missing secret, server disabled by the user) can be
run locally with `OPENCODE_E2E=1 bun test test/e2e`. They use a private server and temporary `XDG_*`
directories, and leave your configuration alone. They need the `opencode` binary, or set
`OPENCODE_BIN`.

Test strings must not look like real credentials, such as a GitHub, AWS or OpenAI key format, which
secret scanners flag. Use something obviously fake, such as `thisIsATestStringusedForTestPurposes`.

## Continuous integration

`.github/workflows/ci.yml` runs:

- on every push and pull request: type check, unit and plugin tests on macOS and Ubuntu, and the
  keychain tests on macOS;
- when code reaches `main`, weekly, and on demand: the end-to-end tests on macOS against the oldest
  OpenCode release the plugin supports (`2.3.0`) and the latest one;
- on `main` only, once all of that passed: the release job described below.

The end-to-end job can be started by hand on any branch with the `workflow_dispatch` trigger, for
example `gh workflow run ci.yml --ref my-branch`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org): `type: description`, with a `!` after
the type or a `BREAKING CHANGE:` footer for a breaking change. The type decides the next version, so
pick it for what the change does to users of the plugin, not to the code: `ci:` for workflow changes,
`docs:` for documentation, `test:` for tests, `feat:` and `fix:` for what users can see.

## Releases

Versions follow [semver](https://semver.org) and are derived from the commit messages made since the
last `vX.Y.Z` tag:

| Commits | Release |
| --- | --- |
| `feat!:` or a `BREAKING CHANGE:` footer | major, or minor while the version is below 1.0.0 |
| `feat:` | minor |
| `fix:`, `perf:` | patch |
| `docs:`, `test:`, `ci:`, `chore:`, `refactor:` only | no release |

When a commit reaches `main` and passes every test, including the end-to-end ones, the `release` job
creates the tag and a GitHub release with generated notes. It never commits, so the `version` in
`package.json` is a placeholder and the git tag is the source of truth.

The GitHub API sometimes fails with a server error. The job retries, and it only creates what is
missing, so if a release is left unfinished, for example a tag without its GitHub release, rerun the
failed job of that workflow run: it plans the release again from the tagged commit and completes it.

`bun scripts/release.ts` prints the release the current checkout would produce, without changing
anything.
