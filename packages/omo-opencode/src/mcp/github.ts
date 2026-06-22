import { log } from "../shared/logger"
import type { LocalMcpConfig } from "./lsp"

export function createGithubMcpConfig(): LocalMcpConfig | undefined {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN

  if (!token) {
    log("[github-mcp] GITHUB_PERSONAL_ACCESS_TOKEN not set — skipping GitHub MCP")
    return undefined
  }

  return {
    type: "local",
    command: ["npx", "-y", "@github/github-mcp-server"],
    enabled: true,
    environment: {
      GITHUB_PERSONAL_ACCESS_TOKEN: token,
    },
  }
}
