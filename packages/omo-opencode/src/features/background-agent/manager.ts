import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import type { BackgroundTaskConfig, TmuxConfig } from "../../config/schema";
import { setContinuationMarkerSource } from "../../features/run-continuation-state";
import type { ModelFallbackControllerAccessor } from "../../hooks/model-fallback";
import { isSessionActive as isOpenCodeSessionActive } from "../../hooks/shared/session-idle-settle";
import {
	createInternalAgentTextPart,
	hasInternalInitiatorMarker,
	log,
	messagesInDirectory,
	normalizePromptTools,
	normalizeSDKResponse,
	promptWithRetryInDirectory,
	resolveInheritedPromptTools,
} from "../../shared";
import {
	clearDelegatedChildSessionBootstrap,
	registerDelegatedChildSessionBootstrap,
} from "../../shared/delegated-child-session-bootstrap";
import { resolveMessageEventSessionID, resolveSessionEventID } from "../../shared/event-session-id";
import { resolveDispatchClient } from "../../shared/live-server-route";
import { hasMoreFallbacks, shouldRetryError } from "../../shared/model-error-classifier";
import { SessionCategoryRegistry } from "../../shared/session-category-registry";
import { setSessionTools } from "../../shared/session-tools-store";
import { clearSessionAgent, setSessionAgent, subagentSessions } from "../claude-code-session-state";
import { MESSAGE_STORAGE } from "../hook-message-injector";
import { getTaskToastManager } from "../task-toast-manager";
import { abortWithTimeout } from "./abort-with-timeout";
import {
	bindAttemptSession,
	ensureCurrentAttempt,
	finalizeAttempt,
	findAttemptBySession,
	getCurrentAttempt,
	startAttempt,
} from "./attempt-lifecycle";
import type { BackgroundTaskNotificationTask } from "./background-task-notification-template";
import { buildBackgroundTaskNotificationText } from "./background-task-notification-template";
import * as CancelMod from "./cancel";
import {
	findNearestMessageExcludingCompaction,
	resolvePromptContextFromSessionMessages,
} from "./compaction-aware-message-resolver";
import { ConcurrencyManager } from "./concurrency";
import { POLLING_INTERVAL_MS, type QueueItem, TASK_CLEANUP_DELAY_MS, TASK_TTL_MS } from "./constants";
import { formatDuration } from "./duration-formatter";
import { isEmptyNoProgressAssistantTurnInfo } from "./empty-assistant-turn";
import {
	extractErrorMessage,
	extractErrorName,
	extractErrorStatusCode,
	getSessionErrorMessage,
	isAbortedSessionError,
	isRecord,
} from "./error-classifier";
import { tryFallbackRetry as rawFallbackRetry } from "./fallback-retry-handler";
// Extracted lifecycle modules
import * as LaunchMod from "./launch";
import type { CircuitBreakerSettings } from "./loop-detector";
import { detectRepetitiveToolUse, recordToolCall, resolveCircuitBreakerSettings } from "./loop-detector";
import type { BgManagerAPI } from "./manager-api";
import { messageUpdatedInfoHasParentWakeOutput } from "./message-updated-parent-wake-output";
import type { PendingParentWake } from "./parent-wake-dedupe";
import { ParentWakeNotifier, type ParentWakePromptContext } from "./parent-wake-notifier";
import { registerManagerForCleanup, unregisterManagerForCleanup } from "./process-cleanup";
import { removeTaskToastTracking } from "./remove-task-toast-tracking";
import { MIN_SESSION_GONE_POLLS, verifySessionExists as rawVerifySessionExists } from "./session-existence";
import { handleSessionIdleBackgroundEvent } from "./session-idle-event-handler";
import { isActiveSessionStatus, isTerminalSessionStatus } from "./session-status-classifier";
import {
	hasOutputSignalFromPart,
	isInternalInitiatorTextPart,
	isMessagePartForSession,
	resolveMessagePartInfo,
	resolveSessionNextPartInfo,
	SESSION_NEXT_EVENT_PREFIX,
} from "./session-stream-activity";
import { buildFallbackBody, FALLBACK_AGENT, isAgentNotFoundError } from "./spawner";
import {
	createSubagentDepthLimitError,
	getMaxSubagentDepth,
	resolveSubagentSpawnContext,
	type SubagentSpawnContext,
} from "./subagent-spawn-limits";
import { TaskHistory } from "./task-history";
import { checkAndInterruptStaleTasks, pruneStaleTasksAndNotifications, type SessionStatusMap } from "./task-poller";
import {
	archiveBackgroundTask,
	forgetBackgroundTask,
	getRegisteredBackgroundTask,
	rememberBackgroundTask,
} from "./task-registry";
import { toBackgroundTaskSnapshots } from "./task-snapshot";
import type { BackgroundTask, BackgroundTaskAttempt, BackgroundTaskSnapshot, LaunchInput, ResumeInput } from "./types";

type OpencodeClient = PluginInput["client"];
type ResumeTaskSnapshot = {
	status: BackgroundTask["status"];
	completedAt?: Date;
	error?: string;
	startedAt?: Date;
	progress?: BackgroundTask["progress"];
	parentSessionId: string;
	parentMessageId: string;
	parentModel?: BackgroundTask["parentModel"];
	parentAgent?: string;
	parentTools?: Record<string, boolean>;
	concurrencyKey?: string;
	concurrencyGroup?: string;
};

const PENDING_PARENT_WAKE_RETRY_MS = 1_000;
const PENDING_PARENT_WAKE_DEBOUNCE_MS = 100;
const PARENT_WAKE_ACCEPTED_MESSAGE_SKEW_MS = 5_000;
const PARENT_WAKE_TOOL_CALL_DEFER_MAX_MS = 5_000;
const PARENT_WAKE_USER_MESSAGE_IN_PROGRESS_WINDOW_MS = 2_000;
const PARENT_WAKE_SESSION_ACTIVITY_IN_PROGRESS_WINDOW_MS = PARENT_WAKE_TOOL_CALL_DEFER_MAX_MS;
const PARENT_WAKE_FAILURE_REQUEUE_WINDOW_MS = 5_000;
const MAX_COMPLETED_TASK_ARCHIVE_SIZE = 100;
const MAX_TASK_REMOVAL_RESCHEDULES = 6;

export interface SubagentSessionCreatedEvent {
	sessionID: string;
	parentID: string;
	title: string;
}
export type OnSubagentSessionCreated = (event: SubagentSessionCreatedEvent) => Promise<void>;
export interface SubagentSessionDeletedEvent {
	sessionID: string;
}
export type OnSubagentSessionDeleted = (event: SubagentSessionDeletedEvent) => Promise<void>;

export interface BackgroundManagerConfig {
	pluginContext: PluginInput;
	config?: BackgroundTaskConfig;
	tmuxConfig?: TmuxConfig;
	onSubagentSessionCreated?: OnSubagentSessionCreated;
	onSubagentSessionDeleted?: OnSubagentSessionDeleted;
	onShutdown?: () => void | Promise<void>;
	enableParentSessionNotifications?: boolean;
	modelFallbackControllerAccessor?: ModelFallbackControllerAccessor;
	log?: typeof log;
}

export class BackgroundManager {
	private tasks = new Map<string, BackgroundTask>();
	private tasksByParentSession = new Map<string, Set<string>>();
	private notifications = new Map<string, BackgroundTask[]>();
	private pendingNotifications = new Map<string, string[]>();
	private pendingByParent = new Map<string, Set<string>>();
	private completedTaskArchive = new Map<string, BackgroundTask>();
	private completedTaskSummaries = new Map<string, BackgroundTaskNotificationTask[]>();
	private completionTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private idleDeferralTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private notificationQueueByParent = new Map<string, Promise<void>>();
	private rootDescendantCounts = new Map<string, number>();
	private preStartDescendantReservations = new Set<string>();
	private queuesByKey = new Map<string, QueueItem[]>();
	private processingKeys = new Set<string>();
	private client: OpencodeClient;
	private directory: string;
	private pollingInterval?: ReturnType<typeof setInterval>;
	private pollingInFlight = false;
	private concurrencyManager: ConcurrencyManager;
	private shutdownTriggered = false;
	private config?: BackgroundTaskConfig;
	private tmuxEnabled: boolean;
	private onSubagentSessionCreated?: OnSubagentSessionCreated;
	private onSubagentSessionDeleted?: OnSubagentSessionDeleted;
	private onShutdown?: () => void | Promise<void>;
	private enableParentSessionNotifications: boolean;
	private modelFallbackControllerAccessor?: ModelFallbackControllerAccessor;
	private logger: typeof log;
	private loggedSessionStatusUnavailable = false;
	readonly taskHistory = new TaskHistory();
	private cachedCircuitBreakerSettings?: CircuitBreakerSettings;
	private readonly parentWakeNotifier: ParentWakeNotifier;
	private parentWakeTextDeltaBuffers = new Map<string, string>();
	private observedOutputSessions = new Set<string>();
	private observedIncompleteTodosBySession = new Map<string, boolean>();

	private ctx(): BgManagerAPI {
		return this as unknown as BgManagerAPI;
	}

	constructor(config: BackgroundManagerConfig) {
		const { pluginContext, ...opts } = config;
		this.client = pluginContext.client;
		this.directory = pluginContext.directory;
		this.concurrencyManager = new ConcurrencyManager(opts.config);
		this.config = opts.config;
		this.tmuxEnabled = opts?.tmuxConfig?.enabled ?? false;
		this.onSubagentSessionCreated = opts?.onSubagentSessionCreated;
		this.onSubagentSessionDeleted = opts?.onSubagentSessionDeleted;
		this.onShutdown = opts?.onShutdown;
		this.enableParentSessionNotifications = opts?.enableParentSessionNotifications ?? true;
		this.modelFallbackControllerAccessor = opts?.modelFallbackControllerAccessor;
		this.logger = opts?.log ?? log;
		this.parentWakeNotifier = new ParentWakeNotifier(
			{
				client: this.client,
				directory: this.directory,
				enqueueNotificationForParent: this.enqueueNotificationForParent.bind(this),
			},
			{
				pendingRetryMs: PENDING_PARENT_WAKE_RETRY_MS,
				acceptedMessageSkewMs: PARENT_WAKE_ACCEPTED_MESSAGE_SKEW_MS,
				toolCallDeferMaxMs: PARENT_WAKE_TOOL_CALL_DEFER_MAX_MS,
				failureRequeueWindowMs: PARENT_WAKE_FAILURE_REQUEUE_WINDOW_MS,
				userMessageInProgressWindowMs: PARENT_WAKE_USER_MESSAGE_IN_PROGRESS_WINDOW_MS,
				parentSessionActivityInProgressWindowMs: PARENT_WAKE_SESSION_ACTIVITY_IN_PROGRESS_WINDOW_MS,
			},
		);
		registerManagerForCleanup(this);
	}

	// === Launch/recovery (delegated to launch.ts) ===
	async assertCanSpawn(ps: string) {
		return LaunchMod.assertCanSpawn(this.ctx(), ps);
	}
	async reserveSubagentSpawn(ps: string) {
		return LaunchMod.reserveSubagentSpawn(this.ctx(), ps);
	}
	async launch(i: LaunchInput) {
		return LaunchMod.launchTask(this.ctx(), i);
	}
	async resume(i: ResumeInput) {
		return LaunchMod.resumeTask(this.ctx(), i);
	}
	async trackTask(i: {
		taskId: string;
		sessionId: string;
		parentSessionId: string;
		description: string;
		agent?: string;
		parentAgent?: string;
		concurrencyKey?: string;
	}) {
		return LaunchMod.trackExternalTask(this.ctx(), i);
	}
	private async processKey(k: string): Promise<void> {
		return LaunchMod.processQueueKey(this.ctx(), k);
	}
	private async startTask(item: QueueItem): Promise<void> {
		return LaunchMod.startQueuedTask(this.ctx(), item);
	}
	// @allow Test-accessible private wrappers for extracted methods
	private addTask(task: BackgroundTask): void {
		LaunchMod.addTask(this.ctx(), task);
	}
	private removeTask(task: BackgroundTask): void {
		LaunchMod.removeTask(this.ctx(), task);
	}
	private async checkAndInterruptStaleTasks(allStatuses: SessionStatusMap | undefined): Promise<void> {
		await checkAndInterruptStaleTasks({
			tasks: this.tasks.values(),
			client: this.client,
			directory: this.directory,
			config: this.config,
			concurrencyManager: this.concurrencyManager,
			notifyParentSession: (task) =>
				this.enqueueNotificationForParent(task.parentSessionId, () => this.notifyParentSession(task)),
			sessionStatuses: allStatuses,
		});
	}
	private pruneStaleTasksAndNotifications(allStatuses?: SessionStatusMap): void {
		pruneStaleTasksAndNotifications({
			tasks: this.tasks,
			notifications: this.notifications,
			taskTtlMs: this.config?.taskTtlMs,
			sessionStatuses: allStatuses,
			onTaskPruned: (tid, task, em) => {
				const wp = task.status === "pending";
				task.status = "error";
				task.error = em;
				task.completedAt = new Date();
				if (!wp && task.rootSessionId) {
					const c = this.rootDescendantCounts.get(task.rootSessionId) ?? 0;
					if (c <= 1) this.rootDescendantCounts.delete(task.rootSessionId);
					else this.rootDescendantCounts.set(task.rootSessionId, c - 1);
				}
				this.taskHistory.record(task.parentSessionId, {
					id: task.id,
					sessionID: task.sessionId,
					agent: task.agent,
					description: task.description,
					status: "error",
					category: task.category,
					startedAt: task.startedAt,
					completedAt: task.completedAt,
				});
				if (task.concurrencyKey) {
					this.concurrencyManager.release(task.concurrencyKey);
					task.concurrencyKey = undefined;
				}
				removeTaskToastTracking(task.id);
				const e = this.completionTimers.get(tid);
				if (e) {
					clearTimeout(e);
					this.completionTimers.delete(tid);
				}
				const it = this.idleDeferralTimers.get(tid);
				if (it) {
					clearTimeout(it);
					this.idleDeferralTimers.delete(tid);
				}
				if (wp) {
					const rk = task.model ? `${task.model.providerID}/${task.model.modelID}` : task.agent;
					const k = this.concurrencyManager.getConcurrencyKey(rk);
					const q = this.queuesByKey.get(k);
					if (q) {
						const i = q.findIndex((item) => item.task.id === tid);
						if (i !== -1) {
							q.splice(i, 1);
							if (q.length === 0) this.queuesByKey.delete(k);
						}
					}
				}
				this.cleanupPendingByParent(task);
				if (task.parentSessionId) this.updateBackgroundTaskMarker(task.parentSessionId);
				this.markForNotification(task);
				this.enqueueNotificationForParent(task.parentSessionId, () => this.notifyParentSession(task)).catch(
					(err) => {
						log("[background-agent] Error in notifyParentSession for stale-pruned task:", {
							taskId: task.id,
							error: err,
						});
					},
				);
			},
		});
	}

	// === Cancel/Shutdown (delegated to cancel.ts) ===
	async cancelTask(
		id: string,
		opts?: { source?: string; reason?: string; abortSession?: boolean; skipNotification?: boolean },
	) {
		return CancelMod.cancelTask(this.ctx(), id, opts);
	}
	cancelPendingTask(id: string): boolean {
		return CancelMod.cancelPendingTask(this.ctx(), id);
	}
	async shutdown() {
		await CancelMod.shutdownManager(this.ctx());
		unregisterManagerForCleanup(this);
	}

	// === Query helpers ===
	getTask(id: string) {
		return this.tasks.get(id) ?? this.completedTaskArchive.get(id) ?? getRegisteredBackgroundTask(id);
	}
	getTasksSnapshot() {
		return toBackgroundTaskSnapshots(this.tasks.values());
	}
	getTasksByParentSession(sid: string): BackgroundTask[] {
		const ids = this.tasksByParentSession.get(sid);
		if (!ids) {
			const r: BackgroundTask[] = [];
			for (const t of this.tasks.values()) {
				if (t.parentSessionId === sid) r.push(t);
			}
			return r;
		}
		const r: BackgroundTask[] = [];
		for (const tid of ids) {
			const t = this.tasks.get(tid);
			if (t) r.push(t);
		}
		return r;
	}
	hasActiveChildTasks(sid: string) {
		return this.getTasksByParentSession(sid).some((t) => t.status === "running" || t.status === "pending");
	}
	hasPendingParentWake(sid: string) {
		return (
			this.parentWakeNotifier.hasNotificationPreparation(sid) ||
			this.parentWakeNotifier.getPendingParentWakes().has(sid) ||
			this.parentWakeNotifier.getPendingParentWakeTimers().has(sid) ||
			this.parentWakeNotifier.hasInFlightParentWakeDispatch(sid) ||
			this.parentWakeNotifier.getDispatchedParentWakes().has(sid)
		);
	}
	getAllDescendantTasks(sid: string): BackgroundTask[] {
		const r: BackgroundTask[] = [];
		for (const c of this.getTasksByParentSession(sid)) {
			r.push(c);
			if (c.sessionId) r.push(...this.getAllDescendantTasks(c.sessionId));
		}
		return r;
	}
	findBySession(sid: string) {
		for (const t of this.tasks.values()) {
			if (t.sessionId === sid) return t;
			if (findAttemptBySession(t, sid)) return t;
		}
		return undefined;
	}
	private resolveTaskAttemptBySession(sid: string) {
		const t = this.findBySession(sid);
		if (!t) return undefined;
		const a = findAttemptBySession(t, sid);
		if (!a) return { task: t, attemptID: undefined, isCurrent: t.sessionId === sid };
		return { task: t, attemptID: a.attemptId, isCurrent: t.currentAttemptID === a.attemptId };
	}
	getRunningTasks() {
		return Array.from(this.tasks.values()).filter((t) => t.status === "running");
	}
	getNonRunningTasks() {
		return Array.from(this.tasks.values()).filter((t) => t.status !== "running");
	}
	private hasRunningTasks() {
		for (const t of this.tasks.values()) if (t.status === "running") return true;
		return false;
	}

	// === Polling ===
	private startPolling() {
		if (this.pollingInterval) return;
		this.pollingInterval = setInterval(() => {
			void this.pollRunningTasks();
		}, POLLING_INTERVAL_MS);
		this.pollingInterval.unref();
	}
	private stopPolling() {
		if (this.pollingInterval) {
			clearInterval(this.pollingInterval);
			this.pollingInterval = undefined;
		}
	}

	private async pollRunningTasks() {
		if (this.pollingInFlight) return;
		this.pollingInFlight = true;
		try {
			let allStatuses: SessionStatusMap | undefined;
			const ssm = this.client?.session?.status;
			if (typeof ssm !== "function") {
				if (!this.loggedSessionStatusUnavailable) {
					log("[background-agent] Unable to poll session statuses:", { reason: "session.status unavailable" });
					this.loggedSessionStatusUnavailable = true;
				}
			} else {
				try {
					const sr = await this.client.session.status();
					allStatuses = normalizeSDKResponse(sr, {});
				} catch (error) {
					if (!this.loggedSessionStatusUnavailable) {
						log("[background-agent] Error polling session statuses:", { error });
						this.loggedSessionStatusUnavailable = true;
					}
				}
			}
			pruneStaleTasksAndNotifications({
				tasks: this.tasks,
				notifications: this.notifications,
				taskTtlMs: this.config?.taskTtlMs,
				sessionStatuses: allStatuses,
				onTaskPruned: (tid, task, em) => {
					const wp = task.status === "pending";
					task.status = "error";
					task.error = em;
					task.completedAt = new Date();
					if (!wp && task.rootSessionId) {
						const c = this.rootDescendantCounts.get(task.rootSessionId) ?? 0;
						if (c <= 1) this.rootDescendantCounts.delete(task.rootSessionId);
						else this.rootDescendantCounts.set(task.rootSessionId, c - 1);
					}
					this.taskHistory.record(task.parentSessionId, {
						id: task.id,
						sessionID: task.sessionId,
						agent: task.agent,
						description: task.description,
						status: "error",
						category: task.category,
						startedAt: task.startedAt,
						completedAt: task.completedAt,
					});
					if (task.concurrencyKey) {
						this.concurrencyManager.release(task.concurrencyKey);
						task.concurrencyKey = undefined;
					}
					removeTaskToastTracking(task.id);
					const e = this.completionTimers.get(tid);
					if (e) {
						clearTimeout(e);
						this.completionTimers.delete(tid);
					}
					const it = this.idleDeferralTimers.get(tid);
					if (it) {
						clearTimeout(it);
						this.idleDeferralTimers.delete(tid);
					}
					if (wp) {
						const rk = task.model ? `${task.model.providerID}/${task.model.modelID}` : task.agent;
						const k = this.concurrencyManager.getConcurrencyKey(rk);
						const q = this.queuesByKey.get(k);
						if (q) {
							const i = q.findIndex((item) => item.task.id === tid);
							if (i !== -1) {
								q.splice(i, 1);
								if (q.length === 0) this.queuesByKey.delete(k);
							}
						}
					}
					this.cleanupPendingByParent(task);
					if (task.parentSessionId) this.updateBackgroundTaskMarker(task.parentSessionId);
					this.markForNotification(task);
					this.enqueueNotificationForParent(task.parentSessionId, () => this.notifyParentSession(task)).catch(
						(err) => {
							log("[background-agent] Error in notifyParentSession for stale-pruned task:", {
								taskId: task.id,
								error: err,
							});
						},
					);
				},
			});
			await checkAndInterruptStaleTasks({
				tasks: this.tasks.values(),
				client: this.client,
				directory: this.directory,
				config: this.config,
				concurrencyManager: this.concurrencyManager,
				notifyParentSession: (task) =>
					this.enqueueNotificationForParent(task.parentSessionId, () => this.notifyParentSession(task)),
				sessionStatuses: allStatuses,
			});
			for (const task of this.tasks.values()) {
				if (task.status !== "running") continue;
				const sid = task.sessionId;
				if (!sid) continue;
				try {
					const ss = allStatuses?.[sid];
					if (ss?.type === "retry") {
						const rm =
							typeof (ss as { message?: string }).message === "string"
								? (ss as { message?: string }).message
								: undefined;
						if (
							await this.tryFallbackRetry(task, { name: "SessionRetry", message: rm }, "polling:session.status")
						)
							continue;
					}
					if (ss && isActiveSessionStatus(ss.type)) continue;
					if (ss && isTerminalSessionStatus(ss.type)) {
						await this.tryCompleteTask(task, `polling (terminal session status: ${ss.type})`);
						continue;
					}
					if (allStatuses === undefined) continue;
					const sgfs = allStatuses !== undefined && !ss;
					const sgtr = sgfs && (task.consecutiveMissedPolls ?? 0) >= MIN_SESSION_GONE_POLLS;
					const cs = ss?.type === "idle" ? "polling (idle status)" : "polling (session gone from status)";
					const hvo = await this.validateSessionHasOutput(sid);
					if (!hvo) {
						if (sgtr) {
							const se = await this.verifySessionExists(sid);
							if (!se) {
								await this.failCrashedTask(task, "Subagent session no longer exists (process likely crashed).");
								continue;
							}
							task.consecutiveMissedPolls = 0;
						}
						continue;
					}
					if (task.status !== "running") continue;
					if (await this.checkSessionTodos(sid)) continue;
					await this.tryCompleteTask(task, cs);
				} catch (error) {
					log("[background-agent] Poll error for task:", { taskId: task.id, error });
				}
			}
			if (!this.hasRunningTasks()) this.stopPolling();
		} finally {
			this.pollingInFlight = false;
		}
	}

	// === Event handling ===
	handleEvent(event: { type: string; properties?: Record<string, unknown> }) {
		const p = event.properties;
		if (event.type.startsWith(SESSION_NEXT_EVENT_PREFIX)) {
			const sid = resolveSessionEventID(p);
			const pi = resolveSessionNextPartInfo(event.type, p);
			if (!sid || !pi) return;
			this.handleEvent({ type: "message.part.updated", properties: { sessionID: sid, part: pi } });
			return;
		}
		if (event.type === "message.updated") {
			this.handleMessageUpdated(p);
			return;
		}
		if (event.type === "message.part.updated" || event.type === "message.part.delta") {
			this.handleMessagePart(event, p);
			return;
		}
		if (event.type === "todo.updated") {
			const sid = resolveSessionEventID(p);
			const todos = Array.isArray(p?.todos) ? p.todos : undefined;
			if (sid && todos) {
				const hi = todos.some(
					(t: unknown) =>
						t &&
						typeof t === "object" &&
						(t as { status?: string }).status !== "completed" &&
						(t as { status?: string }).status !== "cancelled",
				);
				this.observedIncompleteTodosBySession.set(sid, hi);
			}
			return;
		}
		if (event.type === "session.idle") {
			if (!p || typeof p !== "object") return;
			const sid = resolveSessionEventID(p);
			if (sid) {
				void this.enqueueNotificationForParent(sid, () =>
					this.parentWakeNotifier.flushPendingParentWake(sid),
				).catch((error: unknown) => {
					log("[background-agent] Failed to flush pending parent wake:", { sessionID: sid, error });
				});
			}
			handleSessionIdleBackgroundEvent({
				properties: p as Record<string, unknown>,
				findBySession: (id) => {
					const r = this.resolveTaskAttemptBySession(id);
					return r?.isCurrent ? r.task : undefined;
				},
				idleDeferralTimers: this.idleDeferralTimers,
				validateSessionHasOutput: (id) => this.validateSessionHasOutput(id),
				checkSessionTodos: (id) => this.checkSessionTodos(id),
				tryCompleteTask: (t, s) => this.tryCompleteTask(t, s),
				emitIdleEvent: (sid) => this.handleEvent({ type: "session.idle", properties: { sessionID: sid } }),
			});
			return;
		}
		if (event.type === "session.error") {
			void this.handleSessionError(p).catch((error: unknown) => {
				log("[background-agent] Error handling session.error event:", { error });
			});
			return;
		}
		if (event.type === "session.deleted") {
			this.handleSessionDeleted(p);
			return;
		}
		if (event.type === "session.status") {
			const sid = resolveSessionEventID(p);
			const s = p?.status as { type?: string; message?: string } | undefined;
			if (!sid || !s?.type) return;
			if (s.type === "idle") {
				this.handleEvent({ type: "session.idle", properties: { sessionID: sid } });
				return;
			}
			if (s.type === "retry") {
				const r = this.resolveTaskAttemptBySession(sid);
				if (!r?.isCurrent || r.task.status !== "running") return;
				void this.tryFallbackRetry(
					r.task,
					{ name: "SessionRetry", message: typeof s.message === "string" ? s.message : undefined },
					"session.status",
				).catch((error: unknown) => {
					log("[background-agent] Error handling session.status fallback retry:", { error, taskId: r.task.id });
				});
			}
			return;
		}
	}

	private handleMessageUpdated(p: Record<string, unknown> | undefined) {
		const info = p?.info;
		if (!isRecord(info)) return;
		const sid = resolveMessageEventSessionID(p);
		const role = info.role;
		if (!sid) return;
		if (isEmptyNoProgressAssistantTurnInfo(info)) {
			const dw = this.parentWakeNotifier.getDispatchedParentWakes().get(sid);
			if (dw) {
				this.parentWakeNotifier.requeueDispatchedParentWakeAfterEmptyAssistantTurn(sid);
				return;
			}
		}
		this.parentWakeNotifier.recordParentSessionActivity(sid);
		if (messageUpdatedInfoHasParentWakeOutput(info, role)) this.clearDispatchedParentWake(sid);
		if (role === "tool") this.observedOutputSessions.add(sid);
		if (role !== "assistant") return;
		const r = this.resolveTaskAttemptBySession(sid);
		if (!r?.isCurrent || r.task.status !== "running") return;
		const ae = (info as Record<string, unknown>).error;
		if (!ae) return;
		void this.tryFallbackRetry(
			r.task,
			{ name: extractErrorName(ae), message: extractErrorMessage(ae), statusCode: extractErrorStatusCode(ae) },
			"message.updated",
		).catch((error: unknown) => {
			log("[background-agent] Error handling message.updated fallback retry:", { error, taskId: r.task.id });
		});
	}

	private handleMessagePart(event: { type: string }, p: Record<string, unknown> | undefined) {
		const pi = resolveMessagePartInfo(p);
		const sid = resolveMessageEventSessionID(p);
		if (!sid) return;
		if (!isMessagePartForSession(pi, sid)) return;
		const iup = pi?.role === "user";
		const iiwp = isInternalInitiatorTextPart(pi, sid);
		const dw = this.parentWakeNotifier.getDispatchedParentWakes().get(sid);
		const hd = this.shouldHoldDispatchedParentWakeForTextDelta(event.type, pi, sid, dw);
		const hpo = hasOutputSignalFromPart(pi, sid) && !iup && !iiwp && !hd;
		if (hpo) this.clearDispatchedParentWake(sid);
		if (!iup && !iiwp && !hd) this.parentWakeNotifier.recordParentSessionActivity(sid);
		const r = this.resolveTaskAttemptBySession(sid);
		if (!r?.isCurrent) return;
		const { task } = r;
		if (hpo) this.observedOutputSessions.add(sid);
		const et = this.idleDeferralTimers.get(task.id);
		if (et) {
			clearTimeout(et);
			this.idleDeferralTimers.delete(task.id);
		}
		if (!task.progress) task.progress = { toolCalls: 0, lastUpdate: pi?.activityTime ?? new Date() };
		task.progress.lastUpdate = pi?.activityTime ?? new Date();
		if (pi?.type === "tool" || pi?.tool) {
			const cids = task.progress.countedToolPartIDs ?? new Set<string>();
			const sc = !pi.id || pi.state?.status !== "running" || !cids.has(pi.id);
			if (!sc) return;
			if (pi.id && pi.state?.status === "running") {
				cids.add(pi.id);
				task.progress.countedToolPartIDs = cids;
			}
			task.progress.toolCalls += 1;
			task.progress.lastTool = pi.tool;
			const cb = this.cachedCircuitBreakerSettings ?? resolveCircuitBreakerSettings(this.config);
			this.cachedCircuitBreakerSettings = cb;
			if (pi.tool) {
				task.progress.toolCallWindow = recordToolCall(
					task.progress.toolCallWindow,
					pi.tool,
					cb,
					(pi.state?.input ?? pi.input) as Record<string, unknown> | undefined,
				);
				if (cb.enabled) {
					const ld = detectRepetitiveToolUse(task.progress.toolCallWindow);
					if (ld.triggered) {
						void this.cancelTask(task.id, {
							source: "circuit-breaker",
							reason: `Subagent called ${ld.toolName} ${ld.repeatedCount} consecutive times (threshold: ${cb.consecutiveThreshold}). This usually indicates an infinite loop. The task was automatically cancelled to prevent excessive token usage.`,
						});
						return;
					}
				}
			}
			if (task.progress.toolCalls >= cb.maxToolCalls) {
				void this.cancelTask(task.id, {
					source: "circuit-breaker",
					reason: `Subagent exceeded maximum tool call limit (${cb.maxToolCalls}). This usually indicates an infinite loop. The task was automatically cancelled to prevent excessive token usage.`,
				});
			}
		}
	}

	private async handleSessionError(p: Record<string, unknown> | undefined) {
		const sid = resolveSessionEventID(p);
		if (!sid) return;
		const r = this.resolveTaskAttemptBySession(sid);
		if (this.parentWakeNotifier.getDispatchedParentWakes().has(sid) || !r?.isCurrent) {
			void this.parentWakeNotifier
				.requeueDispatchedParentWake(sid, "session.error")
				.then(() => {
					const pr = `${sid}:`;
					for (const k of this.parentWakeTextDeltaBuffers.keys())
						if (k.startsWith(pr)) this.parentWakeTextDeltaBuffers.delete(k);
				})
				.catch((error: unknown) => {
					log("[background-agent] Failed to requeue dispatched parent wake:", { sessionID: sid, error });
				});
			return;
		}
		const { task } = r;
		if (task.status !== "running") return;
		const eo = p?.error as { name?: string; message?: string } | undefined;
		const en = eo?.name;
		const em = p ? getSessionErrorMessage(p) : undefined;
		const ei = { name: en, message: em };
		if (!task.fallbackChain && task.sessionId) {
			const sfc = this.modelFallbackControllerAccessor?.getSessionFallbackChain(task.sessionId);
			if (sfc?.length) task.fallbackChain = sfc;
		}
		if (isAgentNotFoundError({ message: ei.message ?? "" })) {
			await this.interruptTaskFromAsyncPromptFailure(
				task,
				`Agent "${task.agent}" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.`,
				"agent-not-found session.error",
			);
			return;
		}
		if (await this.tryFallbackRetry(task, ei, "session.error")) return;
		const ems = em ?? "Session error";
		if (task.sessionId) {
			const sa = await this.verifySessionExists(task.sessionId);
			if (sa) {
				this.logger("[background-agent] session.error received but session still alive, treating as transient:", {
					taskId: task.id,
					sessionId: task.sessionId,
					errorMessage: ems?.slice(0, 200),
				});
				return;
			}
		}
		if (task.currentAttemptID) finalizeAttempt(task, task.currentAttemptID, "error", ems);
		else {
			task.status = "error";
			task.error = ems;
			task.completedAt = new Date();
		}
		if (task.rootSessionId) {
			const c = this.rootDescendantCounts.get(task.rootSessionId) ?? 0;
			if (c <= 1) this.rootDescendantCounts.delete(task.rootSessionId);
			else this.rootDescendantCounts.set(task.rootSessionId, c - 1);
		}
		this.taskHistory.record(task.parentSessionId, {
			id: task.id,
			sessionID: task.sessionId,
			agent: task.agent,
			description: task.description,
			status: "error",
			category: task.category,
			startedAt: task.startedAt,
			completedAt: task.completedAt,
		});
		if (task.concurrencyKey) {
			this.concurrencyManager.release(task.concurrencyKey);
			task.concurrencyKey = undefined;
		}
		const ct = this.completionTimers.get(task.id);
		if (ct) {
			clearTimeout(ct);
			this.completionTimers.delete(task.id);
		}
		const it = this.idleDeferralTimers.get(task.id);
		if (it) {
			clearTimeout(it);
			this.idleDeferralTimers.delete(task.id);
		}
		this.cleanupPendingByParent(task);
		this.clearNotificationsForTask(task.id);
		const tm = getTaskToastManager();
		if (tm) tm.removeTask(task.id);
		this.scheduleTaskRemoval(task.id);
		if (task.sessionId) {
			clearDelegatedChildSessionBootstrap(task.sessionId);
			SessionCategoryRegistry.remove(task.sessionId);
		}
		if (task.parentSessionId) this.updateBackgroundTaskMarker(task.parentSessionId);
		this.markForNotification(task);
		this.enqueueNotificationForParent(task.parentSessionId, () => this.notifyParentSession(task)).catch((err) => {
			log("[background-agent] Error in notifyParentSession for errored task:", { taskId: task.id, error: err });
		});
	}

	private handleSessionDeleted(p: Record<string, unknown> | undefined) {
		const sid = resolveSessionEventID(p);
		if (!sid) return;
		this.observedOutputSessions.delete(sid);
		this.observedIncompleteTodosBySession.delete(sid);
		const tc = new Map<string, BackgroundTask>();
		const dt = this.resolveTaskAttemptBySession(sid);
		if (dt?.isCurrent) tc.set(dt.task.id, dt.task);
		for (const d of this.getAllDescendantTasks(sid)) tc.set(d.id, d);
		this.pendingNotifications.delete(sid);
		if (tc.size === 0) {
			this.clearTaskHistoryWhenParentTasksGone(sid);
			clearSessionAgent(sid);
			return;
		}
		const psc = new Set<string>();
		const dsi = new Set<string>([sid]);
		for (const t of tc.values()) {
			if (t.sessionId) dsi.add(t.sessionId);
		}
		for (const t of tc.values()) {
			psc.add(t.parentSessionId);
			if (t.status === "running" || t.status === "pending") {
				void this.cancelTask(t.id, { source: "session.deleted", reason: "Session deleted" })
					.then(() => {
						if (dsi.has(t.parentSessionId)) this.pendingNotifications.delete(t.parentSessionId);
					})
					.catch((err) => {
						if (dsi.has(t.parentSessionId)) this.pendingNotifications.delete(t.parentSessionId);
						log("[background-agent] Failed to cancel task on session.deleted:", { taskId: t.id, error: err });
					});
			}
		}
		for (const ps of psc) this.clearTaskHistoryWhenParentTasksGone(ps);
		this.rootDescendantCounts.delete(sid);
		clearDelegatedChildSessionBootstrap(sid);
		clearSessionAgent(sid);
		SessionCategoryRegistry.remove(sid);
	}

	// === Error/recovery ===
	private async abortSessionWithLogging(sid: string, reason: string) {
		try {
			const a = await abortWithTimeout(this.client, sid);
			if (!a) log(`[background-agent] Session abort did not complete during ${reason}:`, { sessionID: sid });
			return a;
		} catch (error) {
			log(`[background-agent] Failed to abort session during ${reason}:`, { sessionID: sid, error });
			return false;
		}
	}

	private async tryFallbackRetry(
		task: BackgroundTask,
		errorInfo: { name?: string; message?: string; statusCode?: number },
		source: string,
	): Promise<boolean> {
		const psid = task.sessionId;
		let rn: string | undefined;
		const r = rawFallbackRetry({
			task,
			errorInfo,
			source,
			concurrencyManager: this.concurrencyManager,
			client: this.client,
			idleDeferralTimers: this.idleDeferralTimers,
			queuesByKey: this.queuesByKey,
			processKey: (k: string) => {
				void this.processKey(k);
			},
			onRetrying: ({ task: t, source: s }) => {
				const ca = getCurrentAttempt(t);
				const pa = getPreviousAttempt(t, ca?.attemptId);
				const st = s ? ` via ${s}` : "";
				rn = `<system-reminder>\n[BACKGROUND TASK RETRYING]\n**ID:** \`${t.id}\`\n**Description:** ${t.description}${st}${pa?.sessionId ? `\n- Failed session: \`${pa.sessionId}\`` : ""}${pa?.providerId && pa.modelId ? `\n- Failed model: \`${pa.providerId}/${pa.modelId}\`` : ""}${pa?.error ? `\n- Error: ${pa.error}` : ""}${ca?.providerId && ca.modelId ? `\n- Next model: \`${ca.providerId}/${ca.modelId}\`` : ""}\n\nThe task was re-queued on a fallback model after a retryable failure.\n</system-reminder>`;
			},
		});
		const retried = await r;
		if (retried && rn)
			this.queuePendingParentWake(
				task.parentSessionId,
				rn,
				await this.resolveParentWakePromptContext(task),
				false,
				PENDING_PARENT_WAKE_DEBOUNCE_MS,
			);
		if (retried && psid) {
			this.observedOutputSessions.delete(psid);
			this.observedIncompleteTodosBySession.delete(psid);
			clearDelegatedChildSessionBootstrap(psid);
			subagentSessions.delete(psid);
		}
		return retried;
	}

	private async interruptTaskFromAsyncPromptFailure(task: BackgroundTask, em: string, reason: string) {
		const np = task.parentSessionId;
		if (np) this.parentWakeNotifier.reserveNotificationPreparation(np);
		const rel = () => {
			if (np) this.parentWakeNotifier.releaseNotificationPreparation(np);
		};
		if (task.currentAttemptID) finalizeAttempt(task, task.currentAttemptID, "interrupt", em);
		else {
			task.status = "interrupt";
			task.error = em;
			task.completedAt = new Date();
		}
		if (task.rootSessionId) {
			const c = this.rootDescendantCounts.get(task.rootSessionId) ?? 0;
			if (c <= 1) this.rootDescendantCounts.delete(task.rootSessionId);
			else this.rootDescendantCounts.set(task.rootSessionId, c - 1);
		}
		this.taskHistory.record(task.parentSessionId, {
			id: task.id,
			sessionID: task.sessionId,
			agent: task.agent,
			description: task.description,
			status: "interrupt",
			category: task.category,
			startedAt: task.startedAt,
			completedAt: task.completedAt,
		});
		if (task.concurrencyKey) {
			this.concurrencyManager.release(task.concurrencyKey);
			task.concurrencyKey = undefined;
		}
		const ct = this.completionTimers.get(task.id);
		if (ct) {
			clearTimeout(ct);
			this.completionTimers.delete(task.id);
		}
		const it = this.idleDeferralTimers.get(task.id);
		if (it) {
			clearTimeout(it);
			this.idleDeferralTimers.delete(task.id);
		}
		this.cleanupPendingByParent(task);
		this.clearNotificationsForTask(task.id);
		removeTaskToastTracking(task.id);
		this.scheduleTaskRemoval(task.id);
		if (task.sessionId) {
			clearDelegatedChildSessionBootstrap(task.sessionId);
			SessionCategoryRegistry.remove(task.sessionId);
			await this.abortSessionWithLogging(task.sessionId, `${reason} cleanup`);
		}
		this.updateBackgroundTaskMarker(task.parentSessionId);
		this.markForNotification(task);
		this.enqueueNotificationForParent(task.parentSessionId, () => this.notifyParentSession(task))
			.catch((err) => {
				log("[background-agent] Failed to notify on async prompt failure:", { taskId: task.id, error: err });
			})
			.finally(rel);
	}

	// === Completion/notification ===
	private async tryCompleteTask(task: BackgroundTask, source: string): Promise<boolean> {
		if (task.status !== "running") return false;
		const np = task.parentSessionId;
		if (np) this.parentWakeNotifier.reserveNotificationPreparation(np);
		try {
			if (task.currentAttemptID) finalizeAttempt(task, task.currentAttemptID, "completed");
			else {
				task.status = "completed";
				task.completedAt = new Date();
			}
			this.taskHistory.record(task.parentSessionId, {
				id: task.id,
				sessionID: task.sessionId,
				agent: task.agent,
				description: task.description,
				status: "completed",
				category: task.category,
				startedAt: task.startedAt,
				completedAt: task.completedAt,
			});
			if (task.rootSessionId) {
				const c = this.rootDescendantCounts.get(task.rootSessionId) ?? 0;
				if (c <= 1) this.rootDescendantCounts.delete(task.rootSessionId);
				else this.rootDescendantCounts.set(task.rootSessionId, c - 1);
			}
			removeTaskToastTracking(task.id);
			if (task.concurrencyKey) {
				this.concurrencyManager.release(task.concurrencyKey);
				task.concurrencyKey = undefined;
			}
			this.markForNotification(task);
			const it = this.idleDeferralTimers.get(task.id);
			if (it) {
				clearTimeout(it);
				this.idleDeferralTimers.delete(task.id);
			}
			if (task.sessionId) {
				subagentSessions.delete(task.sessionId);
				clearSessionAgent(task.sessionId);
				clearDelegatedChildSessionBootstrap(task.sessionId);
				SessionCategoryRegistry.remove(task.sessionId);
				await this.abortSessionWithLogging(task.sessionId, `task completion (${source})`);
				await this.onSubagentSessionDeleted?.({ sessionID: task.sessionId }).catch((error: unknown) => {
					log("[background-agent] onSubagentSessionDeleted callback failed:", {
						taskId: task.id,
						sessionID: task.sessionId,
						error: String(error),
					});
				});
			}
			if (task.parentSessionId) this.updateBackgroundTaskMarker(task.parentSessionId);
			try {
				await this.enqueueNotificationForParent(task.parentSessionId, () => this.notifyParentSession(task));
			} catch (err) {
				log("[background-agent] Error in notifyParentSession:", { taskId: task.id, error: err });
			}
			return true;
		} finally {
			if (np) this.parentWakeNotifier.releaseNotificationPreparation(np);
		}
	}

	private async notifyParentSession(task: BackgroundTask) {
		const dur = formatDuration(task.startedAt ?? new Date(), task.completedAt);
		const tm = getTaskToastManager();
		if (tm) tm.showCompletionToast({ id: task.id, description: task.description, duration: dur });
		if (!this.completedTaskSummaries.has(task.parentSessionId))
			this.completedTaskSummaries.set(task.parentSessionId, []);
		this.completedTaskSummaries.get(task.parentSessionId)!.push({
			id: task.id,
			description: task.description,
			status: task.status,
			error: task.error,
			attempts: task.attempts?.map((a) => ({ ...a })),
		});
		const ps = this.pendingByParent.get(task.parentSessionId);
		let ac = false;
		let rc = 0;
		if (ps) {
			ps.delete(task.id);
			rc = ps.size;
			ac = rc === 0;
			if (ac) this.pendingByParent.delete(task.parentSessionId);
		} else {
			rc = Array.from(this.tasks.values()).filter(
				(t) =>
					t.parentSessionId === task.parentSessionId &&
					t.id !== task.id &&
					(t.status === "running" || t.status === "pending"),
			).length;
			ac = rc === 0;
		}
		const ct = ac
			? (this.completedTaskSummaries.get(task.parentSessionId) ?? [
					{
						id: task.id,
						description: task.description,
						status: task.status,
						error: task.error,
						attempts: task.attempts?.map((a) => ({ ...a })),
					},
				])
			: [];
		if (ac) this.completedTaskSummaries.delete(task.parentSessionId);
		const st =
			task.status === "completed"
				? "COMPLETED"
				: task.status === "interrupt"
					? "INTERRUPTED"
					: task.status === "error"
						? "ERROR"
						: "CANCELLED";
		const n = buildBackgroundTaskNotificationText({
			task,
			duration: dur,
			statusText: st,
			allComplete: ac,
			remainingCount: rc,
			completedTasks: ct,
		});
		if (this.enableParentSessionNotifications) {
			const ppc = await this.resolveParentWakePromptContext(task);
			const isf = task.status === "error" || task.status === "cancelled" || task.status === "interrupt";
			const sr = ac || isf;
			this.queuePendingParentWake(task.parentSessionId, n, ppc, sr, PENDING_PARENT_WAKE_DEBOUNCE_MS);
		}
		if (task.status !== "running" && task.status !== "pending") this.scheduleTaskRemoval(task.id);
	}

	private async resolveParentWakePromptContext(task: BackgroundTask): Promise<ParentWakePromptContext> {
		let agent: string | undefined = task.parentAgent;
		let model: { providerID: string; modelID: string } | undefined;
		let tools: Record<string, boolean> | undefined = task.parentTools;
		let variant: string | undefined;
		try {
			const mr = await messagesInDirectory(this.client, { path: { id: task.parentSessionId } }, this.directory);
			const msgs = normalizeSDKResponse(
				mr,
				[] as Array<{
					info?: {
						agent?: string;
						model?: { providerID: string; modelID: string; variant?: string };
						tools?: Record<string, boolean | "allow" | "deny" | "ask">;
					};
				}>,
			);
			const pc = resolvePromptContextFromSessionMessages(msgs, task.parentSessionId);
			const nt = isRecord(pc?.tools) ? normalizePromptTools(pc.tools) : undefined;
			if (pc?.agent || pc?.model || nt) {
				agent = pc?.agent ?? task.parentAgent;
				model =
					pc?.model?.providerID && pc.model.modelID
						? { providerID: pc.model.providerID, modelID: pc.model.modelID }
						: undefined;
				variant = pc?.model?.variant;
				tools = nt ?? tools;
			}
		} catch (error) {
			if (isAbortedSessionError(error)) {
				log("[background-agent] Parent session aborted while loading messages; using messageDir fallback:", {
					taskId: task.id,
					parentSessionID: task.parentSessionId,
				});
			}
			const md = join(MESSAGE_STORAGE, task.parentSessionId);
			const cm = md ? findNearestMessageExcludingCompaction(md, task.parentSessionId) : null;
			agent = cm?.agent ?? task.parentAgent;
			model =
				cm?.model?.providerID && cm?.model?.modelID
					? { providerID: cm.model.providerID, modelID: cm.model.modelID }
					: undefined;
			variant = cm?.model?.variant;
			tools = normalizePromptTools(cm?.tools) ?? tools;
		}
		const rt = resolveInheritedPromptTools(task.parentSessionId, tools);
		return {
			...(agent !== undefined ? { agent } : {}),
			...(model !== undefined ? { model } : {}),
			...(variant !== undefined ? { variant } : {}),
			...(rt ? { tools: rt } : {}),
		};
	}

	private async isSessionActive(sid: string): Promise<boolean> {
		const r = await resolveDispatchClient(this.client, sid);
		return isOpenCodeSessionActive(r.client as Parameters<typeof isOpenCodeSessionActive>[0], sid);
	}

	// === Notification helpers ===
	public markForNotification(task: BackgroundTask) {
		const q = this.notifications.get(task.parentSessionId) ?? [];
		q.push(task);
		this.notifications.set(task.parentSessionId, q);
	}
	getPendingNotifications(sid: string) {
		return this.notifications.get(sid) ?? [];
	}
	clearNotifications(sid: string) {
		this.notifications.delete(sid);
	}
	private clearNotificationsForTask(tid: string) {
		for (const [sid, tasks] of this.notifications.entries()) {
			const f = tasks.filter((t) => t.id !== tid);
			if (f.length === 0) this.notifications.delete(sid);
			else this.notifications.set(sid, f);
		}
	}
	private cleanupPendingByParent(task: BackgroundTask) {
		if (!task.parentSessionId) return;
		const p = this.pendingByParent.get(task.parentSessionId);
		if (p) {
			p.delete(task.id);
			if (p.size === 0) this.pendingByParent.delete(task.parentSessionId);
		}
	}
	private clearTaskHistoryWhenParentTasksGone(psid: string | undefined) {
		if (!psid || this.getTasksByParentSession(psid).length > 0) return;
		this.taskHistory.clearSession(psid);
		this.completedTaskSummaries.delete(psid);
	}
	private scheduleTaskRemoval(tid: string, rc = 0) {
		const et = this.completionTimers.get(tid);
		if (et) {
			clearTimeout(et);
			this.completionTimers.delete(tid);
		}
		const timer = setTimeout(() => {
			this.completionTimers.delete(tid);
			const task = this.tasks.get(tid);
			if (!task) return;
			if (task.parentSessionId) {
				const sibs = this.getTasksByParentSession(task.parentSessionId).filter(
					(s) => s.id !== tid && (s.status === "running" || s.status === "pending"),
				);
				const cts = task.completedAt?.getTime();
				const rtt = cts !== undefined && Date.now() - cts >= TASK_TTL_MS;
				if (sibs.length > 0 && rc < MAX_TASK_REMOVAL_RESCHEDULES && !rtt) {
					this.scheduleTaskRemoval(tid, rc + 1);
					return;
				}
			}
			this.clearNotificationsForTask(tid);
			if (task.sessionId) {
				const at: BackgroundTask = {
					id: task.id,
					parentSessionId: task.parentSessionId,
					parentMessageId: task.parentMessageId,
					description: task.description,
					prompt: "[redacted]",
					agent: task.agent,
					sessionId: task.sessionId,
					status: task.status,
					queuedAt: task.queuedAt,
					startedAt: task.startedAt,
					completedAt: task.completedAt,
					model: task.model,
					error: task.error,
					category: task.category,
				};
				this.completedTaskArchive.set(task.id, at);
				if (this.completedTaskArchive.size > 100) {
					const o = this.completedTaskArchive.keys().next().value;
					if (typeof o === "string") this.completedTaskArchive.delete(o);
				}
			}
			archiveBackgroundTask(task);
			this.tasks.delete(task.id);
			if (task.parentSessionId) {
				const ids = this.tasksByParentSession.get(task.parentSessionId);
				if (ids) {
					ids.delete(task.id);
					if (ids.size === 0) this.tasksByParentSession.delete(task.parentSessionId);
				}
			}
			this.clearTaskHistoryWhenParentTasksGone(task.parentSessionId);
			if (task.sessionId) {
				subagentSessions.delete(task.sessionId);
				clearDelegatedChildSessionBootstrap(task.sessionId);
				SessionCategoryRegistry.remove(task.sessionId);
			}
			log("[background-agent] Removed completed task from memory:", tid);
		}, this.config?.taskCleanupDelayMs ?? TASK_CLEANUP_DELAY_MS);
		this.completionTimers.set(tid, timer);
	}
	queuePendingNotification(sid: string | undefined, n: string) {
		if (!sid) return;
		const e = this.pendingNotifications.get(sid) ?? [];
		e.push(n);
		this.pendingNotifications.set(sid, e);
	}
	injectPendingNotificationsIntoChatMessage(
		_o: { parts: Array<{ type: string; text?: string; [key: string]: unknown }> },
		sid: string,
	) {
		const pn = this.pendingNotifications.get(sid);
		if (!pn || pn.length === 0) return;
		this.pendingNotifications.delete(sid);
		this.queuePendingParentWake(sid, pn.join("\n\n"), {}, false, PENDING_PARENT_WAKE_DEBOUNCE_MS);
	}
	private enqueueNotificationForParent(psid: string | undefined, op: () => Promise<void>): Promise<void> {
		if (!psid) return op();
		const prev = this.notificationQueueByParent.get(psid) ?? Promise.resolve();
		const cl = () => {
			if (this.notificationQueueByParent.get(psid) === cur) this.notificationQueueByParent.delete(psid);
		};
		const cur = prev
			.catch((error: unknown) => {
				log("[background-agent] Continuing notification queue after previous failure:", {
					parentSessionID: psid,
					error,
				});
			})
			.then(op);
		this.notificationQueueByParent.set(psid, cur);
		void cur.then(cl, cl);
		return cur;
	}

	// === Validation helpers ===
	private async validateSessionHasOutput(sid: string): Promise<boolean> {
		if (this.observedOutputSessions.has(sid)) return true;
		try {
			type SM = {
				info?: { role?: string };
				parts?: Array<{ type?: string; text?: string; content?: string | unknown[] }>;
			};
			const r = await messagesInDirectory(this.client, { path: { id: sid } }, this.directory);
			const msgs = normalizeSDKResponse(r, [] as SM[], { preferResponseOnMissingData: true });
			if (!msgs.some((m: SM) => m.info?.role === "assistant" || m.info?.role === "tool")) {
				log("[background-agent] No assistant/tool messages found in session:", sid);
				return false;
			}
			const hc = msgs.some((m: SM) => {
				if (m.info?.role !== "assistant" && m.info?.role !== "tool") return false;
				return (m.parts ?? []).some(
					(p) =>
						(p.type === "text" && p.text && p.text.trim().length > 0) ||
						(p.type === "reasoning" && p.text && p.text.trim().length > 0) ||
						p.type === "tool" ||
						(p.type === "tool_result" &&
							p.content &&
							(typeof p.content === "string" ? p.content.trim().length > 0 : p.content.length > 0)),
				);
			});
			if (!hc) {
				log("[background-agent] Messages exist but no content found in session:", sid);
				return false;
			}
			this.observedOutputSessions.add(sid);
			return true;
		} catch (error) {
			log("[background-agent] Error validating session output:", error);
			return true;
		}
	}
	private async checkSessionTodos(sid: string): Promise<boolean> {
		if (this.observedIncompleteTodosBySession.get(sid) === false) return false;
		try {
			const r = await this.client.session.todo({ path: { id: sid } });
			const todos = normalizeSDKResponse(r, [] as Array<{ status: string }>, { preferResponseOnMissingData: true });
			if (!todos || todos.length === 0) {
				this.observedIncompleteTodosBySession.set(sid, false);
				return false;
			}
			const hi = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length > 0;
			this.observedIncompleteTodosBySession.set(sid, hi);
			return hi;
		} catch (error) {
			log("[background-agent] Failed to check session todos:", { sessionID: sid, error });
			return false;
		}
	}
	private async failCrashedTask(task: BackgroundTask, em: string) {
		if (task.currentAttemptID) finalizeAttempt(task, task.currentAttemptID, "error", em);
		else {
			task.status = "error";
			task.error = em;
			task.completedAt = new Date();
		}
		if (task.rootSessionId) {
			const c = this.rootDescendantCounts.get(task.rootSessionId) ?? 0;
			if (c <= 1) this.rootDescendantCounts.delete(task.rootSessionId);
			else this.rootDescendantCounts.set(task.rootSessionId, c - 1);
		}
		this.taskHistory.record(task.parentSessionId, {
			id: task.id,
			sessionID: task.sessionId,
			agent: task.agent,
			description: task.description,
			status: "error",
			category: task.category,
			startedAt: task.startedAt,
			completedAt: task.completedAt,
		});
		if (task.concurrencyKey) {
			this.concurrencyManager.release(task.concurrencyKey);
			task.concurrencyKey = undefined;
		}
		const ct = this.completionTimers.get(task.id);
		if (ct) {
			clearTimeout(ct);
			this.completionTimers.delete(task.id);
		}
		const it = this.idleDeferralTimers.get(task.id);
		if (it) {
			clearTimeout(it);
			this.idleDeferralTimers.delete(task.id);
		}
		this.cleanupPendingByParent(task);
		this.clearNotificationsForTask(task.id);
		removeTaskToastTracking(task.id);
		this.scheduleTaskRemoval(task.id);
		if (task.sessionId) {
			clearDelegatedChildSessionBootstrap(task.sessionId);
			SessionCategoryRegistry.remove(task.sessionId);
		}
		if (task.parentSessionId) this.updateBackgroundTaskMarker(task.parentSessionId);
		this.markForNotification(task);
		this.enqueueNotificationForParent(task.parentSessionId, () => this.notifyParentSession(task)).catch((err) => {
			log("[background-agent] Error in notifyParentSession for crashed task:", { taskId: task.id, error: err });
		});
	}
	private async verifySessionExists(sid: string): Promise<boolean> {
		return rawVerifySessionExists(this.client, sid, this.directory);
	}

	// === Parent wake observation ===
	private clearDispatchedParentWake(sid: string) {
		const pr = `${sid}:`;
		for (const k of this.parentWakeTextDeltaBuffers.keys())
			if (k.startsWith(pr)) this.parentWakeTextDeltaBuffers.delete(k);
		this.parentWakeNotifier.clearDispatchedParentWake(sid);
	}
	private async requeueDispatchedParentWake(sid: string, reason: string) {
		return this.parentWakeNotifier.requeueDispatchedParentWake(sid, reason);
	}
	private shouldHoldDispatchedParentWakeForTextDelta(
		et: string,
		pi: ReturnType<typeof resolveMessagePartInfo>,
		sid: string,
		wake: PendingParentWake | undefined,
	): boolean {
		if (
			et !== "message.part.delta" ||
			!wake ||
			!pi ||
			typeof pi.delta !== "string" ||
			(pi.field !== "text" && pi.type !== "text")
		)
			return false;
		const key = `${sid}:${pi?.id ?? "unknown"}`;
		const cand = `${this.parentWakeTextDeltaBuffers.get(key) ?? ""}${pi.delta}`;
		const exp = wake.notifications.join("\n\n");
		const ev = exp.replace(/<\/?system-reminder>/g, "");
		const sh = exp.startsWith(cand) || ev.startsWith(cand) || hasInternalInitiatorMarker(cand);
		if (sh) this.parentWakeTextDeltaBuffers.set(key, cand);
		else this.parentWakeTextDeltaBuffers.delete(key);
		return sh;
	}
	private queuePendingParentWake(sid: string, n: string, pc: ParentWakePromptContext, sr: boolean, dm?: number) {
		this.parentWakeNotifier.queuePendingParentWake(sid, n, pc, sr, dm);
	}
	private async flushPendingParentWake(sid: string) {
		await this.parentWakeNotifier.flushPendingParentWake(sid);
	}
	private updateBackgroundTaskMarker(psid: string) {
		const ts = this.getTasksByParentSession(psid);
		const at = ts.filter((t) => t.status === "running" || t.status === "pending");
		if (at.length > 0)
			setContinuationMarkerSource(
				this.directory,
				psid,
				"background-task",
				"active",
				`${at.length} background task(s) active`,
			);
		else setContinuationMarkerSource(this.directory, psid, "background-task", "idle");
	}
}

// Top-level helpers
function formatAttemptModelSummary(
	a: Pick<BackgroundTaskAttempt, "providerId" | "modelId"> | undefined,
): string | undefined {
	if (!a?.providerId || !a.modelId) return undefined;
	return `${a.providerId}/${a.modelId}`;
}
function getPreviousAttempt(task: BackgroundTask, aid: string | undefined): BackgroundTaskAttempt | undefined {
	if (!aid || !task.attempts || task.attempts.length === 0) return undefined;
	const i = task.attempts.findIndex((a) => a.attemptId === aid);
	return i <= 0 ? undefined : task.attempts[i - 1];
}
