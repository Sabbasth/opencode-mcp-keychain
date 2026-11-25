import type { Plugin } from "@opencode/plugin"
import type { Reference } from "./keychain.ts"
import { parseReference, storeHint } from "./keychain.ts"
import { collect, substitute } from "./substitute.ts"

export const ID = "mcp-keychain"

export interface Dependencies {
  readonly lookup: (reference: Reference) => Promise<string>
  readonly log?: Pick<Console, "warn" | "error">
  readonly platform?: NodeJS.Platform
}

/**
 * A server that exits immediately with a message on stderr. OpenCode reports it as `failed` with that message,
 * which is the one place users look when a server is not available. The message is a positional argument, never
 * interpolated into the script.
 */
const failing = (message: string) => ({
  type: "local" as const,
  command: ["/bin/sh", "-c", 'printf "%s\\n" "$1" >&2; exit 1', "sh", message],
})

export function createPlugin({ lookup, log = console, platform = process.platform }: Dependencies): Plugin.Plugin {
  return {
    id: ID,
    setup(ctx) {
      const cache = new Map<string, string>()
      const failed = new Map<string, string>()
      const inflight = new Set<string>()
      let disposed = false

      const resolve = (name: string) => {
        if (inflight.has(name)) return
        inflight.add(name)
        lookup(parseReference(name))
          .then(
            (value) => cache.set(name, value),
            (error: Error) => {
              failed.set(name, error.message)
              log.warn(`[${ID}] cannot read {keychain:${name}}: ${error.message}`)
            },
          )
          .finally(() => {
            inflight.delete(name)
            if (inflight.size || disposed) return
            ctx.mcp.reload().catch((error) => log.error(`[${ID}] MCP reload failed`, error))
          })
      }

      const describe = (names: string[]) =>
        names
          .map((name) => {
            const hint = storeHint(parseReference(name), platform)
            return `${ID}: cannot read {keychain:${name}} (${failed.get(name)})${hint ? `. Store it with: ${hint}, then run /reload` : ""}`
          })
          .join(" | ")

      return ctx.mcp
        .transform((editor) => {
          for (const [server, config] of editor.list()) {
            // A server the user disabled is left alone: no lookup, no keychain prompt.
            if (config.disabled) continue
            const names = [...collect(config)]
            if (!names.length) continue

            const broken = names.filter((name) => failed.has(name))
            if (broken.length) {
              editor.set(server, failing(describe(broken)))
              continue
            }

            const missing = names.filter((name) => !cache.has(name))
            if (missing.length) {
              missing.forEach(resolve)
              // Never connect with a literal placeholder: keep the server off until every secret resolves.
              editor.update(server, (draft) => {
                draft.disabled = true
              })
              continue
            }

            editor.update(server, (draft) => {
              substitute(draft, (name) => cache.get(name)!)
            })
          }
        })
        .then((registration) => async () => {
          disposed = true
          await registration.dispose()
        })
    },
  }
}
