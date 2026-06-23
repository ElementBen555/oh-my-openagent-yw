import type { OhMyOpenCodeConfig } from "../config";
import type { BackgroundManager } from "../features/background-agent";

import { createUnstableAgentBabysitterHook } from "../hooks";
import type { PluginContext } from "./types";

export function createUnstableAgentBabysitter(args: {
	ctx: PluginContext;
	backgroundManager: BackgroundManager;
	pluginConfig: OhMyOpenCodeConfig;
}) {
	const { ctx, backgroundManager, pluginConfig } = args;

	return createUnstableAgentBabysitterHook(
		{
			directory: ctx.directory,
			client: {
				session: {
					messages: async ({ path }) => {
						const result = await ctx.client.session.messages({ path });
						if (Array.isArray(result)) return result;
						if (typeof result === "object" && result !== null) {
							return result;
						}
						return [];
					},
					status: async () => ctx.client.session.status(),
					promptAsync: async (promptArgs) => ctx.client.session.promptAsync(promptArgs),
				},
			},
		},
		{
			backgroundManager,
			config: pluginConfig.babysitting,
		},
	);
}
