# opencode-mcp-keychain

OpenCode V2 server plugin that resolves `{keychain:<name>}` references in MCP server
configuration from the OS keychain, alongside the built-in `{env:<name>}` and `{file:<path>}`.

## Install

Install a pinned release from GitHub with the OpenCode CLI. Git credentials are used for private
repositories. The tags are listed on the [releases page](https://github.com/Sabbasth/opencode-mcp-keychain/releases).

```sh
opencode plugin add github:Sabbasth/opencode-mcp-keychain#<tag>
```

The suffix after `#` can be a tag, a branch or a full commit hash. A tag or a full commit hash pins
the plugin to that exact revision. A branch (`#main`) or no suffix follows new commits, and
OpenCode checks for updates at startup.

```sh
opencode plugin list                          # installed plugins and their source
opencode plugin check                         # look for updates (pinned revisions are skipped)
opencode plugin update mcp-keychain           # update an unpinned install
opencode plugin remove github:Sabbasth/opencode-mcp-keychain#<tag>
```

To move to another release, remove the pinned entry and add the new tag. SSH works as well:
`opencode plugin add git+ssh://git@github.com/Sabbasth/opencode-mcp-keychain.git#<tag>`.

Releases follow [semver](https://semver.org), and each one has generated notes on the releases page.

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

- A server is kept disabled while its secrets are being read, so it never connects with a literal
  placeholder. It then connects with the resolved values.
- A missing, empty or unreadable secret never becomes an empty string like with `{env:}`. The
  server is reported as `failed` with an explanation instead, see [Troubleshooting](#troubleshooting).
- Values are cached in memory for the lifetime of the plugin. After rotating a secret, or adding
  a missing one, run `/reload`.
- A server you disabled yourself (`"disabled": true`) is left alone: its secrets are not read.
- Secret values are never logged.
- The first access may trigger a macOS keychain authorization prompt. Lookups time out after 60s.
- Secrets are expected to be plain ASCII text, like API tokens. The plugin returns what
  `security find-generic-password -w` prints, and that command prints a secret as hexadecimal when
  it contains non-ASCII characters or a newline. This is how the tool behaves, and the plugin does
  not work around it.
- Only MCP server configuration is handled.

## Troubleshooting

When a secret cannot be read, the affected server shows up as `failed` in `/mcps`, in the desktop
app and in `opencode mcp list`, with the reason and the command that stores the secret:

```
✗ github-ro  failed: Connection closed: MCP server process exited with code 1:
  mcp-keychain: cannot read {keychain:github-mcp-readonly} (security: SecKeychainSearchCopyNext:
  The specified item could not be found in the keychain.). Store it with:
  security add-generic-password -s github-mcp-readonly -w, then run /reload
```

Store the secret with the suggested command, then run `/reload`. Failures are remembered until
then, so that a missing secret is not looked up again on every reload. If several secrets of one
server are unreadable, all of them are listed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the tests, the CI and how releases are made.
