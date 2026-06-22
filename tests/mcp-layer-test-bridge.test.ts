import { describe, expect, test } from "bun:test"

function runVitest(packagePath: string): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["npm", "--prefix", packagePath, "run", "test"],
    cwd: process.cwd(),
    env: { ...process.env, CI: "true" },
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  }
}

describe("MCP layer test bridge", () => {
  test("lsp-tools-mcp vitest suite passes", () => {
    // given
    const result = runVitest("packages/lsp-tools-mcp")

    // then
    if (result.exitCode !== 0) {
      console.error("--- lsp-tools-mcp stdout ---")
      console.error(result.stdout)
      console.error("--- lsp-tools-mcp stderr ---")
      console.error(result.stderr)
    }
    expect(result.exitCode).toBe(0)
  })

  test("lsp-daemon vitest suite passes", () => {
    // given
    const result = runVitest("packages/lsp-daemon")

    // then
    if (result.exitCode !== 0) {
      console.error("--- lsp-daemon stdout ---")
      console.error(result.stdout)
      console.error("--- lsp-daemon stderr ---")
      console.error(result.stderr)
    }
    expect(result.exitCode).toBe(0)
  })
})
