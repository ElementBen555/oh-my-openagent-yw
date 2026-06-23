import type { OhMyOpenCodeConfig } from "../../config";
import { contextCollector, createContextInjectorMessagesTransformHook } from "../../features/context-injector";
import type { MonitorManager } from "../../features/monitor";
import {
	createClaudeCodeHooksHook,
	createKeywordDetectorHook,
	createMonitorStatusInjectorHook,
	createTeamMailboxInjector,
	createTeamModeStatusInjector,
	createToolPairValidatorHook,
} from "../../hooks";
import type { RalphLoopHook } from "../../hooks/ralph-loop";
import { safeCreateHook } from "../../shared/safe-create-hook";
import type { PluginContext } from "../types";

export type TransformHooks = {
	claudeCodeHooks: ReturnType<typeof createClaudeCodeHooksHook> | null;
	keywordDetector: ReturnType<typeof createKeywordDetectorHook> | null;
	contextInjectorMessagesTransform: ReturnType<typeof createContextInjectorMessagesTransformHook>;
	teamModeStatusInjector: ReturnType<typeof createTeamModeStatusInjector> | null;
	teamMailboxInjector: ReturnType<typeof createTeamMailboxInjector> | null;
	toolPairValidator: ReturnType<typeof createToolPairValidatorHook> | null;
	monitorStatusInjector: ReturnType<typeof createMonitorStatusInjectorHook> | null;
};

export function createTransformHooks(args: {
	ctx: PluginContext;
	pluginConfig: OhMyOpenCodeConfig;
	isHookEnabled: (hookName: string) => boolean;
	safeHookEnabled?: boolean;
	ralphLoop?: RalphLoopHook | null;
	monitorManager?: MonitorManager;
}): TransformHooks {
	const { ctx, pluginConfig, isHookEnabled, ralphLoop, monitorManager } = args;
	const safeHookEnabled = args.safeHookEnabled ?? true;

	const claudeCodeHooks = isHookEnabled("claude-code-hooks")
		? safeCreateHook(
				"claude-code-hooks",
				() =>
					createClaudeCodeHooksHook(
						ctx,
						{
							disabledHooks: (pluginConfig.claude_code?.hooks ?? true) ? undefined : true,
							keywordDetectorDisabled: !isHookEnabled("keyword-detector"),
						},
						contextCollector,
					),
				{ enabled: safeHookEnabled },
			)
		: null;

	const keywordDetector = isHookEnabled("keyword-detector")
		? safeCreateHook(
				"keyword-detector",
				() =>
					createKeywordDetectorHook(
						ctx,
						contextCollector,
						ralphLoop ?? undefined,
						pluginConfig.keyword_detector,
						pluginConfig.default_mode,
					),
				{ enabled: safeHookEnabled },
			)
		: null;

	const contextInjectorMessagesTransform = createContextInjectorMessagesTransformHook(contextCollector);

	const teamModeConfig = pluginConfig.team_mode;

	const teamModeStatusInjector = teamModeConfig?.enabled
		? safeCreateHook(
				"team-mode-status-injector",
				() => createTeamModeStatusInjector(teamModeConfig, pluginConfig.keyword_detector),
				{ enabled: safeHookEnabled },
			)
		: null;

	const teamMailboxInjector = teamModeConfig?.enabled
		? safeCreateHook("team-mailbox-injector", () => createTeamMailboxInjector(ctx, teamModeConfig), {
				enabled: safeHookEnabled,
			})
		: null;

	const toolPairValidator = isHookEnabled("tool-pair-validator")
		? safeCreateHook("tool-pair-validator", () => createToolPairValidatorHook(), { enabled: safeHookEnabled })
		: null;

	const monitorConfig = pluginConfig.monitor;
	const monitorStatusInjector =
		monitorConfig?.enabled && monitorManager && isHookEnabled("monitor-status-injector")
			? safeCreateHook(
					"monitor-status-injector",
					() => createMonitorStatusInjectorHook(monitorManager, { enabled: monitorConfig.enabled }),
					{ enabled: safeHookEnabled },
				)
			: null;

	return {
		claudeCodeHooks,
		keywordDetector,
		contextInjectorMessagesTransform,
		teamModeStatusInjector,
		teamMailboxInjector,
		toolPairValidator,
		monitorStatusInjector,
	};
}
