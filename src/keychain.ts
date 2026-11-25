import { execFile } from "node:child_process"

export interface Reference {
  readonly service: string
  readonly account?: string
}

export interface Command {
  readonly command: string
  readonly args: string[]
}

export type Runner = (command: string, args: string[]) => Promise<string>

export interface Environment {
  readonly platform?: NodeJS.Platform
  readonly run?: Runner
}

/** `service` or `service/account`. The first `/` separates the account. */
export function parseReference(name: string): Reference {
  const index = name.indexOf("/")
  if (index === -1) return { service: name.trim() }
  return { service: name.slice(0, index).trim(), account: name.slice(index + 1).trim() || undefined }
}

/** The platform command that prints a generic password. Throws on an unsupported platform. */
export function buildCommand(ref: Reference, platform: NodeJS.Platform): Command {
  switch (platform) {
    case "darwin":
      return {
        command: "security",
        args: ["find-generic-password", "-s", ref.service, ...(ref.account ? ["-a", ref.account] : []), "-w"],
      }
    case "linux":
      return {
        command: "secret-tool",
        args: ["lookup", "service", ref.service, ...(ref.account ? ["account", ref.account] : [])],
      }
    default:
      throw new Error(`unsupported platform: ${platform}`)
  }
}

// Generous timeout: macOS may show an access prompt the user has to answer.
const TIMEOUT = 60_000

export const run: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: TIMEOUT, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT") return reject(new Error(`${command} not found`))
        return reject(new Error(stderr.trim() || error.message))
      }
      resolve(stdout.replace(/\r?\n$/, ""))
    })
  })

/** Read a generic password from the OS keychain. Never logs the value. */
export async function lookup(ref: Reference, environment: Environment = {}): Promise<string> {
  if (!ref.service) throw new Error("empty service name")
  const platform = environment.platform ?? process.platform
  const { command, args } = buildCommand(ref, platform)
  const value = await (environment.run ?? run)(command, args)
  // secret-tool prints nothing and exits 0 when the item does not exist, and an empty secret is never useful.
  if (!value) throw new Error("secret not found or empty")
  return value
}

const SAFE = /^[\w.@:+-]+$/
const quote = (value: string) => (SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`)

/** The command that stores the secret, for error messages. Empty on an unsupported platform. */
export function storeHint(ref: Reference, platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return `security add-generic-password -s ${quote(ref.service)}${ref.account ? ` -a ${quote(ref.account)}` : ""} -w`
    case "linux":
      return `secret-tool store --label ${quote(ref.service)} service ${quote(ref.service)}${ref.account ? ` account ${quote(ref.account)}` : ""}`
    default:
      return ""
  }
}
