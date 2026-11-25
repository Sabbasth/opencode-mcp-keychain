import { execFile } from "node:child_process"

export interface Reference {
  readonly service: string
  readonly account?: string
}

/** `service` or `service/account`. The first `/` separates the account. */
export function parseReference(name: string): Reference {
  const index = name.indexOf("/")
  if (index === -1) return { service: name.trim() }
  return { service: name.slice(0, index).trim(), account: name.slice(index + 1).trim() || undefined }
}

// Generous timeout: macOS may show an access prompt the user has to answer.
const TIMEOUT = 60_000

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: TIMEOUT, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT") return reject(new Error(`${command} not found`))
        return reject(new Error(stderr.trim() || error.message))
      }
      resolve(stdout.replace(/\r?\n$/, ""))
    })
  })
}

/** Read a generic password from the OS keychain. Never logs the value. */
export function lookup(ref: Reference): Promise<string> {
  if (!ref.service) return Promise.reject(new Error("empty service name"))
  switch (process.platform) {
    case "darwin":
      return run("security", [
        "find-generic-password",
        "-s",
        ref.service,
        ...(ref.account ? ["-a", ref.account] : []),
        "-w",
      ])
    case "linux":
      return run("secret-tool", ["lookup", "service", ref.service, ...(ref.account ? ["account", ref.account] : [])]).then(
        (value) => {
          if (!value) throw new Error("secret not found")
          return value
        },
      )
    default:
      return Promise.reject(new Error(`unsupported platform: ${process.platform}`))
  }
}
