/**
 * Ultrawork message module - routes to appropriate message based on agent/model.
 *
 * Routing:
 * 1. Planner agents (prometheus, plan) → planner.ts
 * 2. GPT models → gpt.ts
 * 3. Gemini models → gemini.ts
 * 4. GLM models → glm.ts
 * 5. Default (Claude, etc.) → default.ts (optimized for Claude series)
 */

export {
	getDefaultUltraworkMessage,
	ULTRAWORK_DEFAULT_MESSAGE,
} from "./default";
export { getGeminiUltraworkMessage, ULTRAWORK_GEMINI_MESSAGE } from "./gemini";
export { getGlmUltraworkMessage, ULTRAWORK_GLM_MESSAGE } from "./glm";
export { getGptUltraworkMessage, ULTRAWORK_GPT_MESSAGE } from "./gpt";
export {
	getPlannerUltraworkMessage,
	ULTRAWORK_PLANNER_SECTION,
} from "./planner";
export type { UltraworkSource } from "./source-detector";
export {
	getUltraworkSource,
	isGeminiModel,
	isGlmModel,
	isGptModel,
	isNonOmoAgent,
	isPlannerAgent,
} from "./source-detector";

import { getDefaultUltraworkMessage } from "./default";
import { getGeminiUltraworkMessage } from "./gemini";
import { getGlmUltraworkMessage } from "./glm";
import { getGptUltraworkMessage } from "./gpt";
import { getPlannerUltraworkMessage } from "./planner";
import { getUltraworkSource } from "./source-detector";

/**
 * Gets the appropriate ultrawork message based on agent and model context.
 */
export function getUltraworkMessage(agentName?: string, modelID?: string): string {
	const source = getUltraworkSource(agentName, modelID);

	switch (source) {
		case "planner":
			return getPlannerUltraworkMessage();
		case "gpt":
			return getGptUltraworkMessage();
		case "gemini":
			return getGeminiUltraworkMessage();
		case "glm":
			return getGlmUltraworkMessage();
		case "default":
		default:
			return getDefaultUltraworkMessage();
	}
}
