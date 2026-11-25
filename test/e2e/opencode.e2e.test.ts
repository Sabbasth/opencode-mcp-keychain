import { afterEach, describe, expect, test } from "bun:test"
import { addSecret, deleteSecret, keychainEnabled, uniqueService } from "../helpers/keychain.ts"
import { enabled, fixture, type Fixture } from "./harness.ts"

const LONG = 90_000

// Runs a real `opencode serve` with the plugin loaded from this checkout and reads server statuses from its API.
describe.skipIf(!enabled)("plugin in a real OpenCode server", () => {
  let current: Fixture | undefined
  const setup = async () => (current = await fixture())
  afterEach(async () => {
    await current?.dispose()
    current = undefined
  })

  test(
    "a missing secret fails the server with an explanation and never launches it",
    async () => {
      const f = await setup()
      const service = uniqueService()
      const running = await f.start({
        probe: { type: "local", command: [f.probe], environment: { KC_E2E: `{keychain:${service}}` } },
      })

      const [server] = await running.waitFor(
        (servers) => servers.some((s) => s.name === "probe" && s.status.status === "failed"),
        "probe to be reported as failed",
      )
      expect(server!.status.error).toContain(`{keychain:${service}}`)
      expect(server!.status.error).toContain("could not be found")
      expect(server!.status.error).toContain(`security add-generic-password -s ${service} -w`)
      expect(await f.launches()).toEqual([])
    },
    LONG,
  )

  test(
    "a server disabled by the user is left disabled and is not launched",
    async () => {
      const f = await setup()
      const running = await f.start({
        probe: {
          type: "local",
          command: [f.probe],
          disabled: true,
          environment: { KC_E2E: `{keychain:${uniqueService()}}` },
        },
        other: { type: "local", command: [f.probe], disabled: true },
      })

      const servers = await running.waitFor((list) => list.length === 2, "both servers to be listed")
      expect(servers.map((s) => [s.name, s.status.status]).sort()).toEqual([
        ["other", "disabled"],
        ["probe", "disabled"],
      ])
      expect(await f.launches()).toEqual([])
    },
    LONG,
  )

  describe.skipIf(!keychainEnabled)("with a secret in the keychain", () => {
    const stored: Array<[string, string]> = []
    afterEach(() => {
      stored.splice(0).forEach(([service, account]) => deleteSecret(service, account))
    })
    const store = (value: string, account = "e2e") => {
      const service = uniqueService()
      addSecret(service, account, value)
      stored.push([service, account])
      return service
    }

    test(
      "launches the server once the secret is read, with the real value everywhere",
      async () => {
        const f = await setup()
        const value = "e2e-secret-value-7f3a"
        const service = store(value)
        const running = await f.start({
          probe: {
            type: "local",
            command: [f.probe, `Bearer {keychain:${service}/e2e}`],
            environment: { KC_E2E: `{keychain:${service}/e2e}` },
          },
        })

        const deadline = Date.now() + 45_000
        let launches = await f.launches()
        while (launches.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          launches = await f.launches()
        }

        if (launches.length === 0) throw new Error(`the probe was never launched\n${await running.diagnostics()}`)
        for (const line of launches) {
          expect(line).toBe(`KEY=${value} ARG=Bearer ${value}`)
          expect(line).not.toContain("{keychain:")
        }
        // The probe does not speak MCP, so it is reported as failed or pending, but never with a placeholder.
        const servers = await running.servers()
        expect(JSON.stringify(servers)).not.toContain(value)
      },
      LONG,
    )

    test(
      "a secret that only exists for one of two references still fails the server",
      async () => {
        const f = await setup()
        const present = store("present-value")
        const absent = uniqueService()
        const running = await f.start({
          probe: {
            type: "local",
            command: [f.probe],
            environment: { KC_E2E: `{keychain:${present}/e2e}`, OTHER: `{keychain:${absent}}` },
          },
        })

        const [server] = await running.waitFor(
          (servers) => servers.some((s) => s.status.status === "failed"),
          "probe to be reported as failed",
        )
        expect(server!.status.error).toContain(`{keychain:${absent}}`)
        expect(server!.status.error).not.toContain("present-value")
        expect(await f.launches()).toEqual([])
      },
      LONG,
    )
  })
})
