import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { lookup } from "../../src/keychain.ts"
import { addSecret, deleteSecret, keychainEnabled, uniqueService } from "../helpers/keychain.ts"

setDefaultTimeout(30_000)

// Writes temporary items to the default keychain. CI points it at a throwaway keychain.
describe.skipIf(!keychainEnabled)("real macOS keychain", () => {
  const created: Array<[string, string]> = []
  const store = (value: string, account = "tester") => {
    const service = uniqueService()
    addSecret(service, account, value)
    created.push([service, account])
    return service
  }

  afterAll(() => created.forEach(([service, account]) => deleteSecret(service, account)))

  test("reads a secret by service", async () => {
    const service = store("plain-value")
    expect(await lookup({ service })).toBe("plain-value")
  })

  test("reads a secret by service and account", async () => {
    const service = store("for-alice", "alice")
    expect(await lookup({ service, account: "alice" })).toBe("for-alice")
  })

  test("does not return a secret stored under another account", async () => {
    const service = store("for-alice", "alice")
    await expect(lookup({ service, account: "bob" })).rejects.toThrow(/could not be found/)
  })

  test("round-trips a plain test string", async () => {
    const value = "thisIsATestStringusedForTestPurposes"
    const service = store(value)
    expect(await lookup({ service })).toBe(value)
  })

  test("rejects a missing secret with the reason from the keychain", async () => {
    await expect(lookup({ service: uniqueService() })).rejects.toThrow(/could not be found/)
  })
})
