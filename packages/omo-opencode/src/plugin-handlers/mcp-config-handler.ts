import type { OhMyOpenCodeConfig } from "../config";
import { loadMcpConfigs } from "../features/claude-code-mcp-loader";
import { createBuiltinMcps } from "../mcp";
import { probeBuiltinRemoteMcps } from "../mcp/mcp-health-check";
import { log } from "../shared";
import type { PluginComponents } from "./plugin-components-loader";

type McpEntry = Record<string, unknown>;

function isDisabledMcpEntry(value: unknown): value is McpEntry & { enabled: false } {
	return typeof value === "object" && value !== null && (value as McpEntry).enabled === false;
}

function captureUserDisabledMcps(userMcp: Record<string, unknown> | undefined): Set<string> {
	const disabled = new Set<string>();
	if (!userMcp) return disabled;

	for (const [name, value] of Object.entries(userMcp)) {
		if (isDisabledMcpEntry(value)) {
			disabled.add(name);
		}
	}

	return disabled;
}

export async function applyMcpConfig(params: {
	config: Record<string, unknown>;
	ctx: { directory: string };
	pluginConfig: OhMyOpenCodeConfig;
	pluginComponents: PluginComponents;
}): Promise<void> {
	const disabledMcps = params.pluginConfig.disabled_mcps ?? [];
	const userMcp = params.config.mcp as Record<string, unknown> | undefined;
	const userDisabledMcps = captureUserDisabledMcps(userMcp);

	const mcpResult =
		(params.pluginConfig.claude_code?.mcp ?? true) ? await loadMcpConfigs(disabledMcps) : { servers: {} };

	if (userMcp) {
		for (const name of Object.keys(userMcp)) {
			if (name in mcpResult.servers) {
				log(`warning: MCP server "${name}" from user config overrides Claude Code .mcp.json`);
			}
		}
	}

	const merged = {
		...createBuiltinMcps(disabledMcps, params.pluginConfig, { cwd: params.ctx.directory }),
		...mcpResult.servers,
		...(userMcp ?? {}),
		...params.pluginComponents.mcpServers,
	} as Record<string, McpEntry>;

	const probed = await probeBuiltinRemoteMcps(merged);

	for (const name of userDisabledMcps) {
		if (probed[name]) {
			probed[name] = { ...probed[name], enabled: false };
		}
	}

	const disabledSet = new Set(disabledMcps);
	for (const name of disabledSet) {
		delete probed[name];
	}

	params.config.mcp = probed;
}
