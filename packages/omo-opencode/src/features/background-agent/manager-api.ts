import type { PluginInput } from "@opencode-ai/plugin";
import type { BackgroundTaskConfig } from "../../config/schema";
import type { ModelFallbackControllerAccessor } from "../../hooks/model-fallback";
import type { log as defaultLog } from "../../shared";
import type { BackgroundTaskNotificationTask } from "./background-task-notification-template";
import type { ConcurrencyManager } from "./concurrency";
import type { QueueItem } from "./constants";
import type { CircuitBreakerSettings } from "./loop-detector";
import type { PendingParentWake } from "./parent-wake-dedupe";
import type { ParentWakeNotifier, ParentWakePromptContext } from "./parent-wake-notifier";
import type { resolveMessagePartInfo } from "./session-stream-activity";
import type { SubagentSpawnContext } from "./subagent-spawn-limits";
import type { TaskHistory } from "./task-history";
import type { BackgroundTask, BackgroundTaskAttempt, BackgroundTaskSnapshot, LaunchInput, ResumeInput } from "./types";

export type OpencodeClient = PluginInput["client"];

export interface BgManagerAPI {
	client: OpencodeClient;
	directory: string;
	tasks: Map<string, BackgroundTask>;
	tasksByParentSession: Map<string, Set<string>>;
	notifications: Map<string, BackgroundTask[]>;
	pendingNotifications: Map<string, string[]>;
	pendingByParent: Map<string, Set<string>>;
	completedTaskArchive: Map<string, BackgroundTask>;
	completedTaskSummaries: Map<string, BackgroundTaskNotificationTask[]>;
	completionTimers: Map<string, ReturnType<typeof setTimeout>>;
	idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>;
	notificationQueueByParent: Map<string, Promise<void>>;
	rootDescendantCounts: Map<string, number>;
	preStartDescendantReservations: Set<string>;
	queuesByKey: Map<string, QueueItem[]>;
	processingKeys: Set<string>;
	parentWakeTextDeltaBuffers: Map<string, string>;
	observedOutputSessions: Set<string>;
	observedIncompleteTodosBySession: Map<string, boolean>;
	pollingInterval?: ReturnType<typeof setInterval>;
	pollingInFlight: boolean;
	concurrencyManager: ConcurrencyManager;
	shutdownTriggered: boolean;
	config?: BackgroundTaskConfig;
	tmuxEnabled: boolean;
	onSubagentSessionCreated?: (event: { sessionID: string; parentID: string; title: string }) => Promise<void>;
	onSubagentSessionDeleted?: (event: { sessionID: string }) => Promise<void>;
	onShutdown?: () => void | Promise<void>;
	enableParentSessionNotifications: boolean;
	modelFallbackControllerAccessor?: ModelFallbackControllerAccessor;
	logger: typeof defaultLog;
	loggedSessionStatusUnavailable: boolean;
	taskHistory: TaskHistory;
	cachedCircuitBreakerSettings?: CircuitBreakerSettings;
	parentWakeNotifier: ParentWakeNotifier;

	// Methods
	assertCanSpawn(parentSessionID: string): Promise<SubagentSpawnContext>;
	reserveSubagentSpawn(parentSessionID: string): Promise<{
		spawnContext: SubagentSpawnContext;
		descendantCount: number;
		commit: () => number;
		rollback: () => void;
	}>;
	processKey(key: string): Promise<void>;
	startTask(item: QueueItem): Promise<void>;
	startPolling(): void;
	stopPolling(): void;
	markForNotification(task: BackgroundTask): void;
	getPendingNotifications(sessionID: string): BackgroundTask[];
	clearNotifications(sessionID: string): void;
	clearNotificationsForTask(taskId: string): void;
	cleanupPendingByParent(task: BackgroundTask): void;
	clearTaskHistoryWhenParentTasksGone(parentSessionID: string | undefined): void;
	scheduleTaskRemoval(taskId: string, rescheduleCount?: number): void;
	enqueueNotificationForParent(parentSessionID: string | undefined, operation: () => Promise<void>): Promise<void>;
	notifyParentSession(task: BackgroundTask): Promise<void>;
	resolveParentWakePromptContext(task: BackgroundTask): Promise<ParentWakePromptContext>;
	isSessionActive(sessionID: string): Promise<boolean>;
	updateBackgroundTaskMarker(parentSessionID: string): void;
	queuePendingParentWake(
		sessionID: string,
		notification: string,
		promptContext: ParentWakePromptContext,
		shouldReply: boolean,
		delayMs?: number,
	): void;
	flushPendingParentWake(sessionID: string): Promise<void>;
	queuePendingNotification(sessionID: string | undefined, notification: string): void;
	injectPendingNotificationsIntoChatMessage(
		output: { parts: Array<{ type: string; text?: string; [key: string]: unknown }> },
		sessionID: string,
	): void;
	cancelTask(
		taskId: string,
		options?: { source?: string; reason?: string; abortSession?: boolean; skipNotification?: boolean },
	): Promise<boolean>;
	cancelPendingTask(taskId: string): boolean;
	shutdown(): Promise<void>;
	abortSessionWithLogging(sessionID: string, reason: string): Promise<boolean>;
	tryFallbackRetry(
		task: BackgroundTask,
		errorInfo: { name?: string; message?: string; statusCode?: number },
		source: string,
	): Promise<boolean>;
	interruptTaskFromAsyncPromptFailure(task: BackgroundTask, errorMessage: string, reason: string): Promise<void>;
	getTask(id: string): BackgroundTask | undefined;
	getTasksSnapshot(): BackgroundTaskSnapshot[];
	getTasksByParentSession(sessionID: string): BackgroundTask[];
	hasActiveChildTasks(sessionID: string): boolean;
	hasPendingParentWake(sessionID: string): boolean;
	getAllDescendantTasks(sessionID: string): BackgroundTask[];
	findBySession(sessionID: string): BackgroundTask | undefined;
	resolveTaskAttemptBySession(
		sessionID: string,
	): { task: BackgroundTask; attemptID?: string; isCurrent: boolean } | undefined;
	getRunningTasks(): BackgroundTask[];
	getNonRunningTasks(): BackgroundTask[];
	hasRunningTasks(): boolean;
	validateSessionHasOutput(sessionID: string): Promise<boolean>;
	checkSessionTodos(sessionID: string): Promise<boolean>;
	failCrashedTask(task: BackgroundTask, errorMessage: string): Promise<void>;
	verifySessionExists(sessionID: string): Promise<boolean>;
	markSessionOutputObserved(sessionID: string): void;
	clearSessionOutputObserved(sessionID: string): void;
	clearSessionTodoObservation(sessionID: string): void;
	clearDispatchedParentWake(sessionID: string): void;
	requeueDispatchedParentWake(sessionID: string, reason: string): Promise<boolean>;
	shouldHoldDispatchedParentWakeForTextDelta(
		eventType: string,
		partInfo: ReturnType<typeof resolveMessagePartInfo>,
		sessionID: string,
		wake: PendingParentWake | undefined,
	): boolean;
	tryCompleteTask(task: BackgroundTask, source: string): Promise<boolean>;
	handleEvent(event: { type: string; properties?: Record<string, unknown> }): void;
	handleSessionErrorEvent(args: {
		task: BackgroundTask;
		errorInfo: { name?: string; message?: string; statusCode?: number };
		errorName: string | undefined;
		errorMessage: string | undefined;
	}): Promise<void>;
}
