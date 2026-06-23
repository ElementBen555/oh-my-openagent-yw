import type { PluginInput } from "@opencode-ai/plugin";
import type { TmuxConfig } from "../../config/schema";
import { spawnTmuxSession, spawnTmuxWindow } from "../../shared/tmux";
import { executeAction, executeActions } from "./action-executor";
import { isAttachableSessionStatus } from "./attachable-session-status";
import { decideSpawnActions, type SessionMapping } from "./decision-engine";
import type { DeferredSession, SpawnStage } from "./deferred-sessions";
import { MAX_ISOLATED_CONTAINER_NULL_STATE_COUNT } from "./deferred-sessions";
import type { FailedReadinessCache, FailedReadinessSessionSeed } from "./failed-readiness-cache";
import type { TmuxUtilDeps } from "./manager";
import { parseSessionStatusResponse } from "./session-status-parser";
import { createTrackedSession, markTrackedSessionClosePending } from "./tracked-session-state";
import type { CapacityConfig, TrackedSession, WindowState } from "./types";

type OpencodeClient = PluginInput["client"];

const MAX_CLOSE_RETRY_COUNT = 3;
const CLOSE_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

export interface SpawnContext {
	sessions: Map<string, TrackedSession>;
	pendingSessions: Set<string>;
	closedByPolling: Set<string>;
	failedReadinessCache: FailedReadinessCache;

	client: OpencodeClient;
	tmuxConfig: TmuxConfig;
	projectDirectory: string;
	serverUrl: string;
	sourcePaneId: string | undefined;

	deps: TmuxUtilDeps;

	isIsolated(): boolean;
	getEffectiveSourcePaneId(): string | undefined;
	getCapacityConfig(): CapacityConfig;
	getSessionMappings(): SessionMapping[];

	isolatedContainerPaneId: string | undefined;
	isolatedWindowPaneId: string | undefined;
	isolatedContainerNullStateCount: number;
	isolatedSessionManagerId: string;

	/** Used by tryAttachDeferredSession to track consecutive null window states */
	nullStateCount: number;

	pollingManager: { startPolling(): void; stopPolling(): void };

	enqueueDeferredSession(sessionId: string, title: string, retryIsolatedContainer?: boolean): void;
	removeDeferredSession(sessionId: string): void;
	startDeferredAttachLoop(): void;
	stopDeferredAttachLoop(): void;
	markSessionClosePending(sessionId: string): void;

	// For deferred-sessions integration
	get deferredSessions(): Map<string, DeferredSession>;
	get deferredQueue(): string[];
	set deferredQueue(value: string[]);
}

export async function enqueueSpawn(ctx: SpawnContext, run: () => Promise<void>): Promise<void> {
	// Access spawnQueue through the manager's implementation.
	// The SpawnContext doesn't expose spawnQueue directly, so we route
	// through the enclosing object reference (ctx === the manager instance).
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mgr = ctx as unknown as { spawnQueue: Promise<void> };
	mgr.spawnQueue = mgr.spawnQueue
		.catch((error) => {
			ctx.deps.log("[tmux-session-manager] recovering spawn queue after previous failure", {
				error: String(error),
			});
		})
		.then(run)
		.catch((err) => {
			ctx.deps.log("[tmux-session-manager] spawn queue task failed", {
				error: String(err),
			});
		});
	await mgr.spawnQueue;
}

export function getEventSessionId(event: { type: string; properties?: Record<string, unknown> }): string | undefined {
	const sessionId = event.properties?.sessionID;
	return typeof sessionId === "string" ? sessionId : undefined;
}

export function beginPendingSession(
	ctx: SpawnContext,
	sessionId: string,
	options?: { allowDeferredSession?: boolean },
): boolean {
	if (
		ctx.sessions.has(sessionId) ||
		ctx.pendingSessions.has(sessionId) ||
		(!options?.allowDeferredSession && ctx.deferredSessions.has(sessionId))
	) {
		ctx.deps.log("[tmux-session-manager] session already tracked or pending", { sessionId });
		return false;
	}

	ctx.pendingSessions.add(sessionId);
	return true;
}

export async function ensureSessionReadyBeforeSpawn(
	ctx: SpawnContext,
	sessionId: string,
	stage: SpawnStage,
): Promise<boolean> {
	try {
		const ready = await ctx.deps.waitForSessionReady({
			client: ctx.client,
			sessionId,
		});

		if (ready) {
			return true;
		}

		const readinessError = new Error("Session readiness timed out");
		ctx.deps.log("[tmux-session-manager] session readiness failed before spawn", {
			sessionId,
			stage,
			error: String(readinessError),
		});
		return false;
	} catch (error) {
		ctx.deps.log("[tmux-session-manager] session readiness failed before spawn", {
			sessionId,
			stage,
			error: String(error),
		});
		return false;
	}
}

export async function getSessionStatusType(ctx: SpawnContext, sessionId: string): Promise<string | undefined> {
	try {
		const statusResult = await ctx.client.session.status({ path: undefined });
		const allStatuses = parseSessionStatusResponse(statusResult);
		return allStatuses[sessionId]?.type;
	} catch (error) {
		ctx.deps.log("[tmux-session-manager] failed to read session status before spawn", {
			sessionId,
			error: String(error),
		});
		return undefined;
	}
}

export async function spawnInIsolatedContainer(
	ctx: SpawnContext,
	sessionId: string,
	title: string,
): Promise<string | null> {
	if (!ctx.isIsolated()) return null;
	if (ctx.isolatedWindowPaneId) {
		const state = await ctx.deps.queryWindowState(ctx.isolatedWindowPaneId).catch((error) => {
			ctx.deps.log("[tmux-session-manager] failed to query isolated window state", {
				paneId: ctx.isolatedWindowPaneId,
				error: String(error),
			});
			return null;
		});
		if (state) {
			ctx.isolatedContainerNullStateCount = 0;
			return null;
		}
		ctx.isolatedContainerNullStateCount += 1;
		ctx.deps.log("[tmux-session-manager] isolated container state query returned null", {
			paneId: ctx.isolatedWindowPaneId,
			nullStateCount: ctx.isolatedContainerNullStateCount,
			maxNullStateCount: MAX_ISOLATED_CONTAINER_NULL_STATE_COUNT,
		});
		if (ctx.isolatedContainerNullStateCount < MAX_ISOLATED_CONTAINER_NULL_STATE_COUNT) {
			return null;
		}
		ctx.isolatedContainerPaneId = undefined;
		ctx.isolatedWindowPaneId = undefined;
		ctx.isolatedContainerNullStateCount = 0;
	}

	const isolation = ctx.tmuxConfig.isolation;
	ctx.deps.log("[tmux-session-manager] creating isolated tmux container", { isolation, sessionId, title });

	const result =
		isolation === "session"
			? await spawnTmuxSession(
					sessionId,
					title,
					ctx.tmuxConfig,
					ctx.serverUrl,
					ctx.projectDirectory,
					ctx.sourcePaneId,
					undefined,
					ctx.isolatedSessionManagerId,
				)
			: await spawnTmuxWindow(sessionId, title, ctx.tmuxConfig, ctx.serverUrl, ctx.projectDirectory);

	if (result.success && result.paneId) {
		ctx.isolatedContainerPaneId = result.paneId;
		ctx.isolatedWindowPaneId = result.paneId;
		ctx.isolatedContainerNullStateCount = 0;
		ctx.deps.log("[tmux-session-manager] isolated container created", {
			isolation,
			paneId: result.paneId,
		});
		return result.paneId;
	}
	ctx.deps.log("[tmux-session-manager] failed to create isolated container", { isolation, sessionId });
	return null;
}

export async function spawnPendingSession(
	ctx: SpawnContext,
	args: {
		session: FailedReadinessSessionSeed;
		stage: SpawnStage;
		rememberReadinessFailure: boolean;
	},
): Promise<void> {
	const { session, stage, rememberReadinessFailure } = args;
	const { sessionId, title } = session;

	const readyForSpawn = await ensureSessionReadyBeforeSpawn(ctx, sessionId, stage);
	if (!readyForSpawn) {
		if (rememberReadinessFailure) {
			ctx.failedReadinessCache.remember(session);
		}
		return;
	}

	const sessionStatus = await getSessionStatusType(ctx, sessionId);
	if (!isAttachableSessionStatus(sessionStatus)) {
		ctx.deps.log("[tmux-session-manager] session not attachable for pane spawn", {
			sessionId,
			stage,
			status: sessionStatus,
		});
		if (rememberReadinessFailure) {
			ctx.failedReadinessCache.remember(session);
		}
		return;
	}

	ctx.failedReadinessCache.clear(sessionId);

	const isolatedPaneId = await spawnInIsolatedContainer(ctx, sessionId, title);
	if (isolatedPaneId) {
		ctx.sessions.set(sessionId, createTrackedSession({ sessionId, paneId: isolatedPaneId, description: title }));
		ctx.pollingManager.startPolling();
		ctx.deps.log("[tmux-session-manager] first subagent spawned in isolated window", {
			sessionId,
			paneId: isolatedPaneId,
		});
		return;
	}

	if (ctx.isIsolated() && !ctx.isolatedWindowPaneId) {
		ctx.deps.log("[tmux-session-manager] isolated container failed, deferring session for retry", { sessionId });
		ctx.enqueueDeferredSession(sessionId, title, true);
		return;
	}
	const sourcePaneId = ctx.getEffectiveSourcePaneId();
	if (!sourcePaneId) {
		ctx.deps.log("[tmux-session-manager] no effective source pane id");
		return;
	}

	const state = await ctx.deps.queryWindowState(sourcePaneId);
	if (!state) {
		ctx.deps.log("[tmux-session-manager] failed to query window state, deferring session");
		ctx.enqueueDeferredSession(sessionId, title);
		return;
	}

	ctx.deps.log("[tmux-session-manager] window state queried", {
		windowWidth: state.windowWidth,
		mainPane: state.mainPane?.paneId,
		agentPaneCount: state.agentPanes.length,
		agentPanes: state.agentPanes.map((pane) => pane.paneId),
	});

	const decision = decideSpawnActions(state, sessionId, title, ctx.getCapacityConfig(), ctx.getSessionMappings());

	ctx.deps.log("[tmux-session-manager] spawn decision", {
		canSpawn: decision.canSpawn,
		reason: decision.reason,
		actionCount: decision.actions.length,
		actions: decision.actions.map((action) => {
			if (action.type === "close") return { type: "close", paneId: action.paneId };
			if (action.type === "replace") {
				return {
					type: "replace",
					paneId: action.paneId,
					newSessionId: action.newSessionId,
				};
			}
			return { type: "spawn", sessionId: action.sessionId };
		}),
	});

	if (!decision.canSpawn) {
		ctx.deps.log("[tmux-session-manager] cannot spawn", { reason: decision.reason });
		ctx.enqueueDeferredSession(sessionId, title);
		return;
	}

	const result = await ctx.deps.executeActions(decision.actions, {
		config: ctx.tmuxConfig,
		directory: ctx.projectDirectory,
		serverUrl: ctx.serverUrl,
		windowState: state,
		sourcePaneId,
	});

	for (const { action, result: actionResult } of result.results) {
		if (action.type === "close" && actionResult.success) {
			ctx.sessions.delete(action.sessionId);
			ctx.deps.log("[tmux-session-manager] removed closed session from cache", {
				sessionId: action.sessionId,
			});
		}
		if (action.type === "replace" && actionResult.success) {
			ctx.sessions.delete(action.oldSessionId);
			ctx.deps.log("[tmux-session-manager] removed replaced session from cache", {
				oldSessionId: action.oldSessionId,
				newSessionId: action.newSessionId,
			});
		}
	}

	if (result.success && result.spawnedPaneId) {
		ctx.sessions.set(
			sessionId,
			createTrackedSession({
				sessionId,
				paneId: result.spawnedPaneId,
				description: title,
			}),
		);
		ctx.failedReadinessCache.clear(sessionId);
		ctx.deps.log("[tmux-session-manager] pane spawned and tracked", {
			sessionId,
			paneId: result.spawnedPaneId,
		});
		ctx.pollingManager.startPolling();
		return;
	}

	ctx.deps.log("[tmux-session-manager] spawn failed", {
		success: result.success,
		results: result.results.map((resultEntry) => ({
			type: resultEntry.action.type,
			success: resultEntry.result.success,
			error: resultEntry.result.error,
		})),
	});

	ctx.deps.log("[tmux-session-manager] re-queueing deferred session after spawn failure", {
		sessionId,
	});
	ctx.enqueueDeferredSession(sessionId, title);

	if (result.spawnedPaneId) {
		await ctx.deps.executeAction(
			{ type: "close", paneId: result.spawnedPaneId, sessionId },
			{
				config: ctx.tmuxConfig,
				directory: ctx.projectDirectory,
				serverUrl: ctx.serverUrl,
				windowState: state,
			},
		);
	}
}

// ──── Close / Cleanup Functions ────

export async function queryWindowStateSafely(ctx: SpawnContext): Promise<WindowState | null> {
	const paneId = ctx.getEffectiveSourcePaneId();
	if (!paneId) return null;

	try {
		return await ctx.deps.queryWindowState(paneId);
	} catch (error) {
		ctx.deps.log("[tmux-session-manager] failed to query window state for close", {
			error: String(error),
		});
		return null;
	}
}

export function canAutoActivatePane(ctx: SpawnContext, state: WindowState): boolean {
	if (!ctx.isIsolated()) return true;
	return state.windowActive === true && state.sessionAttached === true;
}

export function windowStateContainsPane(state: WindowState, paneId: string): boolean {
	return state.mainPane?.paneId === paneId || state.agentPanes.some((pane) => pane.paneId === paneId);
}

export function markSessionClosePending(ctx: SpawnContext, sessionId: string): void {
	const tracked = ctx.sessions.get(sessionId);
	if (!tracked) return;

	ctx.sessions.set(sessionId, markTrackedSessionClosePending(tracked));
	ctx.deps.log("[tmux-session-manager] marked session close pending", {
		sessionId,
		paneId: tracked.paneId,
		closeRetryCount: tracked.closeRetryCount,
	});
}

export function removeTrackedSession(ctx: SpawnContext, sessionId: string): void {
	ctx.sessions.delete(sessionId);

	if (ctx.sessions.size === 0) {
		ctx.pollingManager.stopPolling();
	}
}

export function reassignIsolatedContainerAnchor(ctx: SpawnContext): void {
	const nextAnchor = ctx.sessions.values().next().value as TrackedSession | undefined;
	if (!nextAnchor) {
		return;
	}

	ctx.isolatedContainerNullStateCount = 0;
	ctx.isolatedWindowPaneId = nextAnchor.paneId;
	ctx.deps.log("[tmux-session-manager] reassigned isolated container anchor pane", {
		sessionId: nextAnchor.sessionId,
		paneId: nextAnchor.paneId,
	});
}

export async function cleanupIsolatedContainerAfterSessionDeletion(
	ctx: SpawnContext,
	tracked: TrackedSession,
	isolatedPaneAlreadyClosed: boolean,
	state: WindowState,
): Promise<void> {
	if (tracked.paneId !== ctx.isolatedWindowPaneId) {
		return;
	}

	if (ctx.sessions.size > 0) {
		reassignIsolatedContainerAnchor(ctx);
		return;
	}

	const isolatedContainerPaneId = ctx.isolatedContainerPaneId;
	ctx.isolatedContainerNullStateCount = 0;
	ctx.isolatedContainerPaneId = undefined;
	ctx.isolatedWindowPaneId = undefined;

	if (!isolatedContainerPaneId) {
		return;
	}

	if (isolatedPaneAlreadyClosed && tracked.paneId === isolatedContainerPaneId) {
		return;
	}

	try {
		const result = await ctx.deps.executeAction(
			{ type: "close", paneId: isolatedContainerPaneId, sessionId: tracked.sessionId },
			{
				config: ctx.tmuxConfig,
				directory: ctx.projectDirectory,
				serverUrl: ctx.serverUrl,
				windowState: state,
				sourcePaneId: ctx.sourcePaneId ?? tracked.paneId,
			},
		);

		if (!result.success) {
			ctx.deps.log("[tmux-session-manager] failed to close isolated container pane after anchor session deletion", {
				sessionId: tracked.sessionId,
				paneId: isolatedContainerPaneId,
			});
		}
	} catch (error) {
		ctx.deps.log("[tmux-session-manager] failed to cleanup isolated container pane after anchor session deletion", {
			sessionId: tracked.sessionId,
			paneId: isolatedContainerPaneId,
			error: String(error),
		});
	}
}

export async function closeTrackedSessionPane(
	ctx: SpawnContext,
	args: {
		tracked: TrackedSession;
		state: WindowState;
	},
): Promise<boolean> {
	const { tracked, state } = args;

	try {
		const result = await ctx.deps.executeAction(
			{ type: "close", paneId: tracked.paneId, sessionId: tracked.sessionId },
			{
				config: ctx.tmuxConfig,
				directory: ctx.projectDirectory,
				serverUrl: ctx.serverUrl,
				windowState: state,
				sourcePaneId: ctx.getEffectiveSourcePaneId(),
			},
		);

		return result.success;
	} catch (error) {
		ctx.deps.log("[tmux-session-manager] close session pane failed", {
			sessionId: tracked.sessionId,
			paneId: tracked.paneId,
			error: String(error),
		});
		return false;
	}
}

export async function finalizeTrackedSessionClose(
	ctx: SpawnContext,
	args: {
		tracked: TrackedSession;
		state: WindowState;
		isolatedPaneAlreadyClosed: boolean;
	},
): Promise<void> {
	const { tracked, state, isolatedPaneAlreadyClosed } = args;
	removeTrackedSession(ctx, tracked.sessionId);
	await cleanupIsolatedContainerAfterSessionDeletion(ctx, tracked, isolatedPaneAlreadyClosed, state);
}

export async function closeTrackedSession(ctx: SpawnContext, tracked: TrackedSession): Promise<boolean> {
	const state = await queryWindowStateSafely(ctx);
	if (!state) return false;

	const closed = await closeTrackedSessionPane(ctx, { tracked, state });
	if (!closed) {
		return false;
	}

	await finalizeTrackedSessionClose(ctx, {
		tracked,
		state,
		isolatedPaneAlreadyClosed: true,
	});
	return true;
}

export async function finalizeForceRemoveCandidate(
	ctx: SpawnContext,
	tracked: TrackedSession,
	source: string,
): Promise<boolean> {
	const state = await queryWindowStateSafely(ctx);
	if (!state) {
		ctx.deps.log("[tmux-session-manager] unable to verify pane after max close retries; keeping session tracked", {
			sessionId: tracked.sessionId,
			paneId: tracked.paneId,
			source,
		});
		return false;
	}

	if (windowStateContainsPane(state, tracked.paneId)) {
		ctx.deps.log(
			"[tmux-session-manager] pane still exists after max close retries; arming retry cooldown for next attempt",
			{
				sessionId: tracked.sessionId,
				paneId: tracked.paneId,
				closeRetryCount: tracked.closeRetryCount,
				cooldownMs: CLOSE_RETRY_COOLDOWN_MS,
				source,
			},
		);
		const currentTracked = ctx.sessions.get(tracked.sessionId);
		if (currentTracked) {
			currentTracked.closeRetryCooldownUntil = new Date(Date.now() + CLOSE_RETRY_COOLDOWN_MS);
		}
		return false;
	}

	ctx.deps.log("[tmux-session-manager] pane already gone after max close retries; finalizing tracked close", {
		sessionId: tracked.sessionId,
		paneId: tracked.paneId,
		source,
	});
	await finalizeTrackedSessionClose(ctx, {
		tracked,
		state,
		isolatedPaneAlreadyClosed: true,
	});
	return true;
}

export function closeSessionFromPolling(
	ctx: SpawnContext,
	sessionId: string,
	closeSessionById: (id: string) => Promise<void>,
): Promise<void> {
	ctx.closedByPolling.add(sessionId);
	return closeSessionById(sessionId);
}

export async function closeSessionById(ctx: SpawnContext, sessionId: string): Promise<void> {
	const tracked = ctx.sessions.get(sessionId);
	if (!tracked) return;

	if (tracked.closePending && tracked.closeRetryCount >= MAX_CLOSE_RETRY_COUNT) {
		await finalizeForceRemoveCandidate(ctx, tracked, "closeSessionById.max-retries");
		return;
	}

	ctx.deps.log("[tmux-session-manager] closing session pane", {
		sessionId,
		paneId: tracked.paneId,
	});

	const closed = await closeTrackedSession(ctx, tracked);
	if (!closed) {
		markSessionClosePending(ctx, sessionId);
		return;
	}
}

export async function retryPendingCloses(ctx: SpawnContext): Promise<void> {
	const pendingSessions = Array.from(ctx.sessions.values()).filter((tracked) => tracked.closePending);

	for (const tracked of pendingSessions) {
		if (!ctx.sessions.has(tracked.sessionId)) continue;

		if (tracked.closeRetryCount >= MAX_CLOSE_RETRY_COUNT) {
			if (tracked.closeRetryCooldownUntil) {
				if (Date.now() >= tracked.closeRetryCooldownUntil.getTime()) {
					ctx.deps.log(
						"[tmux-session-manager] close-retry cooldown elapsed; resetting retry state so polling can re-attempt",
						{
							sessionId: tracked.sessionId,
							paneId: tracked.paneId,
						},
					);
					const fresh = ctx.sessions.get(tracked.sessionId);
					if (fresh) {
						fresh.closeRetryCount = 0;
						fresh.closePending = false;
						fresh.closeRetryCooldownUntil = undefined;
					}
					continue;
				}
				// Cooldown still active — skip and let next pass check again.
				continue;
			}
			await finalizeForceRemoveCandidate(ctx, tracked, "retryPendingCloses.max-retries");
			continue;
		}

		const closed = await closeTrackedSession(ctx, tracked);
		if (closed) {
			ctx.deps.log("[tmux-session-manager] retried close succeeded", {
				sessionId: tracked.sessionId,
				paneId: tracked.paneId,
				closeRetryCount: tracked.closeRetryCount,
			});
			continue;
		}

		const currentTracked = ctx.sessions.get(tracked.sessionId);
		if (!currentTracked || !currentTracked.closePending) {
			continue;
		}

		const nextRetryCount = currentTracked.closeRetryCount + 1;
		if (nextRetryCount >= MAX_CLOSE_RETRY_COUNT) {
			ctx.sessions.set(currentTracked.sessionId, {
				...currentTracked,
				closeRetryCount: nextRetryCount,
			});
			const refreshed = ctx.sessions.get(currentTracked.sessionId);
			await finalizeForceRemoveCandidate(ctx, refreshed ?? currentTracked, "retryPendingCloses.failed-retry");
			continue;
		}

		ctx.sessions.set(currentTracked.sessionId, {
			...currentTracked,
			closePending: true,
			closeRetryCount: nextRetryCount,
		});
		ctx.deps.log("[tmux-session-manager] retried close failed", {
			sessionId: currentTracked.sessionId,
			paneId: currentTracked.paneId,
			closeRetryCount: nextRetryCount,
		});
	}
}
