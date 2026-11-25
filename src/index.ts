import type { Plugin } from "@opencode/plugin"
import { lookup, parseReference } from "./keychain.ts"
import { collect, substitute } from "./substitute.ts"

const ID = "mcp-keychain"

// Only type imports from @opencode/plugin: the plugin has no runtime dependency,
// so it loads from a local directory without installing anything.
const plugin: Plugin.Plugin = {
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
            console.warn(`[${ID}] cannot read {keychain:${name}}: ${error.message}`)
          },
        )
        .finally(() => {
          inflight.delete(name)
          if (inflight.size || disposed) return
          ctx.mcp.reload().catch((error) => console.error(`[${ID}] MCP reload failed`, error))
        })
    }

    return ctx.mcp
      .transform((editor) => {
        for (const [server, config] of editor.list()) {
          const names = [...collect(config)]
          if (!names.length) continue

          const missing = names.filter((name) => !cache.has(name))
          if (missing.length) {
            missing.filter((name) => !failed.has(name)).forEach(resolve)
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

export default plugin
