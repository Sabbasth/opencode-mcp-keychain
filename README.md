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
- A missing or unreadable secret keeps the server disabled (visible in `/mcps`) instead of
  substituting an empty string like `{env:}` does.
- Secret values are never logged.
- The first access may trigger a macOS keychain authorization prompt. Lookups time out after 60s.

## Scope

Only MCP server configuration is handled. Providers could be supported the same way through
`ctx.provider.transform`.

## Development

The plugin only uses type imports from `@opencode/plugin`, so it has no runtime dependency and
loads from a local directory as is. For type checking:

```sh
npm install
npm run typecheck
```
