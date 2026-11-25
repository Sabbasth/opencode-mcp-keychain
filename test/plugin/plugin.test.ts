import { describe, expect, test } from "bun:test"
import { createPlugin, ID } from "../../src/plugin.ts"
import { fakeContext, fakeLog, fakeLookup, flush, until } from "../helpers/fake-context.ts"

const remote = {
  type: "remote",
  url: "https://api.example.com/mcp",
  oauth: false,
  headers: { Authorization: "Bearer {keychain:api-token}" },
}
const local = {
  type: "local",
  command: ["server", "--key", "{keychain:svc/acct}"],
  environment: { TOKEN: "{keychain:api-token}", PLAIN: "x" },
}

async function start(
  base: Record<string, any>,
  answers: Record<string, string | Error>,
  options: { platform?: NodeJS.Platform; hold?: boolean } = {},
) {
  const context = fakeContext(base)
  const { lookup, calls, release } = fakeLookup(answers, { hold: options.hold })
  const { log, lines } = fakeLog()
  const plugin = createPlugin({ lookup, log, platform: options.platform ?? "darwin" })
  const cleanup = (await plugin.setup(context.ctx)) as () => Promise<void>
  return { ...context, calls, lines, cleanup, release }
}

describe("plugin identity", () => {
  test("registers as mcp-keychain", () => {
    expect(ID).toBe("mcp-keychain")
    expect(createPlugin({ lookup: async () => "" }).id).toBe("mcp-keychain")
  })
})

describe("servers without references", () => {
  test("are left untouched, with no lookup and no reload", async () => {
    const base = { plain: { type: "remote", url: "https://x.example", headers: { A: "b" } } }
    const t = await start(base, {})
    await flush()
    expect(t.servers()).toEqual(base)
    expect(t.calls).toEqual([])
    expect(t.reloads()).toBe(0)
  })
})

describe("resolving secrets", () => {
  test("keeps the server disabled until the secret is read, then substitutes it after one reload", async () => {
    const t = await start({ api: remote }, { "api-token": "tok-1" }, { hold: true })
    expect(t.servers().api!.disabled).toBe(true)
    expect(t.reloads()).toBe(0)

    t.release()
    await until(() => t.reloads() === 1)
    expect(t.servers().api).toEqual({
      type: "remote",
      url: "https://api.example.com/mcp",
      oauth: false,
      headers: { Authorization: "Bearer tok-1" },
    })
    await flush()
    expect(t.reloads()).toBe(1)
  })

  test("substitutes references in every part of a local server", async () => {
    const t = await start({ srv: local }, { "api-token": "tok-1", "svc/acct": "pw-2" })
    await until(() => t.reloads() === 1)
    expect(t.servers().srv).toEqual({
      type: "local",
      command: ["server", "--key", "pw-2"],
      environment: { TOKEN: "tok-1", PLAIN: "x" },
    })
  })

  test("reads a secret shared by several servers once, with a single reload", async () => {
    const t = await start({ a: remote, b: local }, { "api-token": "tok-1", "svc/acct": "pw-2" })
    await until(() => t.reloads() >= 1)
    await flush()
    expect(t.calls.filter((name) => name === "api-token")).toHaveLength(1)
    expect(t.reloads()).toBe(1)
    expect(t.servers().a!.headers.Authorization).toBe("Bearer tok-1")
    expect(t.servers().b!.environment.TOKEN).toBe("tok-1")
  })

  test("waits for every secret of a server before connecting it", async () => {
    const t = await start({ srv: local }, { "api-token": "tok-1", "svc/acct": "pw-2" }, { hold: true })
    expect(t.servers().srv!.disabled).toBe(true)
    t.release()
    await until(() => t.reloads() === 1)
    expect(t.servers().srv!.disabled).toBeUndefined()
  })

  test("does not read a secret again on later reloads", async () => {
    const t = await start({ api: remote }, { "api-token": "tok-1" })
    await until(() => t.reloads() === 1)
    await t.reload()
    await t.reload()
    expect(t.calls).toEqual(["api-token"])
    expect(t.servers().api!.headers.Authorization).toBe("Bearer tok-1")
  })

  test("never leaves a placeholder in a connectable server", async () => {
    const t = await start({ api: remote }, { "api-token": "tok-1" }, { hold: true })
    const connectable = (server: any) => !server.disabled && JSON.stringify(server).includes("{keychain:")
    expect(connectable(t.servers().api)).toBe(false)
    t.release()
    await until(() => t.reloads() === 1)
    expect(connectable(t.servers().api)).toBe(false)
  })
})

describe("missing secrets", () => {
  test("turn the server into a failing one that explains the problem", async () => {
    const t = await start({ api: remote }, {}, { platform: "darwin" })
    await until(() => t.reloads() === 1)
    const server = t.servers().api!
    expect(server.type).toBe("local")
    expect(server.command.slice(0, 2)).toEqual(["/bin/sh", "-c"])
    const message = server.command.at(-1) as string
    expect(message).toContain("mcp-keychain: cannot read {keychain:api-token}")
    expect(message).toContain("secret not found or empty")
    expect(message).toContain("security add-generic-password -s api-token -w")
    expect(message).toContain("/reload")
  })

  test("suggest secret-tool on Linux and include the account", async () => {
    const t = await start({ srv: local }, { "api-token": "tok-1" }, { platform: "linux" })
    await until(() => t.reloads() === 1)
    const message = t.servers().srv!.command.at(-1) as string
    expect(message).toContain("{keychain:svc/acct}")
    expect(message).toContain("secret-tool store --label svc service svc account acct")
  })

  test("do not loop: one lookup and one reload, however many times the config is replayed", async () => {
    const t = await start({ api: remote }, {})
    await until(() => t.reloads() === 1)
    await t.reload()
    await t.reload()
    await flush()
    expect(t.calls).toEqual(["api-token"])
    expect(t.reloads()).toBe(3)
  })

  test("describe every failing secret of a server", async () => {
    const t = await start({ srv: local }, {})
    await until(() => t.reloads() === 1)
    const message = t.servers().srv!.command.at(-1) as string
    expect(message).toContain("{keychain:api-token}")
    expect(message).toContain("{keychain:svc/acct}")
  })

  test("do not disclose secrets that were read for the same server", async () => {
    const t = await start({ srv: local }, { "api-token": "TOPSECRET-VALUE" })
    await until(() => t.reloads() === 1)
    expect(JSON.stringify(t.servers().srv)).not.toContain("TOPSECRET-VALUE")
  })

  test("only affect the servers that need the missing secret", async () => {
    const other = { type: "remote", url: "https://o.example", headers: { K: "{keychain:good}" } }
    const t = await start({ api: remote, other }, { good: "ok-value" })
    await until(() => t.reloads() >= 1)
    await flush()
    expect(t.servers().api!.type).toBe("local")
    expect(t.servers().other!.headers.K).toBe("ok-value")
  })

  test("keep the failing command safe whatever the secret name contains", async () => {
    const evil = { type: "remote", url: "https://x.example", headers: { K: "{keychain:a'; touch /tmp/pwned-$(id) #}" } }
    const t = await start({ evil }, {})
    await until(() => t.reloads() === 1)
    const [command, ...args] = t.servers().evil!.command as string[]
    const run = Bun.spawnSync([command!, ...args])
    expect(run.exitCode).toBe(1)
    expect(run.stdout.toString()).toBe("")
    expect(run.stderr.toString()).toBe(`${args.at(-1)}\n`)
    expect(run.stderr.toString()).toContain("touch /tmp/pwned-$(id) #")
  })
})

describe("servers disabled by the user", () => {
  test("are left alone, with no lookup", async () => {
    const t = await start({ off: { ...remote, disabled: true } }, {})
    await flush()
    expect(t.calls).toEqual([])
    expect(t.reloads()).toBe(0)
    expect(t.servers().off).toEqual({ ...remote, disabled: true })
  })
})

describe("logs", () => {
  test("never contain a secret value", async () => {
    const t = await start({ a: remote, b: local }, { "api-token": "TOPSECRET-VALUE" })
    await until(() => t.reloads() >= 1)
    await flush()
    expect(t.lines.join("\n")).not.toContain("TOPSECRET-VALUE")
    expect(t.lines.some((line) => line.includes("{keychain:svc/acct}"))).toBe(true)
  })

  test("a failing reload is reported, not thrown", async () => {
    const context = fakeContext({ api: remote })
    ;(context.ctx.mcp as any).reload = async () => {
      throw new Error("reload exploded")
    }
    const { lookup } = fakeLookup({ "api-token": "tok-1" })
    const { log, lines } = fakeLog()
    await createPlugin({ lookup, log }).setup(context.ctx)
    await until(() => lines.length > 0)
    expect(lines[0]).toContain("MCP reload failed")
  })
})

describe("cleanup", () => {
  test("a lookup that settles after cleanup does not trigger a reload", async () => {
    let release!: (value: string) => void
    const context = fakeContext({ api: remote })
    const lookup = () => new Promise<string>((resolve) => (release = resolve))
    const cleanup = (await createPlugin({ lookup, log: fakeLog().log }).setup(context.ctx)) as () => Promise<void>
    await cleanup()
    release("tok-1")
    await flush()
    expect(context.reloads()).toBe(0)
  })
})
