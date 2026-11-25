import type { Plugin } from "@opencode/plugin"

type Server = Record<string, any>
type Editor = {
  list(): [string, Server][]
  get(name: string): Server | undefined
  set(name: string, config: Server): void
  update(name: string, update: (config: Server) => void): void
  remove(name: string): void
}

/**
 * A stand-in for ctx.mcp. Like OpenCode, it replays every registered transform on a fresh copy of the base
 * configuration whenever it is reloaded.
 */
export function fakeContext(base: Record<string, Server>) {
  const callbacks = new Set<(editor: Editor) => void>()
  let servers = new Map<string, Server>()
  let reloads = 0

  const apply = () => {
    const next = new Map<string, Server>(Object.entries(structuredClone(base)))
    const editor: Editor = {
      list: () => [...next],
      get: (name) => next.get(name),
      set: (name, config) => void next.set(name, config),
      update: (name, update) => {
        const config = next.get(name)
        if (config) update(config)
      },
      remove: (name) => void next.delete(name),
    }
    callbacks.forEach((callback) => callback(editor))
    servers = next
  }

  const ctx = {
    mcp: {
      transform: async (callback: (editor: Editor) => void) => {
        callbacks.add(callback)
        apply()
        return {
          dispose: async () => {
            callbacks.delete(callback)
          },
        }
      },
      reload: async () => {
        reloads++
        apply()
      },
    },
  } as unknown as Parameters<Plugin.Plugin["setup"]>[0]

  return {
    ctx,
    servers: () => Object.fromEntries(servers) as Record<string, Server>,
    reloads: () => reloads,
    reload: () => ctx.mcp.reload(),
  }
}

/** A lookup whose answers are scripted per name, and which records every call. */
export function fakeLookup(answers: Record<string, string | Error>, options: { hold?: boolean } = {}) {
  const calls: string[] = []
  let release!: () => void
  const gate = options.hold ? new Promise<void>((resolve) => (release = resolve)) : undefined
  const lookup = async (ref: { service: string; account?: string }) => {
    const name = ref.account ? `${ref.service}/${ref.account}` : ref.service
    calls.push(name)
    await gate
    const answer = answers[name]
    if (answer === undefined) throw new Error("secret not found or empty")
    if (answer instanceof Error) throw answer
    return answer
  }
  return { lookup, calls, release: () => release() }
}

export function fakeLog() {
  const lines: string[] = []
  const record = (...args: unknown[]) => void lines.push(args.map(String).join(" "))
  return { log: { warn: record, error: record }, lines }
}

/** Wait until `check` holds, or fail after a timeout. Never sleeps for a fixed time. */
export async function until(check: () => boolean, timeoutMs = 10_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not reached in time")
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

/** Let any pending promise callbacks run, to assert that something did NOT happen. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 20))
