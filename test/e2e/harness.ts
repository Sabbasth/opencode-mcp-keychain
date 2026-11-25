import { spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

export const enabled = process.env.OPENCODE_E2E === "1"
export const PLUGIN_DIR = path.resolve(import.meta.dir, "../..")
const BIN = process.env.OPENCODE_BIN ?? "opencode"
const PASSWORD = "e2e-password"

export interface McpServer {
  readonly name: string
  readonly status: { readonly status: string; readonly error?: string }
}

export interface Fixture {
  readonly project: string
  /** A stdio "server" that logs every launch (environment value and first argument) and then idles. */
  readonly probe: string
  launches(): Promise<string[]>
  start(servers: Record<string, unknown>): Promise<Running>
  dispose(): Promise<void>
}

export interface Running {
  servers(): Promise<McpServer[]>
  /** The server list and the tail of OpenCode's own output, for failure messages. */
  diagnostics(): Promise<string>
  /** Poll the server list until `check` holds. */
  waitFor(check: (servers: McpServer[]) => boolean, what: string, timeoutMs?: number): Promise<McpServer[]>
  stop(): Promise<void>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/**
 * A throwaway project and OpenCode state. XDG variables keep the user's own configuration out of the test, while
 * HOME is left alone because the keychain lives there.
 */
export async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "mcp-keychain-e2e-")))
  const project = path.join(root, "project")
  await mkdir(project)
  const log = path.join(root, "launches.log")
  const probe = path.join(root, "probe.sh")
  await writeFile(probe, `#!/bin/sh\necho "KEY=$KC_E2E ARG=$1" >> '${log}'\nexec sleep 20\n`)
  await chmod(probe, 0o755)

  const running = new Set<Running>()

  return {
    project,
    probe,
    launches: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean),
    async start(servers) {
      await writeFile(
        path.join(project, "opencode.jsonc"),
        JSON.stringify({ plugins: [PLUGIN_DIR], mcp: { servers } }, null, 2),
      )
      const port = await freePort()
      const output: string[] = []
      const child: ChildProcess = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: project,
        env: {
          ...process.env,
          OPENCODE_PASSWORD: PASSWORD,
          XDG_CONFIG_HOME: path.join(root, "xdg-config"),
          XDG_DATA_HOME: path.join(root, "xdg-data"),
          XDG_STATE_HOME: path.join(root, "xdg-state"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      })
      child.stdout!.on("data", (chunk) => output.push(String(chunk)))
      child.stderr!.on("data", (chunk) => output.push(String(chunk)))
      let exited = false
      child.once("exit", () => (exited = true))

      const base = `http://127.0.0.1:${port}`
      const headers = { Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` }
      const fail = (message: string) => new Error(`${message}\n--- opencode output ---\n${output.join("").slice(-3000)}`)

      for (let attempt = 0; ; attempt++) {
        if (exited) throw fail("opencode serve exited before it was ready")
        if (attempt > 120) throw fail("opencode serve was not ready in time")
        const ready = await fetch(`${base}/api/info`, { headers }).then((response) => response.ok, () => false)
        if (ready) break
        await sleep(250)
      }

      const servers_ = async (): Promise<McpServer[]> => {
        const url = new URL(`${base}/api/mcp`)
        url.searchParams.set("location[directory]", project)
        const response = await fetch(url, { headers })
        if (!response.ok) throw fail(`GET /api/mcp failed: ${response.status} ${await response.text()}`)
        return ((await response.json()) as { data: McpServer[] }).data
      }

      // OpenCode loads a project, with its plugins and MCP servers, on the first request that names it.
      await servers_()

      const handle: Running = {
        servers: servers_,
        async diagnostics() {
          const list = await servers_().then(
            (servers) => JSON.stringify(servers),
            (error) => `GET /api/mcp failed: ${error}`,
          )
          return `servers: ${list}\n--- opencode output ---\n${output.join("").slice(-3000)}`
        },
        async waitFor(check, what, timeoutMs = 30_000) {
          const start = Date.now()
          let last: McpServer[] = []
          while (Date.now() - start < timeoutMs) {
            last = await servers_()
            if (check(last)) return last
            await sleep(250)
          }
          throw fail(`timed out waiting for: ${what}. Last servers: ${JSON.stringify(last)}`)
        },
        async stop() {
          running.delete(handle)
          if (exited) return
          const done = new Promise((resolve) => child.once("exit", resolve))
          child.kill("SIGTERM")
          await Promise.race([done, sleep(5000).then(() => child.kill("SIGKILL"))])
        },
      }
      running.add(handle)
      return handle
    },
    async dispose() {
      await Promise.all([...running].map((handle) => handle.stop()))
      await rm(root, { recursive: true, force: true })
    },
  }
}
