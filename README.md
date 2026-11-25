# opencode-mcp-keychain

OpenCode V2 server plugin that resolves `{keychain:<name>}` references in MCP server
configuration from the OS keychain, alongside the built-in `{env:<name>}` and `{file:<path>}`.

## Install

Install a pinned release from GitHub with the OpenCode CLI. Git credentials are used for private
repositories.

```sh
opencode plugin add github:Sabbasth/opencode-mcp-keychain#v0.1.0
```

The suffix after `#` can be a tag, a branch or a full commit hash. A tag or a full commit hash pins
the plugin to that exact revision. A branch (`#main`) or no suffix follows new commits, and
OpenCode checks for updates at startup.

```sh
opencode plugin list                          # installed plugins and their source
opencode plugin check                         # look for updates (pinned revisions are skipped)
opencode plugin update mcp-keychain           # update an unpinned install
opencode plugin remove github:Sabbasth/opencode-mcp-keychain#v0.1.0
```

To move to another release, remove the pinned entry and add the new tag. SSH works as well:
`opencode plugin add git+ssh://git@github.com/Sabbasth/opencode-mcp-keychain.git#v0.1.0`.

For development, point `plugins` at a local clone instead. OpenCode watches the directory and
reloads on change. Do not keep this entry next to a GitHub install, since both register the same
plugin ID.

```jsonc title="opencode.jsonc"
{ "plugins": ["/absolute/path/to/opencode-mcp-keychain"] }
```

## Usage

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "context7": {
        "type": "remote",
        "url": "https://mcp.context7.com/mcp",
        "oauth": false,
        "headers": { "CONTEXT7_API_KEY": "{keychain:context7-api-key}" },
      },
      "github": {
        "type": "local",
        "command": ["github-mcp-server", "stdio"],
        "environment": { "GITHUB_PERSONAL_ACCESS_TOKEN": "{keychain:github-mcp/Sabbasth}" },
      },
    },
  },
}
```

## Reference syntax

| Reference | Lookup |
| --- | --- |
| `{keychain:<service>}` | First generic password whose service is `<service>` |
| `{keychain:<service>/<account>}` | Generic password matching both service and account |

References work in any string field of an MCP server (`url`, `headers`, `environment`, `command`
arguments, `oauth.client_secret`, ...) and can be embedded in a larger string, e.g.
`"Bearer {keychain:my-token}"`.

## Storing secrets

macOS (`security`):

```sh
security add-generic-password -s context7-api-key -a "$USER" -w   # prompts for the value
```

Linux (`secret-tool`, libsecret; uses the `service` and `account` attributes):

```sh
secret-tool store --label "context7" service context7-api-key account "$USER"
```

Windows is not supported.

## Plugin ID

The plugin registers as `mcp-keychain` (see `opencode plugin list`). Disable it without removing
it by adding `"-mcp-keychain"` to `plugins`.

## Behavior

- OpenCode core substitutes `{env:}` and `{file:}` in the raw config text and has no extension
  point for new keywords. It leaves `{keychain:}` untouched, so this plugin rewrites MCP server
  configs through `ctx.mcp.transform`.
- Transforms are synchronous, so secrets are read asynchronously. A server whose references are
  not resolved yet is kept `disabled`, which means it never connects with a literal placeholder.
  Once every pending lookup settles, the plugin calls `ctx.mcp.reload()` and the server connects
  with the resolved values.
- Values are cached in memory for the lifetime of the plugin. After rotating a secret, or adding
  a missing one, run `/reload`.
- A missing, empty or unreadable secret never becomes an empty string like with `{env:}`. The
  server is reported as `failed` with an explanation instead, see [Troubleshooting](#troubleshooting).
- A server you disabled yourself (`"disabled": true`) is left alone: its secrets are not read.
- Secret values are never logged.
- The first access may trigger a macOS keychain authorization prompt. Lookups time out after 60s.
- Secrets are expected to be plain ASCII text, like API tokens. The plugin returns what
  `security find-generic-password -w` prints, and that command prints a secret as hexadecimal when
  it contains non-ASCII characters or a newline. This is how the tool behaves, and the plugin does
  not work around it.

## Troubleshooting

When a secret cannot be read, the affected server shows up as `failed` in `/mcps`, in the desktop
app and in `opencode mcp list`, with the reason and the command that stores the secret:

```
✗ github-ro  failed: Connection closed: MCP server process exited with code 1:
  mcp-keychain: cannot read {keychain:github-mcp-readonly} (security: SecKeychainSearchCopyNext:
  The specified item could not be found in the keychain.). Store it with:
  security add-generic-password -s github-mcp-readonly -w, then run /reload
```

OpenCode computes a server's status itself and gives plugins no way to set it. To get a readable
status, the plugin swaps the configuration of the affected server for a command that prints the
message on stderr and exits, which OpenCode reports as the failure reason. The original
configuration is restored as soon as every secret can be read. Run `/reload` after storing a
missing secret: failures are remembered until then, so that a missing secret is not looked up
again on every reload.

If several secrets of one server are unreadable, all of them are listed.

## Scope

Only MCP server configuration is handled. Providers could be supported the same way through
`ctx.provider.transform`.

## Tests

Tests run with [Bun](https://bun.sh), the runtime OpenCode itself is built on.

```sh
bun install
bun run typecheck
bun test
```

`bun test` runs everything that is safe on a developer machine and skips the rest:

| Suite | Directory | What it covers | When it runs |
| --- | --- | --- | --- |
| Unit | `test/unit` | reference parsing, substitution, platform commands | always |
| Plugin | `test/plugin` | the plugin against a fake `ctx.mcp` that replays transforms like OpenCode | always |
| Keychain | `test/integration` | the real macOS keychain | `KEYCHAIN_INTEGRATION=1`, macOS only |
| End-to-end | `test/e2e` | a real `opencode serve` loading the plugin, read through its API | `OPENCODE_E2E=1` |

The keychain and end-to-end suites store temporary items in the default keychain, so they are meant
for CI, where a throwaway keychain is created first (`.github/scripts/setup-keychain.sh`). The two
end-to-end scenarios that need no stored secret (missing secret, server disabled by the user) can
be run locally with `OPENCODE_E2E=1 bun test test/e2e`. They use a private server and temporary
`XDG_*` directories, and leave your configuration alone.

CI (`.github/workflows/ci.yml`):

- every push and pull request: type check, unit and plugin tests on macOS and Ubuntu, keychain
  tests on macOS;
- when code reaches `main`, weekly, and on demand: the end-to-end tests on macOS against the
  oldest OpenCode release the plugin supports (`2.3.0`) and the latest one.

## Releases

Versions follow [semver](https://semver.org) and are derived from the commit messages
([Conventional Commits](https://www.conventionalcommits.org)) made since the last `vX.Y.Z` tag:

| Commits | Release |
| --- | --- |
| `feat!:` or a `BREAKING CHANGE:` footer | major, or minor while the version is below 1.0.0 |
| `feat:` | minor |
| `fix:`, `perf:` | patch |
| `docs:`, `test:`, `ci:`, `chore:`, `refactor:` only | no release |

When a commit reaches `main` and passes every test, including the end-to-end ones, the `release` job
of the CI creates the tag and a GitHub release with generated notes. It never commits, so the
`version` in `package.json` is a placeholder and the git tag is the source of truth. Pin that tag
when you install the plugin, see [Install](#install).

`bun scripts/release.ts` prints the release the current checkout would produce, without changing
anything.

## Development

The plugin only uses type imports from `@opencode/plugin`, so it has no runtime dependency and
loads from a local directory as is. For type checking:

```sh
npm install
npm run typecheck
```
