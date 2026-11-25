import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { buildCommand, lookup, parseReference, run, storeHint, type Runner } from "../../src/keychain.ts"

// Some tests start real processes, which can take seconds on a busy CI runner.
setDefaultTimeout(30_000)

describe("parseReference", () => {
  test("a bare name is a service", () => {
    expect(parseReference("github-mcp")).toEqual({ service: "github-mcp" })
  })

  test("splits service and account on the first slash", () => {
    expect(parseReference("github-mcp/Sabbasth")).toEqual({ service: "github-mcp", account: "Sabbasth" })
  })

  test("keeps further slashes in the account", () => {
    expect(parseReference("svc/a/b")).toEqual({ service: "svc", account: "a/b" })
  })

  test("trims whitespace around both parts", () => {
    expect(parseReference("  svc  /  acct  ")).toEqual({ service: "svc", account: "acct" })
    expect(parseReference("  svc  ")).toEqual({ service: "svc" })
  })

  test("a trailing slash means no account", () => {
    expect(parseReference("svc/")).toEqual({ service: "svc", account: undefined })
  })
})

describe("buildCommand", () => {
  test("macOS uses security find-generic-password", () => {
    expect(buildCommand({ service: "svc" }, "darwin")).toEqual({
      command: "security",
      args: ["find-generic-password", "-s", "svc", "-w"],
    })
  })

  test("macOS adds the account when there is one", () => {
    expect(buildCommand({ service: "svc", account: "me" }, "darwin")).toEqual({
      command: "security",
      args: ["find-generic-password", "-s", "svc", "-a", "me", "-w"],
    })
  })

  test("Linux uses secret-tool with service and account attributes", () => {
    expect(buildCommand({ service: "svc" }, "linux")).toEqual({
      command: "secret-tool",
      args: ["lookup", "service", "svc"],
    })
    expect(buildCommand({ service: "svc", account: "me" }, "linux")).toEqual({
      command: "secret-tool",
      args: ["lookup", "service", "svc", "account", "me"],
    })
  })

  test("passes values as separate arguments, never through a shell", () => {
    const { args } = buildCommand({ service: "a b; rm -rf /", account: "$(whoami)" }, "darwin")
    expect(args).toContain("a b; rm -rf /")
    expect(args).toContain("$(whoami)")
  })

  test("throws on unsupported platforms", () => {
    expect(() => buildCommand({ service: "svc" }, "win32")).toThrow("unsupported platform: win32")
  })
})

describe("lookup", () => {
  const recorder = (output: string | Error) => {
    const calls: Array<[string, string[]]> = []
    const runner: Runner = async (command, args) => {
      calls.push([command, args])
      if (output instanceof Error) throw output
      return output
    }
    return { calls, runner }
  }

  test("runs the platform command and returns its output", async () => {
    const { calls, runner } = recorder("s3cret")
    const value = await lookup({ service: "svc", account: "me" }, { platform: "darwin", run: runner })
    expect(value).toBe("s3cret")
    expect(calls).toEqual([["security", ["find-generic-password", "-s", "svc", "-a", "me", "-w"]]])
  })

  test("rejects an empty service without running anything", async () => {
    const { calls, runner } = recorder("x")
    await expect(lookup({ service: "" }, { platform: "darwin", run: runner })).rejects.toThrow("empty service name")
    expect(calls).toEqual([])
  })

  test("rejects an unsupported platform without running anything", async () => {
    const { calls, runner } = recorder("x")
    await expect(lookup({ service: "svc" }, { platform: "win32", run: runner })).rejects.toThrow(
      "unsupported platform: win32",
    )
    expect(calls).toEqual([])
  })

  test("treats an empty result as a missing secret on every platform", async () => {
    const { runner } = recorder("")
    for (const platform of ["linux", "darwin"] as const) {
      await expect(lookup({ service: "svc" }, { platform, run: runner })).rejects.toThrow("secret not found or empty")
    }
  })

  test("propagates runner errors unchanged", async () => {
    const { runner } = recorder(new Error("item not found"))
    await expect(lookup({ service: "svc" }, { platform: "darwin", run: runner })).rejects.toThrow("item not found")
  })
})

describe("storeHint", () => {
  test("macOS suggests security add-generic-password", () => {
    expect(storeHint({ service: "svc" }, "darwin")).toBe("security add-generic-password -s svc -w")
    expect(storeHint({ service: "svc", account: "me" }, "darwin")).toBe("security add-generic-password -s svc -a me -w")
  })

  test("Linux suggests secret-tool store", () => {
    expect(storeHint({ service: "svc", account: "me" }, "linux")).toBe(
      "secret-tool store --label svc service svc account me",
    )
  })

  test("quotes values that a shell would interpret", () => {
    expect(storeHint({ service: "my svc", account: "it's" }, "darwin")).toBe(
      "security add-generic-password -s 'my svc' -a 'it'\\''s' -w",
    )
  })

  test("has no suggestion on an unsupported platform", () => {
    expect(storeHint({ service: "svc" }, "win32")).toBe("")
  })
})

describe("run", () => {
  test("returns stdout without the trailing newline", async () => {
    expect(await run("echo", ["hello"])).toBe("hello")
  })

  test("keeps inner newlines and leading spaces", async () => {
    expect(await run("printf", ["  a\\nb\\n"])).toBe("  a\nb")
  })

  test("reports a missing binary by name", async () => {
    await expect(run("definitely-not-a-real-binary-xyz", [])).rejects.toThrow(
      "definitely-not-a-real-binary-xyz not found",
    )
  })

  test("uses stderr as the error message when the command fails", async () => {
    await expect(run("sh", ["-c", "echo boom >&2; exit 1"])).rejects.toThrow("boom")
  })

  test("falls back to the process error when stderr is empty", async () => {
    await expect(run("sh", ["-c", "exit 3"])).rejects.toThrow(/Command failed/)
  })
})
