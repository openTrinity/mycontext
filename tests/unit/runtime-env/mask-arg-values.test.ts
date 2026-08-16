import { describe, it, expect } from "vitest"
import { maskArgValues } from "@mycontext/runtime-env"
describe("maskArgValues", () => {
  it("keeps subcommand + flag names, masks values", () => {
    expect(
      maskArgValues([
        "chat",
        "group",
        "members",
        "list-by-ids",
        "--id",
        "cidABC==",
        "--users",
        "D123",
      ]),
    ).toBe("chat group members list-by-ids --id ‹…› --users ‹…›")
  })
  it("masks bare non-subcommand tokens (ids)", () => {
    expect(maskArgValues(["contact", "user", "get", "D0secret"])).toBe("contact user get ‹…›")
  })
  it("boolean flags (no value) stay", () => {
    expect(maskArgValues(["auth", "status", "--json"])).toBe("auth status --json")
  })
})
