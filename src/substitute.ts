const PATTERN = /\{keychain:([^}]+)\}/g

/** Every `{keychain:<name>}` name found in string values of `value`, recursively. */
export function collect(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(PATTERN)) into.add(match[1]!)
  } else if (Array.isArray(value)) {
    value.forEach((item) => collect(item, into))
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collect(item, into))
  }
  return into
}

/** Replace references in place. `resolve` must return a value for every collected name. */
export function substitute(value: unknown, resolve: (name: string) => string): unknown {
  if (typeof value === "string") return value.replace(PATTERN, (_, name: string) => resolve(name))
  if (Array.isArray(value)) {
    value.forEach((item, index) => (value[index] = substitute(item, resolve)))
    return value
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) record[key] = substitute(record[key], resolve)
    return record
  }
  return value
}
