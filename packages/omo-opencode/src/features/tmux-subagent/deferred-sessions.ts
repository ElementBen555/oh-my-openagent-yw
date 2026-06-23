import { POLL_INTERVAL_BACKGROUND_MS } from "../../shared/tmux";
import type { FailedReadinessCache, FailedReadinessSessionSeed } from "./failed-readiness-cache";

export interface DeferredSession {
	sessionId: string;
	title: string;
	queuedAt: Date;
	retryIsolatedContainer: boolean;
}

export type SpawnStage = "deferred.attach" | "deferred.isolated-container" | "session.created" | "session.idle.retry";

export const DEFERRED_SESSION_TTL_MS = 5 * 60 * 1000;
export const MAX_DEFERRED_QUEUE_SIZE = 20;
export const MAX_ISOLATED_CONTAINER_NULL_STATE_COUNT = 2;

export interface DeferredSessionState {
	deferredSessions: Map<string, DeferredSession>;
	deferredQueue: string[];
	deferredAttachInterval: ReturnType<typeof setInterval> | undefined;
	deferredAttachTickScheduled: boolean;
	nullStateCount: number;
}

export interface DeferredSessionEnv {
	log: (message: string, data?: unknown) => void;
	failedReadinessCache: FailedReadinessCache;
	shouldSkipRespawn: (sessionId: string, source: string) => boolean;
	enqueueSpawn: (run: () => Promise<void>) => Promise<void>;
	tryAttachDeferredSession: () => Promise<void>;
}

export function enqueueDeferredSession(
	state: DeferredSessionState,
	env: DeferredSessionEnv,
	sessionId: string,
	title: string,
	retryIsolatedContainer = false,
): void {
	if (env.shouldSkipRespawn(sessionId, "deferred enqueue")) {
		env.failedReadinessCache.clear(sessionId);
		return;
	}

	const existingDeferredSession = state.deferredSessions.get(sessionId);
	if (existingDeferredSession) {
		if (retryIsolatedContainer && !existingDeferredSession.retryIsolatedContainer) {
			state.deferredSessions.set(sessionId, {
				...existingDeferredSession,
				retryIsolatedContainer: true,
			});
		}
		return;
	}
	if (state.deferredQueue.length >= MAX_DEFERRED_QUEUE_SIZE) {
		env.log("[tmux-session-manager] deferred queue full, dropping session", {
			sessionId,
			queueLength: state.deferredQueue.length,
			maxQueueSize: MAX_DEFERRED_QUEUE_SIZE,
		});
		return;
	}
	state.deferredSessions.set(sessionId, {
		sessionId,
		title,
		queuedAt: new Date(),
		retryIsolatedContainer,
	});
	state.deferredQueue.push(sessionId);
	env.log("[tmux-session-manager] deferred session queued", {
		sessionId,
		queueLength: state.deferredQueue.length,
	});
	startDeferredAttachLoop(state, env);
}

export function removeDeferredSession(state: DeferredSessionState, env: DeferredSessionEnv, sessionId: string): void {
	if (!state.deferredSessions.delete(sessionId)) return;
	state.deferredQueue = state.deferredQueue.filter((id) => id !== sessionId);
	env.log("[tmux-session-manager] deferred session removed", {
		sessionId,
		queueLength: state.deferredQueue.length,
	});
	if (state.deferredQueue.length === 0) {
		stopDeferredAttachLoop(state, env);
	}
}

export function startDeferredAttachLoop(state: DeferredSessionState, env: DeferredSessionEnv): void {
	if (state.deferredAttachInterval) return;
	state.nullStateCount = 0;
	state.deferredAttachInterval = setInterval(() => {
		if (state.deferredAttachTickScheduled) return;
		state.deferredAttachTickScheduled = true;
		void env.enqueueSpawn(async () => {
			try {
				await env.tryAttachDeferredSession();
			} finally {
				state.deferredAttachTickScheduled = false;
			}
		});
	}, POLL_INTERVAL_BACKGROUND_MS);
	env.log("[tmux-session-manager] deferred attach polling started", {
		intervalMs: POLL_INTERVAL_BACKGROUND_MS,
	});
}

export function stopDeferredAttachLoop(state: DeferredSessionState, env: DeferredSessionEnv): void {
	if (!state.deferredAttachInterval) return;
	clearInterval(state.deferredAttachInterval);
	state.deferredAttachInterval = undefined;
	state.deferredAttachTickScheduled = false;
	state.nullStateCount = 0;
	env.log("[tmux-session-manager] deferred attach polling stopped");
}

/**
 * Create a DeferredSessionState proxy that mirrors private fields
 * on the TmuxSessionManager instance via getters/setters.
 */
export function createDeferredSessionState(manager: {
	deferredSessions: Map<string, DeferredSession>;
	deferredQueue: string[];
	deferredAttachInterval?: ReturnType<typeof setInterval>;
	deferredAttachTickScheduled: boolean;
	nullStateCount: number;
}): DeferredSessionState {
	return {
		get deferredSessions() {
			return manager.deferredSessions;
		},
		get deferredQueue() {
			return manager.deferredQueue;
		},
		set deferredQueue(v: string[]) {
			manager.deferredQueue = v;
		},
		get deferredAttachInterval() {
			return manager.deferredAttachInterval;
		},
		set deferredAttachInterval(v: ReturnType<typeof setInterval> | undefined) {
			manager.deferredAttachInterval = v;
		},
		get deferredAttachTickScheduled() {
			return manager.deferredAttachTickScheduled;
		},
		set deferredAttachTickScheduled(v: boolean) {
			manager.deferredAttachTickScheduled = v;
		},
		get nullStateCount() {
			return manager.nullStateCount;
		},
		set nullStateCount(v: number) {
			manager.nullStateCount = v;
		},
	};
}

/**
 * Build a DeferredSessionEnv from individual callbacks (avoiding closure
 * boilerplate in the manager constructor).
 */
export function buildDeferredSessionEnv(
	log: (message: string, data?: unknown) => void,
	failedReadinessCache: import("./failed-readiness-cache").FailedReadinessCache,
	shouldSkipRespawn: (sessionId: string, source: string) => boolean,
	enqueueSpawn: (run: () => Promise<void>) => Promise<void>,
	tryAttachDeferredSession: () => Promise<void>,
): DeferredSessionEnv {
	return { log, failedReadinessCache, shouldSkipRespawn, enqueueSpawn, tryAttachDeferredSession };
}
