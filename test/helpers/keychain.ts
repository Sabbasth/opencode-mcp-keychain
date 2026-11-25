import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"

/** Tests that touch the real keychain only run when explicitly enabled, on macOS. */
export const keychainEnabled = process.env.KEYCHAIN_INTEGRATION === "1" && process.platform === "darwin"

export const uniqueService = () => `opencode-mcp-keychain-test-${randomBytes(6).toString("hex")}`

function security(...args: string[]) {
  const result = spawnSync("security", args, { encoding: "utf8" })
  return { ok: result.status === 0, stderr: result.stderr.trim() }
}

export function addSecret(service: string, account: string, value: string) {
  const result = security("add-generic-password", "-U", "-s", service, "-a", account, "-w", value)
  if (!result.ok) throw new Error(`cannot store test secret: ${result.stderr}`)
}

export function deleteSecret(service: string, account: string) {
  security("delete-generic-password", "-s", service, "-a", account)
}
