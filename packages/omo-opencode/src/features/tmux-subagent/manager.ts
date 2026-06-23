import type { PluginInput } from "@opencode-ai/plugin";
import type { TmuxConfig } from "../../config/schema";
import * as sharedModule from "../../shared";
import { resolveSessionEventID } from "../../shared/event-session-id";
import {
	activateTmuxPane,
	getCurrentPaneId as defaultGetCurrentPaneId,
	isInsideTmux as defaultIsInsideTmux,
	getIsolatedSessionName,
	killTmuxSessionIfExists,
	sweepStaleOmoAgentSessions,
	sweepStaleOmoAttachPanes,
} from "../../shared/tmux";
import { executeAction, executeActions } from "./action-executor";
import { decideCloseAction, type SessionMapping } from "./decision-engine";
import type { DeferredSession, DeferredSessionState } from "./deferred-sessions";
import * as deferredMod from "./deferred-sessions";
import { FailedReadinessCache } from "./failed-readiness-cache";
import { queryWindowState as defaultQueryWindowState } from "./pane-state-querier";
import { TmuxPollingManager } from "./polling-manager";
import { resolveServerUrl } from "./resolve-server-url";
import { waitForSessionReady } from "./session-ready-waiter";
import * as spawnOrch from "./spawn-orchestrator";
import { sweepStaleTmuxResources } from "./stale-tmux-resource-sweeper";
import type { CapacityConfig, TrackedSession, WindowState } from "./types";

type OpencodeClient = PluginInput["client"];

interface SessionCreatedEvent {
	type: string;
	properties?: { info?: { id?: string; parentID?: string; title?: string } };
}

export interface TmuxUtilDeps {
	isInsideTmux: () => boolean;
	getCurrentPaneId: () => string | undefined;
	queryWindowState: (paneId: string) => Promise<WindowState | null>;
	waitForSessionReady: (params: { client: OpencodeClient; sessionId: string }) => Promise<boolean>;
	executeActions: typeof executeActions;
	executeAction: typeof executeAction;
	log: typeof sharedModule.log;
}

export interface TmuxSessionManagerOptions {
	shouldSkipSession?: (sessionId: string) => boolean;
}

const defaultTmuxDeps: TmuxUtilDeps = {
	isInsideTmux: defaultIsInsideTmux,
	getCurrentPaneId: defaultGetCurrentPaneId,
	queryWindowState: defaultQueryWindowState,
	waitForSessionReady,
	executeActions,
	executeAction,
	log: sharedModule.log,
};

const FAILED_READINESS_SESSION_TTL_MS = 5 * 60 * 1000;
const FAILED_READINESS_SWEEP_INTERVAL_MS = 60 * 1000;

let nextIsolatedSessionManagerId = 1;
function createIsolatedSessionManagerId(): string {
	const managerId = String(nextIsolatedSessionManagerId);
	nextIsolatedSessionManagerId += 1;
	return managerId;
}

export class TmuxSessionManager {
	private client: OpencodeClient;
	private tmuxConfig: TmuxConfig;
	private projectDirectory: string;
	private serverUrl: string;
	private ctxServerUrl: string | undefined;
	private sourcePaneId: string | undefined;
	private sessions = new Map<string, TrackedSession>();
	private pendingSessions = new Set<string>();
	private closedByPolling = new Set<string>();
	private readonly failedReadinessCache: FailedReadinessCache;
	private spawnQueue: Promise<void> = Promise.resolve();
	// Fields shared with deferred-sessions must be structurally public
	deferredSessions = new Map<string, DeferredSession>();
	deferredQueue: string[] = [];
	deferredAttachInterval?: ReturnType<typeof setInterval>;
	deferredAttachTickScheduled = false;
	nullStateCount = 0;
	private deps: TmuxUtilDeps;
	private shouldSkipSession: (sessionId: string) => boolean;
	private pollingManager: TmuxPollingManager;
	private isolatedContainerPaneId: string | undefined;
	private isolatedWindowPaneId: string | undefined;
	private isolatedContainerNullStateCount = 0;
	private staleSweepCompleted = false;
	private staleSweepInProgress = false;
	private isolatedSessionManagerId = createIsolatedSessionManagerId();
	private readonly deferredState: DeferredSessionState;

	constructor(
		ctx: PluginInput,
		tmuxConfig: TmuxConfig,
		deps: Partial<TmuxUtilDeps> = {},
		options: TmuxSessionManagerOptions = {},
	) {
		this.client = ctx.client;
		this.tmuxConfig = tmuxConfig;
		this.projectDirectory = ctx.directory || process.cwd();
		this.deps = { ...defaultTmuxDeps, ...deps };
		this.shouldSkipSession = options.shouldSkipSession ?? (() => false);
		this.failedReadinessCache = new FailedReadinessCache({
			ttlMs: FAILED_READINESS_SESSION_TTL_MS,
			sweepIntervalMs: FAILED_READINESS_SWEEP_INTERVAL_MS,
			log: this.deps.log,
		});
		const rawServerUrl = ctx.serverUrl?.toString();
		this.ctxServerUrl = rawServerUrl;
		this.serverUrl = resolveServerUrl(rawServerUrl, process.env, this.deps.log);
		this.sourcePaneId = this.deps.getCurrentPaneId();

		this.deferredState = deferredMod.createDeferredSessionState(this);

		this.pollingManager = new TmuxPollingManager(
			this.client,
			this.sessions,
			(sid) => this.closeSessionFromPolling(sid),
			() => spawnOrch.retryPendingCloses(this.ctx()),
			() => spawnOrch.queryWindowStateSafely(this.ctx()),
			(tracked) => this.activateTrackedSessionPane(tracked),
			(state) => spawnOrch.canAutoActivatePane(this.ctx(), state),
		);
		this.deps.log("[tmux-session-manager] initialized", {
			configEnabled: this.tmuxConfig.enabled,
			tmuxConfig: this.tmuxConfig,
			projectDirectory: this.projectDirectory,
			serverUrl: this.serverUrl,
			sourcePaneId: this.sourcePaneId,
		});
	}

	private ctx() {
		return this as unknown as import("./spawn-orchestrator").SpawnContext;
	}

	private isEnabled(): boolean {
		return this.tmuxConfig.enabled && this.deps.isInsideTmux();
	}

	private isIsolated(): boolean {
		return this.tmuxConfig.isolation === "window" || this.tmuxConfig.isolation === "session";
	}

	private getEffectiveSourcePaneId(): string | undefined {
		if (this.isIsolated() && this.isolatedWindowPaneId) return this.isolatedWindowPaneId;
		return this.sourcePaneId;
	}

	private getCapacityConfig(): CapacityConfig {
		return {
			layout: this.tmuxConfig.layout,
			mainPaneSize: this.tmuxConfig.main_pane_size,
			mainPaneMinWidth: this.tmuxConfig.main_pane_min_width,
			agentPaneWidth: this.tmuxConfig.agent_pane_min_width,
		};
	}

	private getSessionMappings(): SessionMapping[] {
		return Array.from(this.sessions.values()).map((s) => ({
			sessionId: s.sessionId,
			paneId: s.paneId,
			createdAt: s.createdAt,
		}));
	}

	getTrackedPaneId(sessionId: string): string | undefined {
		return this.sessions.get(sessionId)?.paneId;
	}

	getServerUrl(): string {
		return this.serverUrl;
	}
	getCtxServerUrl(): string | undefined {
		return this.ctxServerUrl;
	}

	private async activateTrackedSessionPane(tracked: TrackedSession): Promise<boolean> {
		return activateTmuxPane(tracked.paneId, tracked.sessionId, this.serverUrl, this.projectDirectory);
	}

	private closeSessionFromPolling(sessionId: string): Promise<void> {
		this.closedByPolling.add(sessionId);
		return spawnOrch.closeSessionById(this.ctx(), sessionId);
	}

	private async closeSessionById(sessionId: string): Promise<void> {
		return spawnOrch.closeSessionById(this.ctx(), sessionId);
	}

	private async retryPendingCloses(): Promise<void> {
		return spawnOrch.retryPendingCloses(this.ctx());
	}

	// ──── Delegated to deferred-sessions ────

	private enqueueDeferredSession(sessionId: string, title: string, retryIsolatedContainer = false): void {
		const env = deferredMod.buildDeferredSessionEnv(
			this.deps.log,
			this.failedReadinessCache,
			(sid, src) => spawnOrch.shouldSkipRespawnAfterPollingClose(this.ctx(), sid, src),
			(run) => this.enqueueSpawn(run),
			() => spawnOrch.tryAttachDeferredSession(this.ctx()),
		);
		deferredMod.enqueueDeferredSession(this.deferredState, env, sessionId, title, retryIsolatedContainer);
	}

	private removeDeferredSession(sessionId: string): void {
		const env = deferredMod.buildDeferredSessionEnv(
			this.deps.log,
			this.failedReadinessCache,
			() => false,
			() => Promise.resolve(),
			() => Promise.resolve(),
		);
		deferredMod.removeDeferredSession(this.deferredState, env, sessionId);
	}

	private startDeferredAttachLoop(): void {
		const env = deferredMod.buildDeferredSessionEnv(
			this.deps.log,
			this.failedReadinessCache,
			(sid, src) => spawnOrch.shouldSkipRespawnAfterPollingClose(this.ctx(), sid, src),
			(run) => this.enqueueSpawn(run),
			() => spawnOrch.tryAttachDeferredSession(this.ctx()),
		);
		deferredMod.startDeferredAttachLoop(this.deferredState, env);
	}

	private stopDeferredAttachLoop(): void {
		const env = deferredMod.buildDeferredSessionEnv(
			this.deps.log,
			this.failedReadinessCache,
			() => false,
			() => Promise.resolve(),
			() => Promise.resolve(),
		);
		deferredMod.stopDeferredAttachLoop(this.deferredState, env);
	}

	private async enqueueSpawn(run: () => Promise<void>): Promise<void> {
		this.spawnQueue = this.spawnQueue
			.catch((error) => {
				this.deps.log("[tmux-session-manager] recovering spawn queue after previous failure", {
					error: String(error),
				});
			})
			.then(run)
			.catch((err) => {
				this.deps.log("[tmux-session-manager] spawn queue task failed", { error: String(err) });
			});
		await this.spawnQueue;
	}

	private async tryAttachDeferredSession(): Promise<void> {
		return spawnOrch.tryAttachDeferredSession(this.ctx());
	}

	// ──── Session lifecycle event handlers ────

	async onSessionCreated(event: SessionCreatedEvent): Promise<void> {
		const enabled = this.isEnabled();
		this.deps.log("[tmux-session-manager] onSessionCreated called", {
			enabled,
			tmuxConfigEnabled: this.tmuxConfig.enabled,
			isInsideTmux: this.deps.isInsideTmux(),
			eventType: event.type,
			infoId: event.properties?.info?.id,
			infoParentID: event.properties?.info?.parentID,
		});
		if (!enabled) return;
		if (event.type !== "session.created") return;
		const info = event.properties?.info;
		const sessionId = resolveSessionEventID(event.properties);
		if (!sessionId || !info?.parentID) return;
		await this.sweepStaleIsolatedSessionsOnce();
		if (this.shouldSkipSession(sessionId)) {
			this.deps.log("[tmux-session-manager] onSessionCreated skipped via shouldSkipSession", {
				sessionId,
				parentID: info.parentID,
			});
			return;
		}
		const title = info.title ?? "Subagent";
		if (!this.sourcePaneId) {
			this.deps.log("[tmux-session-manager] no source pane id");
			return;
		}
		if (!spawnOrch.beginPendingSession(this.ctx(), sessionId)) return;
		try {
			await spawnOrch.retryPendingCloses(this.ctx());
			const session = { sessionId, title };
			await this.enqueueSpawn(async () => {
				try {
					await spawnOrch.spawnPendingSession(this.ctx(), {
						session,
						stage: "session.created",
						rememberReadinessFailure: true,
					});
				} finally {
					this.pendingSessions.delete(sessionId);
				}
			});
		} finally {
			this.pendingSessions.delete(sessionId);
		}
	}

	async onSessionDeleted(event: { sessionID: string }): Promise<void> {
		if (!this.isEnabled()) return;
		this.closedByPolling.delete(event.sessionID);
		this.failedReadinessCache.clear(event.sessionID);
		this.removeDeferredSession(event.sessionID);
		if (!this.getEffectiveSourcePaneId()) return;
		const tracked = this.sessions.get(event.sessionID);
		if (!tracked) return;
		this.deps.log("[tmux-session-manager] onSessionDeleted", { sessionId: event.sessionID });
		const state = await spawnOrch.queryWindowStateSafely(this.ctx());
		if (!state) {
			spawnOrch.markSessionClosePending(this.ctx(), event.sessionID);
			return;
		}
		const closeAction = decideCloseAction(state, event.sessionID, this.getSessionMappings());
		if (!closeAction) {
			await spawnOrch.finalizeTrackedSessionClose(this.ctx(), { tracked, state, isolatedPaneAlreadyClosed: false });
			return;
		}
		const isolatedPaneAlreadyClosed = closeAction.type === "close" && closeAction.paneId === tracked.paneId;
		try {
			const result = await this.deps.executeAction(closeAction, {
				config: this.tmuxConfig,
				directory: this.projectDirectory,
				serverUrl: this.serverUrl,
				windowState: state,
				sourcePaneId: this.getEffectiveSourcePaneId(),
			});
			if (!result.success) {
				spawnOrch.markSessionClosePending(this.ctx(), event.sessionID);
				return;
			}
		} catch (error) {
			this.deps.log("[tmux-session-manager] failed to close pane for deleted session", {
				sessionId: event.sessionID,
				error: String(error),
			});
			spawnOrch.markSessionClosePending(this.ctx(), event.sessionID);
			return;
		}
		await spawnOrch.finalizeTrackedSessionClose(this.ctx(), { tracked, state, isolatedPaneAlreadyClosed });
	}

	onEvent(event: { type: string; properties?: Record<string, unknown> }): void {
		this.pollingManager.handleEvent(event);
		const sessionId = spawnOrch.getEventSessionId(event);
		if (event.type !== "session.idle" || !sessionId) return;
		void spawnOrch.retryFailedReadinessSession(this.ctx(), sessionId).catch((error) => {
			this.deps.log("[tmux-session-manager] session.idle retry failed", { sessionId, error: String(error) });
		});
	}

	createEventHandler(): (input: { event: { type: string; properties?: unknown } }) => Promise<void> {
		return async (input) => {
			await this.onSessionCreated(input.event as SessionCreatedEvent);
		};
	}

	// ──── Cleanup ────

	async cleanup(): Promise<void> {
		this.stopDeferredAttachLoop();
		this.deferredQueue = [];
		this.deferredSessions.clear();
		this.closedByPolling.clear();
		this.failedReadinessCache.clearAll();
		this.pollingManager.stopPolling();
		if (this.sessions.size > 0) {
			this.deps.log("[tmux-session-manager] closing all panes", { count: this.sessions.size });
			for (const sessionId of Array.from(this.sessions.keys())) {
				try {
					await spawnOrch.closeSessionById(this.ctx(), sessionId);
				} catch (error) {
					this.deps.log("[tmux-session-manager] cleanup error for pane", { sessionId, error: String(error) });
				}
			}
		}
		await spawnOrch.retryPendingCloses(this.ctx());
		this.isolatedContainerNullStateCount = 0;
		this.isolatedContainerPaneId = undefined;
		this.isolatedWindowPaneId = undefined;
		if (this.tmuxConfig.isolation === "session") {
			const isolatedSessionName = getIsolatedSessionName(process.pid, this.isolatedSessionManagerId);
			try {
				const killed = await killTmuxSessionIfExists(isolatedSessionName);
				this.deps.log("[tmux-session-manager] isolated session teardown", { session: isolatedSessionName, killed });
			} catch (error) {
				this.deps.log("[tmux-session-manager] isolated session teardown failed", {
					session: isolatedSessionName,
					error: String(error),
				});
			}
		}
		this.staleSweepCompleted = false;
		this.staleSweepInProgress = false;
		this.deps.log("[tmux-session-manager] cleanup complete");
	}

	private async sweepStaleIsolatedSessionsOnce(): Promise<void> {
		if (this.staleSweepCompleted || this.staleSweepInProgress) return;
		this.staleSweepInProgress = true;
		try {
			const report = await sweepStaleTmuxResources({
				isolation: this.tmuxConfig.isolation,
				sweepStaleOmoAgentSessions,
				sweepStaleOmoAttachPanes,
			});
			if (report.killed > 0) {
				this.deps.log("[tmux-session-manager] stale tmux resources swept", {
					killed: report.killed,
					killedAttachPanes: report.killedAttachPanes,
					killedIsolatedSessions: report.killedIsolatedSessions,
				});
			}
			this.staleSweepCompleted = true;
		} catch (error) {
			this.deps.log("[tmux-session-manager] stale sweep failed", { error: String(error) });
		} finally {
			this.staleSweepInProgress = false;
		}
	}
}
