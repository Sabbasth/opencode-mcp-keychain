import { describe, expect, test } from "bun:test"
import { collect, substitute } from "../../src/substitute.ts"

const secrets: Record<string, string> = {
  token: "tok-123",
  "svc/acct": "pw-456",
}
const resolve = (name: string) => {
  const value = secrets[name]
  if (value === undefined) throw new Error(`unexpected lookup: ${name}`)
  return value
}

describe("collect", () => {
  test("returns nothing when there is no reference", () => {
    expect([...collect({ url: "https://example.com", list: ["a", "b"], n: 1 })]).toEqual([])
  })

  test("finds a reference in a plain string", () => {
    expect([...collect("{keychain:token}")]).toEqual(["token"])
  })

  test("finds references embedded in a larger string", () => {
    expect([...collect("Bearer {keychain:token}")]).toEqual(["token"])
  })

  test("finds several references in one string", () => {
    expect([...collect("{keychain:a}:{keychain:b}")]).toEqual(["a", "b"])
  })

  test("deduplicates repeated names", () => {
    expect([...collect({ a: "{keychain:x}", b: ["{keychain:x}", "{keychain:y}"] })]).toEqual(["x", "y"])
  })

  test("walks nested objects and arrays", () => {
    const config = {
      type: "remote",
      headers: { Authorization: "Bearer {keychain:token}" },
      command: ["run", "--key", "{keychain:svc/acct}"],
      oauth: { client_secret: "{keychain:secret}" },
    }
    expect([...collect(config)].sort()).toEqual(["secret", "svc/acct", "token"])
  })

  test("keeps the account part of a service/account name", () => {
    expect([...collect("{keychain:svc/acct}")]).toEqual(["svc/acct"])
  })

  test("ignores object keys, only values count", () => {
    expect([...collect({ "{keychain:key}": "value" })]).toEqual([])
  })

  test("ignores other keywords and malformed references", () => {
    expect([...collect(["{env:TOKEN}", "{file:/x}", "{keychain:}", "{keychain:open", "keychain:token"])]).toEqual([])
  })

  test("ignores null, numbers and booleans", () => {
    expect([...collect({ a: null, b: 1, c: true, d: undefined })]).toEqual([])
  })

  test("accumulates into a provided set", () => {
    const into = new Set(["existing"])
    collect("{keychain:added}", into)
    expect([...into]).toEqual(["existing", "added"])
  })
})

describe("substitute", () => {
  test("replaces a reference spanning the whole string", () => {
    expect(substitute("{keychain:token}", resolve)).toBe("tok-123")
  })

  test("replaces a reference inside a larger string", () => {
    expect(substitute("Bearer {keychain:token}", resolve)).toBe("Bearer tok-123")
  })

  test("replaces every occurrence", () => {
    expect(substitute("{keychain:token}-{keychain:svc/acct}-{keychain:token}", resolve)).toBe(
      "tok-123-pw-456-tok-123",
    )
  })

  test("replaces nested values in place and returns the same object", () => {
    const config = {
      headers: { Authorization: "Bearer {keychain:token}" },
      command: ["run", "{keychain:svc/acct}"],
      timeout: { startup: 1000 },
      disabled: false,
    }
    const result = substitute(config, resolve)
    expect(result).toBe(config)
    expect(config).toEqual({
      headers: { Authorization: "Bearer tok-123" },
      command: ["run", "pw-456"],
      timeout: { startup: 1000 },
      disabled: false,
    })
  })

  test("leaves other keywords and plain text untouched", () => {
    const input = ["{env:TOKEN}", "{file:/x}", "plain", "{keychain:}"]
    expect(substitute([...input], resolve)).toEqual(input)
  })

  test("does not call resolve when there is no reference", () => {
    expect(substitute({ a: "x", b: ["y"] }, () => { throw new Error("should not be called") })).toEqual({
      a: "x",
      b: ["y"],
    })
  })

  test("inserts secrets literally, without interpreting replacement patterns", () => {
    expect(substitute("{keychain:x}", () => "a$&b$1c$$d")).toBe("a$&b$1c$$d")
  })

  test("does not re-scan a substituted value", () => {
    expect(substitute("{keychain:x}", () => "{keychain:y}")).toBe("{keychain:y}")
  })

  test("passes the raw reference name to resolve", () => {
    const seen: string[] = []
    substitute("{keychain:svc/acct}", (name) => (seen.push(name), "v"))
    expect(seen).toEqual(["svc/acct"])
  })

  test("returns primitives that are not strings unchanged", () => {
    expect(substitute(42, resolve)).toBe(42)
    expect(substitute(null, resolve)).toBe(null)
    expect(substitute(true, resolve)).toBe(true)
  })
})
