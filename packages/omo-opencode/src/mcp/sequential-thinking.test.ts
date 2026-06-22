import { describe, expect, test } from "bun:test"
import { createSequentialThinkingMcpConfig } from "./sequential-thinking"

describe("createSequentialThinkingMcpConfig", () => {
  test("returns a local stdio MCP config", () => {
    // when
    const config = createSequentialThinkingMcpConfig()

    // then
    expect(config.type).toBe("local")
    expect(config.command).toEqual([
      "npx",
      "-y",
      "@modelcontextprotocol/server-sequential-thinking",
    ])
    expect(config.enabled).toBe(true)
  })
})
