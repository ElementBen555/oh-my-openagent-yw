import { resolveToolCallID, type ToolCallIDCarrier } from "./resolve-tool-call-id";
import { consumeToolMetadata, type PendingToolMetadata } from "./store";

export function recoverToolMetadata(
	sessionID: string,
	source: ToolCallIDCarrier | string | undefined,
): PendingToolMetadata | undefined {
	if (typeof source === "string") {
		return consumeToolMetadata(sessionID, source);
	}

	const callID = source ? resolveToolCallID(source) : undefined;
	if (!callID) {
		return undefined;
	}

	return consumeToolMetadata(sessionID, callID);
}
