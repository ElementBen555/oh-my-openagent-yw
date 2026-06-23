import type { CommandDefinition } from "../features/claude-code-command-loader/types";
import {
	discoverInstalledPlugins,
	loadPluginCommands,
	loadPluginSkillsAsCommands,
} from "../features/claude-code-plugin-loader";

export interface PluginCommandDiscoveryOptions {
	pluginsEnabled?: boolean;
	enabledPluginsOverride?: Record<string, boolean>;
}

export function discoverPluginCommandDefinitions(
	options?: PluginCommandDiscoveryOptions,
): Record<string, CommandDefinition> {
	if (options?.pluginsEnabled === false) {
		return {};
	}

	const { plugins } = discoverInstalledPlugins({
		enabledPluginsOverride: options?.enabledPluginsOverride,
	});

	return {
		...loadPluginCommands(plugins),
		...loadPluginSkillsAsCommands(plugins),
	};
}
