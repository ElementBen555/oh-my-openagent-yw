import { setContinuationMarkerSource } from "../../features/run-continuation-state";
import { log } from "../../shared";
import { clearDelegatedChildSessionBootstrap } from "../../shared/delegated-child-session-bootstrap";
import { SessionCategoryRegistry } from "../../shared/session-category-registry";
import { subagentSessions } from "../claude-code-session-state";
import { abortWithTimeout } from "./abort-with-timeout";
import { finalizeAttempt } from "./attempt-lifecycle";
import type { BgManagerAPI } from "./manager-api";
import { unregisterManagerForCleanup } from "./process-cleanup";
import { removeTaskToastTracking } from "./remove-task-toast-tracking";
import { archiveBackgroundTask, forgetBackgroundTask } from "./task-registry";
import type { BackgroundTask } from "./types";

const TERMINAL_STATUSES = new Set<BackgroundTask["status"]>(["completed", "error", "cancelled", "interrupt"]);

export async function cancelTask(
	ctx: BgManagerAPI,
	taskId: string,
	options?: { source?: string; reason?: string; abortSession?: boolean; skipNotification?: boolean },
): Promise<boolean> {
	const task = ctx.tasks.get(taskId);
	if (!task || (task.status !== "running" && task.status !== "pending")) return false;
	const source = options?.source ?? "cancel";
	const abortSession = options?.abortSession !== false;
	const reason = options?.reason;
	if (task.status === "pending") {
		const rawKey = task.model ? `${task.model.providerID}/${task.model.modelID}` : task.agent;
		const key = ctx.concurrencyManager.getConcurrencyKey(rawKey);
		const queue = ctx.queuesByKey.get(key);
		if (queue) {
			const i = queue.findIndex((item) => item.task.id === taskId);
			if (i !== -1) {
				queue.splice(i, 1);
				if (queue.length === 0) ctx.queuesByKey.delete(key);
			}
		}
		rollbackPSDR(ctx, task);
		ctx.concurrencyManager.cancelWaiter(rawKey, taskId);
		log("[background-agent] Cancelled pending task:", { taskId, key });
	}
	const wasRunning = task.status === "running";
	if (wasRunning && abortSession && task.sessionId) {
		if (!(await ctx.abortSessionWithLogging(task.sessionId, `task cancellation (${source})`))) return false;
		clearDelegatedChildSessionBootstrap(task.sessionId);
		SessionCategoryRegistry.remove(task.sessionId);
	}
	if (task.currentAttemptID) finalizeAttempt(task, task.currentAttemptID, "cancelled", reason);
	else {
		task.status = "cancelled";
		task.completedAt = new Date();
		if (reason) task.error = reason;
	}
	if (wasRunning && task.rootSessionId) unregisterRD(ctx, task.rootSessionId);
	ctx.taskHistory.record(task.parentSessionId, {
		id: task.id,
		sessionID: task.sessionId,
		agent: task.agent,
		description: task.description,
		status: "cancelled",
		category: task.category,
		startedAt: task.startedAt,
		completedAt: task.completedAt,
	});
	if (task.concurrencyKey) {
		ctx.concurrencyManager.release(task.concurrencyKey);
		task.concurrencyKey = undefined;
	}
	const et = ctx.completionTimers.get(task.id);
	if (et) {
		clearTimeout(et);
		ctx.completionTimers.delete(task.id);
	}
	const it = ctx.idleDeferralTimers.get(task.id);
	if (it) {
		clearTimeout(it);
		ctx.idleDeferralTimers.delete(task.id);
	}
	removeTaskToastTracking(task.id);
	if (task.parentSessionId) ctx.updateBackgroundTaskMarker(task.parentSessionId);
	if (options?.skipNotification) {
		ctx.cleanupPendingByParent(task);
		ctx.scheduleTaskRemoval(task.id);
		log(`[background-agent] Task cancelled via ${source} (notification skipped):`, task.id);
		return true;
	}
	ctx.markForNotification(task);
	try {
		await ctx.enqueueNotificationForParent(task.parentSessionId, () => ctx.notifyParentSession(task));
		log(`[background-agent] Task cancelled via ${source}:`, task.id);
	} catch (err) {
		log("[background-agent] Error in notifyParentSession for cancelled task:", { taskId: task.id, error: err });
	}
	return true;
}

export function cancelPendingTask(ctx: BgManagerAPI, taskId: string): boolean {
	const task = ctx.tasks.get(taskId);
	if (!task || task.status !== "pending") return false;
	void ctx.cancelTask(taskId, { source: "cancelPendingTask", abortSession: false });
	return true;
}

export async function shutdownManager(ctx: BgManagerAPI): Promise<void> {
	if (ctx.shutdownTriggered) return;
	ctx.shutdownTriggered = true;
	log("[background-agent] Shutting down BackgroundManager");
	if (ctx.pollingInterval) {
		clearInterval(ctx.pollingInterval);
		ctx.pollingInterval = undefined;
	}
	const tids = new Set<string>();
	const ar: Array<{ sessionID: string; promise: Promise<unknown> }> = [];
	for (const task of ctx.tasks.values()) {
		if (task.sessionId) tids.add(task.sessionId);
		if (task.status === "running" && task.sessionId)
			ar.push({ sessionID: task.sessionId, promise: abortWithTimeout(ctx.client, task.sessionId) });
	}
	if (ar.length > 0) {
		const results = await Promise.allSettled(ar.map((r) => r.promise));
		for (const [i, r] of results.entries()) {
			if (r.status === "fulfilled") continue;
			log("[background-agent] Error aborting session during shutdown:", {
				error: r.reason,
				sessionID: ar[i]?.sessionID,
			});
		}
	}
	if (ctx.onShutdown) {
		try {
			await ctx.onShutdown();
		} catch (error) {
			log("[background-agent] Error in onShutdown callback:", error);
		}
	}
	for (const task of ctx.tasks.values()) {
		if (TERMINAL_STATUSES.has(task.status)) archiveBackgroundTask(task);
		else forgetBackgroundTask(task.id);
		if (task.concurrencyKey) {
			ctx.concurrencyManager.release(task.concurrencyKey);
			task.concurrencyKey = undefined;
		}
	}
	for (const timer of ctx.completionTimers.values()) clearTimeout(timer);
	ctx.completionTimers.clear();
	for (const timer of ctx.idleDeferralTimers.values()) clearTimeout(timer);
	ctx.idleDeferralTimers.clear();
	ctx.parentWakeNotifier.shutdown();
	for (const sid of tids) {
		subagentSessions.delete(sid);
		clearDelegatedChildSessionBootstrap(sid);
		SessionCategoryRegistry.remove(sid);
	}
	ctx.concurrencyManager.clear();
	ctx.tasks.clear();
	ctx.tasksByParentSession.clear();
	ctx.notifications.clear();
	ctx.pendingNotifications.clear();
	ctx.pendingByParent.clear();
	ctx.notificationQueueByParent.clear();
	ctx.rootDescendantCounts.clear();
	ctx.queuesByKey.clear();
	ctx.processingKeys.clear();
	ctx.taskHistory.clearAll();
	ctx.completedTaskSummaries.clear();
	unregisterManagerForCleanup(ctx as unknown as Parameters<typeof unregisterManagerForCleanup>[0]);
	log("[background-agent] Shutdown complete");
}

function rollbackPSDR(ctx: BgManagerAPI, t: BackgroundTask): void {
	if (!ctx.preStartDescendantReservations.delete(t.id)) return;
	if (!t.rootSessionId) return;
	unregisterRD(ctx, t.rootSessionId);
}
function unregisterRD(ctx: BgManagerAPI, rid: string): void {
	const c = ctx.rootDescendantCounts.get(rid) ?? 0;
	if (c <= 1) ctx.rootDescendantCounts.delete(rid);
	else ctx.rootDescendantCounts.set(rid, c - 1);
}
