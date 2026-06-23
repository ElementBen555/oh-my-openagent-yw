import { isAttachableSessionStatus } from "./attachable-session-status";
import { decideSpawnActions } from "./decision-engine";
import { DEFERRED_SESSION_TTL_MS } from "./deferred-sessions";
import type { SpawnContext } from "./spawn-close";
import {
	beginPendingSession,
	enqueueSpawn,
	ensureSessionReadyBeforeSpawn,
	getSessionStatusType,
	spawnInIsolatedContainer,
	spawnPendingSession,
} from "./spawn-close";
import { createTrackedSession } from "./tracked-session-state";

export function shouldSkipRespawnAfterPollingClose(ctx: SpawnContext, sessionId: string, source: string): boolean {
	if (!ctx.closedByPolling.has(sessionId)) {
		return false;
	}

	ctx.deps.log("[tmux-session-manager] skipping tmux respawn because polling already closed the session", {
		sessionId,
		source,
	});
	return true;
}

export async function tryAttachDeferredSession(ctx: SpawnContext): Promise<void> {
	const sessionId = ctx.deferredQueue[0];
	if (!sessionId) {
		ctx.stopDeferredAttachLoop();
		return;
	}

	const deferred = ctx.deferredSessions.get(sessionId);
	if (!deferred) {
		ctx.deferredQueue.shift();
		return;
	}

	if (shouldSkipRespawnAfterPollingClose(ctx, sessionId, "deferred attach")) {
		ctx.removeDeferredSession(sessionId);
		return;
	}

	if (!beginPendingSession(ctx, sessionId, { allowDeferredSession: true })) {
		return;
	}

	try {
		if (Date.now() - deferred.queuedAt.getTime() > DEFERRED_SESSION_TTL_MS) {
			ctx.deferredQueue.shift();
			ctx.deferredSessions.delete(sessionId);
			ctx.deps.log("[tmux-session-manager] deferred session expired", {
				sessionId,
				queuedAt: deferred.queuedAt.toISOString(),
				ttlMs: DEFERRED_SESSION_TTL_MS,
				queueLength: ctx.deferredQueue.length,
			});
			if (ctx.deferredQueue.length === 0) {
				ctx.stopDeferredAttachLoop();
			}
			return;
		}

		if (deferred.retryIsolatedContainer) {
			const readyForIsolatedContainer = await ensureSessionReadyBeforeSpawn(
				ctx,
				sessionId,
				"deferred.isolated-container",
			);
			if (!readyForIsolatedContainer) {
				ctx.removeDeferredSession(sessionId);
				return;
			}

			const isolatedPaneId = await spawnInIsolatedContainer(ctx, sessionId, deferred.title);
			if (isolatedPaneId) {
				ctx.sessions.set(
					sessionId,
					createTrackedSession({
						sessionId,
						paneId: isolatedPaneId,
						description: deferred.title,
					}),
				);
				ctx.removeDeferredSession(sessionId);
				ctx.pollingManager.startPolling();
				ctx.deps.log("[tmux-session-manager] deferred session attached in isolated window", {
					sessionId,
					paneId: isolatedPaneId,
				});
				return;
			}
		}

		const effectiveSourcePaneId = ctx.getEffectiveSourcePaneId();
		if (!effectiveSourcePaneId) return;

		const state = await ctx.deps.queryWindowState(effectiveSourcePaneId);
		if (!state) {
			ctx.nullStateCount += 1;
			ctx.deps.log("[tmux-session-manager] deferred attach window state is null", {
				nullStateCount: ctx.nullStateCount,
			});
			if (ctx.nullStateCount >= 3) {
				ctx.deps.log("[tmux-session-manager] stopping deferred attach loop after consecutive null states", {
					nullStateCount: ctx.nullStateCount,
				});
				ctx.stopDeferredAttachLoop();
			}
			return;
		}
		ctx.nullStateCount = 0;

		const decision = decideSpawnActions(
			state,
			sessionId,
			deferred.title,
			ctx.getCapacityConfig(),
			ctx.getSessionMappings(),
		);

		if (!decision.canSpawn || decision.actions.length === 0) {
			ctx.deps.log("[tmux-session-manager] deferred session still waiting for capacity", {
				sessionId,
				reason: decision.reason,
			});
			return;
		}

		const readyForDeferredAttach = await ensureSessionReadyBeforeSpawn(ctx, sessionId, "deferred.attach");
		if (!readyForDeferredAttach) {
			ctx.removeDeferredSession(sessionId);
			return;
		}

		const result = await ctx.deps.executeActions(decision.actions, {
			config: ctx.tmuxConfig,
			directory: ctx.projectDirectory,
			serverUrl: ctx.serverUrl,
			windowState: state,
			sourcePaneId: effectiveSourcePaneId,
		});

		if (!result.success || !result.spawnedPaneId) {
			ctx.deps.log("[tmux-session-manager] deferred session attach failed", {
				sessionId,
				results: result.results.map((r) => ({
					type: r.action.type,
					success: r.result.success,
					error: r.result.error,
				})),
			});
			return;
		}

		ctx.sessions.set(
			sessionId,
			createTrackedSession({
				sessionId,
				paneId: result.spawnedPaneId,
				description: deferred.title,
			}),
		);
		ctx.removeDeferredSession(sessionId);
		ctx.pollingManager.startPolling();
		ctx.deps.log("[tmux-session-manager] deferred session attached", {
			sessionId,
			paneId: result.spawnedPaneId,
		});
	} finally {
		ctx.pendingSessions.delete(sessionId);
	}
}

export async function retryFailedReadinessSession(ctx: SpawnContext, sessionId: string): Promise<void> {
	if (shouldSkipRespawnAfterPollingClose(ctx, sessionId, "session.idle retry")) {
		return;
	}

	const failedReadinessSession = ctx.failedReadinessCache.get(sessionId);
	if (!failedReadinessSession) {
		return;
	}

	if (!beginPendingSession(ctx, sessionId)) {
		return;
	}

	try {
		await enqueueSpawn(ctx, async () => {
			try {
				const sessionStatus = await getSessionStatusType(ctx, sessionId);
				if (!isAttachableSessionStatus(sessionStatus)) {
					ctx.deps.log("[tmux-session-manager] session.idle retry skipped because session is not attachable", {
						sessionId,
						status: sessionStatus,
					});
					return;
				}

				ctx.failedReadinessCache.clear(sessionId);
				await spawnPendingSession(ctx, {
					session: failedReadinessSession,
					stage: "session.idle.retry",
					rememberReadinessFailure: false,
				});
			} finally {
				ctx.pendingSessions.delete(sessionId);
			}
		});
	} finally {
		ctx.pendingSessions.delete(sessionId);
	}
}
