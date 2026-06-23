export {
	BackgroundManager,
	type OnSubagentSessionCreated,
	type OnSubagentSessionDeleted,
	type SubagentSessionCreatedEvent,
	type SubagentSessionDeletedEvent,
} from "./manager";
export * from "./types";
export type { WaitForTaskSessionIDOptions } from "./wait-for-task-session";
export { waitForTaskSessionID } from "./wait-for-task-session";
