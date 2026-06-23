import { log } from "../../shared/logger";
import { spawnWithWindowsHide } from "../../shared/spawn-with-windows-hide";
import { OMO_SESSION_PREFIX } from "./constants";
import { loadInteractiveBashSessionState } from "./storage";
import type { InteractiveBashSessionState } from "./types";

export function getOrCreateState(
	sessionID: string,
	sessionStates: Map<string, InteractiveBashSessionState>,
): InteractiveBashSessionState {
	const existing = sessionStates.get(sessionID);
	if (existing) {
		return existing;
	}

	const persisted = loadInteractiveBashSessionState(sessionID);
	const state: InteractiveBashSessionState = persisted ?? {
		sessionID,
		tmuxSessions: new Set<string>(),
		updatedAt: Date.now(),
	};
	sessionStates.set(sessionID, state);
	return state;
}

export function isOmoSession(sessionName: string | null): sessionName is string {
	return sessionName !== null && sessionName.startsWith(OMO_SESSION_PREFIX);
}

export async function killAllTrackedSessions(state: InteractiveBashSessionState): Promise<void> {
	for (const sessionName of state.tmuxSessions) {
		try {
			const proc = spawnWithWindowsHide(["tmux", "kill-session", "-t", sessionName], {
				stdout: "ignore",
				stderr: "ignore",
			});
			await proc.exited;
		} catch (error) {
			log("[interactive-bash-session] failed to kill tracked tmux session", {
				error: error instanceof Error ? error.message : String(error),
				sessionName,
			});
		}
	}
}
