export { createGlobTools } from "./glob";
export { createGrepTools } from "./grep";
export { interactive_bash, startBackgroundCheck as startTmuxCheck } from "./interactive-bash";
export { createSessionManagerTools } from "./session-manager";
export { sessionExists } from "./session-manager/storage";
export { createSkillTool } from "./skill";
export { createSkillMcpTool } from "./skill-mcp";
export { discoverCommandsSync } from "./slashcommand";

import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin";
import type { BackgroundManager } from "../features/background-agent";
import {
	type BackgroundCancelClient,
	type BackgroundOutputManager,
	createBackgroundCancel,
	createBackgroundOutput,
} from "./background-task";

type OpencodeClient = PluginInput["client"];

export { createTeamSendMessageTool } from "../features/team-mode/tools/messaging";
export { createCallOmoAgent } from "./call-omo-agent";
export { createDelegateTask } from "./delegate-task";
export { createHashlineEditTool } from "./hashline-edit";
export { createLookAt } from "./look-at";
export { createMonitorTools } from "./monitor";
export {
	createTaskCreateTool,
	createTaskGetTool,
	createTaskList,
	createTaskUpdateTool,
} from "./task";

export function createBackgroundTools(
	manager: BackgroundManager,
	client: OpencodeClient,
): Record<string, ToolDefinition> {
	const outputManager: BackgroundOutputManager = manager;
	const cancelClient: BackgroundCancelClient = client;
	return {
		background_output: createBackgroundOutput(outputManager, client),
		background_cancel: createBackgroundCancel(manager, cancelClient),
	};
}
