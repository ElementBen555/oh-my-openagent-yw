import type { LocalMcpConfig } from "./lsp";

export function createSequentialThinkingMcpConfig(): LocalMcpConfig {
	return {
		type: "local",
		command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
		enabled: true,
	};
}
