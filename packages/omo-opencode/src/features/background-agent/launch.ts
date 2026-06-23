// Launch lifecycle: launch, processKey, startTask, resume, trackTask, subagent spawn helpers

import { dispatchInternalPrompt, type PromptAsyncGateResult } from "../../hooks/shared/prompt-async-gate";
import {
	createInternalAgentTextPart,
	getAgentToolRestrictions,
	isAmbiguousPostDispatchPromptFailure,
	log,
	promptWithRetryInDirectory,
} from "../../shared";
import {
	clearDelegatedChildSessionBootstrap,
	registerDelegatedChildSessionBootstrap,
} from "../../shared/delegated-child-session-bootstrap";
import { applySessionPromptParams } from "../../shared/session-prompt-params-helpers";
import { setSessionTools } from "../../shared/session-tools-store";
import { isInsideTmux } from "../../shared/tmux";
import { clearSessionAgent, setSessionAgent, subagentSessions, updateSessionAgent } from "../claude-code-session-state";
import { getTaskToastManager } from "../task-toast-manager";
import { bindAttemptSession, ensureCurrentAttempt, finalizeAttempt, startAttempt } from "./attempt-lifecycle";
import type { QueueItem } from "./constants";
import { extractErrorMessage, extractErrorName, extractErrorStatusCode } from "./error-classifier";
import type { BgManagerAPI } from "./manager-api";
import { removeTaskToastTracking } from "./remove-task-toast-tracking";
import { buildFallbackBody, FALLBACK_AGENT, isAgentNotFoundError } from "./spawner";
import {
	createSubagentDepthLimitError,
	getMaxSubagentDepth,
	resolveSubagentSpawnContext,
	type SubagentSpawnContext,
} from "./subagent-spawn-limits";
import { archiveBackgroundTask, rememberBackgroundTask } from "./task-registry";
import type { BackgroundTask, BackgroundTaskAttempt, LaunchInput, ResumeInput } from "./types";

const PENDING_PARENT_WAKE_DEBOUNCE_MS = 100;

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
function buildLocalSessionUrl(dir: string, sid: string): string {
	return `http://127.0.0.1:4096/${Buffer.from(dir).toString("base64url")}/session/${sid}`;
}
function rawKeyFromInput(i: LaunchInput): string {
	return i.model ? `${i.model.providerID}/${i.model.modelID}` : i.agent;
}
function rawKeyFromTask(t: Pick<BackgroundTask, "model" | "agent">): string {
	return t.model ? `${t.model.providerID}/${t.model.modelID}` : t.agent;
}

// --- Subagent spawn guards ---

export async function assertCanSpawn(ctx: BgManagerAPI, psid: string): Promise<SubagentSpawnContext> {
	const sc = await resolveSubagentSpawnContext(ctx.client, psid, ctx.directory);
	const md = getMaxSubagentDepth(ctx.config);
	if (sc.childDepth > md)
		throw createSubagentDepthLimitError({
			childDepth: sc.childDepth,
			maxDepth: md,
			parentSessionID: psid,
			rootSessionID: sc.rootSessionID,
		});
	return sc;
}

export async function reserveSubagentSpawn(
	ctx: BgManagerAPI,
	psid: string,
): Promise<{
	spawnContext: SubagentSpawnContext;
	descendantCount: number;
	commit: () => number;
	rollback: () => void;
}> {
	const sc = await assertCanSpawn(ctx, psid);
	const dc = registerRootDescendant(ctx, sc.rootSessionID);
	let settled = false;
	return {
		spawnContext: sc,
		descendantCount: dc,
		commit: () => {
			settled = true;
			return dc;
		},
		rollback: () => {
			if (!settled) {
				settled = true;
				unregisterRootDescendant(ctx, sc.rootSessionID);
			}
		},
	};
}
export function registerRootDescendant(ctx: BgManagerAPI, rid: string): number {
	const n = (ctx.rootDescendantCounts.get(rid) ?? 0) + 1;
	ctx.rootDescendantCounts.set(rid, n);
	return n;
}
export function unregisterRootDescendant(ctx: BgManagerAPI, rid: string): void {
	const c = ctx.rootDescendantCounts.get(rid) ?? 0;
	if (c <= 1) ctx.rootDescendantCounts.delete(rid);
	else ctx.rootDescendantCounts.set(rid, c - 1);
}
export function markPreStartDescendantReservation(ctx: BgManagerAPI, t: BackgroundTask): void {
	ctx.preStartDescendantReservations.add(t.id);
}
export function settlePreStartDescendantReservation(ctx: BgManagerAPI, t: BackgroundTask): void {
	ctx.preStartDescendantReservations.delete(t.id);
}
export function rollbackPreStartDescendantReservation(ctx: BgManagerAPI, t: BackgroundTask): void {
	if (!ctx.preStartDescendantReservations.delete(t.id)) return;
	if (!t.rootSessionId) return;
	unregisterRootDescendant(ctx, t.rootSessionId);
}

// --- Task store helpers ---
export function addTask(ctx: BgManagerAPI, t: BackgroundTask): void {
	ctx.completedTaskArchive.delete(t.id);
	ctx.tasks.set(t.id, t);
	rememberBackgroundTask(t);
	if (!t.parentSessionId) return;
	const ids = ctx.tasksByParentSession.get(t.parentSessionId) ?? new Set<string>();
	ids.add(t.id);
	ctx.tasksByParentSession.set(t.parentSessionId, ids);
}
function archiveCompletedTask(ctx: BgManagerAPI, t: BackgroundTask): void {
	if (!t.sessionId || t.status === "running" || t.status === "pending") return;
	const at: BackgroundTask = {
		id: t.id,
		parentSessionId: t.parentSessionId,
		parentMessageId: t.parentMessageId,
		description: t.description,
		prompt: "[redacted]",
		agent: t.agent,
		sessionId: t.sessionId,
		status: t.status,
		queuedAt: t.queuedAt,
		startedAt: t.startedAt,
		completedAt: t.completedAt,
		model: t.model,
		error: t.error,
		category: t.category,
	};
	ctx.completedTaskArchive.set(t.id, at);
	if (ctx.completedTaskArchive.size > 100) {
		const o = ctx.completedTaskArchive.keys().next().value;
		if (typeof o === "string") ctx.completedTaskArchive.delete(o);
	}
}
export function removeTask(ctx: BgManagerAPI, t: BackgroundTask): void {
	archiveCompletedTask(ctx, t);
	archiveBackgroundTask(t);
	ctx.tasks.delete(t.id);
	if (t.parentSessionId) {
		const ids = ctx.tasksByParentSession.get(t.parentSessionId);
		if (ids) {
			ids.delete(t.id);
			if (ids.size === 0) ctx.tasksByParentSession.delete(t.parentSessionId);
		}
	}
}
export function updateTaskParent(ctx: BgManagerAPI, t: BackgroundTask, psid: string): void {
	if (t.parentSessionId === psid) return;
	if (t.parentSessionId) {
		const ids = ctx.tasksByParentSession.get(t.parentSessionId);
		if (ids) {
			ids.delete(t.id);
			if (ids.size === 0) ctx.tasksByParentSession.delete(t.parentSessionId);
		}
	}
	t.parentSessionId = psid;
	const ids = ctx.tasksByParentSession.get(psid) ?? new Set<string>();
	ids.add(t.id);
	ctx.tasksByParentSession.set(psid, ids);
}
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
function captureResumeTaskSnapshot(t: BackgroundTask): ResumeTaskSnapshot {
	return {
		status: t.status,
		completedAt: t.completedAt,
		error: t.error,
		startedAt: t.startedAt,
		progress: t.progress,
		parentSessionId: t.parentSessionId,
		parentMessageId: t.parentMessageId,
		parentModel: t.parentModel,
		parentAgent: t.parentAgent,
		parentTools: t.parentTools,
		concurrencyKey: t.concurrencyKey,
		concurrencyGroup: t.concurrencyGroup,
	};
}
function restoreTaskAfterSkippedResume(
	ctx: BgManagerAPI,
	t: BackgroundTask,
	s: ResumeTaskSnapshot,
	ss: Exclude<PromptAsyncGateResult["status"], "dispatched" | "queued" | "failed">,
): void {
	log("[background-agent] Restoring task after skipped resume prompt:", {
		taskId: t.id,
		sessionID: t.sessionId,
		skippedStatus: ss,
	});
	ctx.cleanupPendingByParent(t);
	if (t.concurrencyKey) ctx.concurrencyManager.release(t.concurrencyKey);
	t.status = s.status;
	t.completedAt = s.completedAt;
	t.error = s.error;
	t.startedAt = s.startedAt;
	t.progress = s.progress;
	t.parentMessageId = s.parentMessageId;
	t.parentModel = s.parentModel;
	t.parentAgent = s.parentAgent;
	t.parentTools = s.parentTools;
	t.concurrencyKey = s.concurrencyKey;
	t.concurrencyGroup = s.concurrencyGroup;
	updateTaskParent(ctx, t, s.parentSessionId);
	removeTaskToastTracking(t.id);
	if (t.status !== "running" && t.status !== "pending") ctx.scheduleTaskRemoval(t.id);
	ctx.updateBackgroundTaskMarker(t.parentSessionId);
}

// --- launch ---
export async function launchTask(ctx: BgManagerAPI, input: LaunchInput): Promise<BackgroundTask> {
	log("[background-agent] launch() called with:", {
		agent: input.agent,
		model: input.model,
		description: input.description,
		parentSessionID: input.parentSessionId,
	});
	if (!input.agent || input.agent.trim() === "") throw new Error("Agent parameter is required");
	input = {
		...input,
		agent: input.agent
			.trim()
			.replace(/^[\\/"']+|[\\/"']+$/g, "")
			.trim(),
	};
	if (!input.agent) throw new Error("Agent parameter is required after sanitization");
	const sr = await ctx.reserveSubagentSpawn(input.parentSessionId);
	try {
		log("[background-agent] spawn guard passed", {
			parentSessionID: input.parentSessionId,
			rootSessionID: sr.spawnContext.rootSessionID,
			childDepth: sr.spawnContext.childDepth,
			descendantCount: sr.descendantCount,
		});
		const task: BackgroundTask = {
			id: `bg_${crypto.randomUUID().slice(0, 8)}`,
			status: "pending",
			queuedAt: new Date(),
			rootSessionId: sr.spawnContext.rootSessionID,
			description: input.description,
			prompt: input.prompt,
			agent: input.agent,
			spawnDepth: sr.spawnContext.childDepth,
			parentSessionId: input.parentSessionId,
			parentMessageId: input.parentMessageId,
			teamRunId: input.teamRunId,
			parentModel: input.parentModel,
			parentAgent: input.parentAgent,
			parentTools: input.parentTools,
			model: input.model,
			fallbackChain: input.fallbackChain,
			skillContent: input.skillContent,
			sessionPermission: input.sessionPermission,
			attemptCount: 0,
			category: input.category,
			onSessionCreated: input.onSessionCreated,
		};
		startAttempt(task, input.model);
		addTask(ctx, task);
		ctx.taskHistory.record(input.parentSessionId, {
			id: task.id,
			agent: input.agent,
			description: input.description,
			status: "pending",
			category: input.category,
		});
		if (input.parentSessionId) {
			const p = ctx.pendingByParent.get(input.parentSessionId) ?? new Set();
			p.add(task.id);
			ctx.pendingByParent.set(input.parentSessionId, p);
		}
		const rck = rawKeyFromInput(input);
		const key = ctx.concurrencyManager.getConcurrencyKey(rck);
		const q = ctx.queuesByKey.get(key) ?? [];
		q.push({ task, input, attemptID: task.currentAttemptID!, rawConcurrencyKey: rck });
		ctx.queuesByKey.set(key, q);
		log("[background-agent] Task queued:", { taskId: task.id, key, queueLength: q.length });
		const tm = getTaskToastManager();
		if (tm)
			tm.addTask({
				id: task.id,
				description: input.description,
				agent: input.agent,
				isBackground: true,
				status: "queued",
				skills: input.skills,
			});
		sr.commit();
		markPreStartDescendantReservation(ctx, task);
		ctx.updateBackgroundTaskMarker(input.parentSessionId);
		void ctx.processKey(key);
		return { ...task };
	} catch (error) {
		sr.rollback();
		throw error;
	}
}

// --- processKey ---
export async function processQueueKey(ctx: BgManagerAPI, key: string): Promise<void> {
	if (ctx.processingKeys.has(key)) return;
	ctx.processingKeys.add(key);
	try {
		const q = ctx.queuesByKey.get(key);
		while (q && q.length > 0) {
			const item = q.shift();
			if (!item) continue;
			try {
				await ctx.concurrencyManager.acquire(item.rawConcurrencyKey ?? key, item.task.id);
			} catch (error) {
				if (item.task.status === "cancelled" || item.task.status === "error" || item.task.status === "interrupt") {
					rollbackPreStartDescendantReservation(ctx, item.task);
					continue;
				}
				throw error;
			}
			if (item.task.status === "cancelled" || item.task.status === "error" || item.task.status === "interrupt") {
				rollbackPreStartDescendantReservation(ctx, item.task);
				ctx.concurrencyManager.release(key);
				continue;
			}
			try {
				await startQueuedTask(ctx, item);
			} catch (error) {
				log("[background-agent] Error starting task:", error);
				rollbackPreStartDescendantReservation(ctx, item.task);
				if (item.task.currentAttemptID)
					finalizeAttempt(
						item.task,
						item.task.currentAttemptID,
						"error",
						error instanceof Error ? error.message : String(error),
					);
				else {
					item.task.status = "error";
					item.task.error = error instanceof Error ? error.message : String(error);
					item.task.completedAt = new Date();
				}
				if (item.task.concurrencyKey) {
					ctx.concurrencyManager.release(item.task.concurrencyKey);
					item.task.concurrencyKey = undefined;
				} else ctx.concurrencyManager.release(key);
				removeTaskToastTracking(item.task.id);
				if (item.task.sessionId) {
					clearDelegatedChildSessionBootstrap(item.task.sessionId);
					await ctx.abortSessionWithLogging(item.task.sessionId, "startTask error cleanup");
				}
				ctx.updateBackgroundTaskMarker(item.task.parentSessionId);
				ctx.markForNotification(item.task);
				ctx.enqueueNotificationForParent(item.task.parentSessionId, () => ctx.notifyParentSession(item.task)).catch(
					(err) => {
						log("[background-agent] Failed to notify on startTask error:", err);
					},
				);
			}
		}
	} finally {
		ctx.processingKeys.delete(key);
	}
}

// --- startTask ---
export async function startQueuedTask(ctx: BgManagerAPI, item: QueueItem): Promise<void> {
	const { task, input } = item;
	const attemptID = item.attemptID ?? ensureCurrentAttempt(task, input.model).attemptId;
	log("[background-agent] Starting task:", { taskId: task.id, agent: input.agent, model: input.model });
	const concurrencyKey = ctx.concurrencyManager.getConcurrencyKey(rawKeyFromInput(input));
	const ps = await ctx.client.session
		.get({ path: { id: input.parentSessionId }, query: { directory: ctx.directory } })
		.catch((err: unknown) => {
			log(`[background-agent] Failed to get parent session: ${err}`);
			return null;
		});
	const pd = (ps as { data?: { directory?: string } } | null)?.data?.directory ?? ctx.directory;
	log(
		`[background-agent] Parent dir: ${(ps as { data?: { directory?: string } } | null)?.data?.directory}, using: ${pd}`,
	);
	const cr = await ctx.client.session.create({
		body: {
			parentID: input.parentSessionId,
			title: `${input.description} (@${input.agent} subagent)`,
			...(input.sessionPermission ? { permission: input.sessionPermission } : {}),
			...(input.model
				? {
						model: {
							id: input.model.modelID,
							providerID: input.model.providerID,
							...(input.model.variant ? { variant: input.model.variant } : {}),
						},
					}
				: {}),
		} as Record<string, unknown>,
		query: { directory: pd },
	});
	if (cr.error) throw new Error(`Failed to create background session: ${cr.error}`);
	if (!cr.data?.id) throw new Error("Failed to create background session: API returned no session ID");
	const sessionID = cr.data.id;
	if (task.status === "cancelled") {
		clearDelegatedChildSessionBootstrap(sessionID);
		await ctx.abortSessionWithLogging(sessionID, "cancelled pre-start cleanup");
		ctx.concurrencyManager.release(concurrencyKey);
		return;
	}
	await input.onSessionCreated?.(sessionID);
	settlePreStartDescendantReservation(ctx, task);
	subagentSessions.add(sessionID);
	setSessionAgent(sessionID, input.agent);
	if (ctx.tasks.get(task.id)?.status === "cancelled") {
		clearDelegatedChildSessionBootstrap(sessionID);
		clearSessionAgent(sessionID);
		await ctx.abortSessionWithLogging(sessionID, "cancelled during launch setup");
		subagentSessions.delete(sessionID);
		if (task.rootSessionId) unregisterRootDescendant(ctx, task.rootSessionId);
		ctx.concurrencyManager.release(concurrencyKey);
		return;
	}
	const ba = bindAttemptSession(task, attemptID, sessionID, input.model);
	if (!ba) {
		clearDelegatedChildSessionBootstrap(sessionID);
		clearSessionAgent(sessionID);
		await ctx.abortSessionWithLogging(sessionID, "stale attempt binding cleanup");
		subagentSessions.delete(sessionID);
		if (task.rootSessionId) unregisterRootDescendant(ctx, task.rootSessionId);
		ctx.concurrencyManager.release(concurrencyKey);
		return;
	}
	task.progress = { toolCalls: 0, lastUpdate: new Date() };
	task.concurrencyKey = concurrencyKey;
	task.concurrencyGroup = concurrencyKey;
	if (task.retryNotification) {
		const an = ba.attemptNumber;
		const rsu = buildLocalSessionUrl(pd, sessionID);
		const pa = getPreviousAttempt(task, ba.attemptId);
		const fsl =
			(pa?.sessionId ?? task.retryNotification.previousSessionID)
				? `\n- Failed session: \`${pa?.sessionId ?? task.retryNotification.previousSessionID}\``
				: "";
		const fm = formatAttemptModelSummary(pa) ?? task.retryNotification.failedModel;
		const fml = fm ? `\n- Failed model: \`${fm}\`` : "";
		const fel =
			(pa?.error ?? task.retryNotification.failedError)
				? `\n- Error: ${pa?.error ?? task.retryNotification.failedError}`
				: "";
		const rm = formatAttemptModelSummary(ba) ?? task.retryNotification.nextModel;
		const ppc = await ctx.resolveParentWakePromptContext(task);
		ctx.queuePendingParentWake(
			task.parentSessionId,
			`<system-reminder>\n[BACKGROUND TASK RETRY SESSION READY]\n**ID:** \`${task.id}\`\n**Description:** ${task.description}\n**Retry attempt:** ${an}\n**Retry session:** \`${sessionID}\`\n**Retry link:** ${rsu}${fsl}${fml}${fel}${rm ? `\n- Model: \`${rm}\`` : ""}\n\nThe fallback retry session is now created and can be inspected directly.\n</system-reminder>`,
			ppc,
			false,
			PENDING_PARENT_WAKE_DEBOUNCE_MS,
		);
		task.retryNotification = undefined;
	}
	ctx.taskHistory.record(input.parentSessionId, {
		id: task.id,
		sessionID,
		agent: input.agent,
		description: input.description,
		status: "running",
		category: input.category,
		startedAt: task.startedAt,
	});
	ctx.startPolling();
	const lm = input.model ? { providerID: input.model.providerID, modelID: input.model.modelID } : undefined;
	const lv = input.model?.variant;
	if (input.model) applySessionPromptParams(sessionID, input.model);
	const ud: Record<string, boolean> = {};
	if (input.userPermission) {
		for (const [tool, value] of Object.entries(input.userPermission)) {
			if (value === "deny") ud[tool] = false;
		}
	}
	const lt = {
		task: false,
		call_omo_agent: true,
		question: false,
		...ud,
		...getAgentToolRestrictions(input.agent, { includeTeamToolDenylist: input.teamRunId === undefined }),
	};
	setSessionTools(sessionID, lt);
	log("[background-agent] Launching task:", { taskId: task.id, sessionID, agent: input.agent });
	registerDelegatedChildSessionBootstrap({
		sessionID,
		promptText: input.prompt,
		fallbackChain: input.fallbackChain,
		category: input.category,
		system: input.skillContent,
		tools: lt,
		modelFallbackControllerAccessor: ctx.modelFallbackControllerAccessor,
	});
	const ttm = getTaskToastManager();
	if (ttm) ttm.updateTask(task.id, "running");
	log("[background-agent] Calling prompt (fire-and-forget) for launch with:", {
		sessionID,
		agent: input.agent,
		model: input.model,
		hasSkillContent: !!input.skillContent,
		promptLength: input.prompt.length,
	});
	const pb = {
		agent: input.agent,
		...(lm ? { model: lm } : {}),
		...(lv ? { variant: lv } : {}),
		system: input.skillContent,
		tools: lt,
		parts: [createInternalAgentTextPart(input.prompt)],
	};
	promptWithRetryInDirectory(ctx.client, { path: { id: sessionID }, body: pb }, pd).catch(async (error: unknown) => {
		if (isAgentNotFoundError(error) && input.agent !== FALLBACK_AGENT) {
			log("[background-agent] Agent not found, retrying with fallback agent", {
				original: input.agent,
				fallback: FALLBACK_AGENT,
				taskId: task.id,
			});
			try {
				const fb = buildFallbackBody(pb, FALLBACK_AGENT, {
					includeTeamToolDenylist: input.teamRunId === undefined,
				});
				const fbt = fb.tools as Record<string, boolean>;
				setSessionTools(sessionID, fbt);
				updateSessionAgent(sessionID, FALLBACK_AGENT);
				registerDelegatedChildSessionBootstrap({
					sessionID,
					promptText: input.prompt,
					fallbackChain: input.fallbackChain,
					category: input.category,
					system: input.skillContent,
					tools: fbt,
					modelFallbackControllerAccessor: ctx.modelFallbackControllerAccessor,
				});
				await promptWithRetryInDirectory(ctx.client, { path: { id: sessionID }, body: fb }, pd);
				task.agent = FALLBACK_AGENT;
				return;
			} catch (re) {
				log("[background-agent] Fallback agent also failed:", re);
			}
		}
		log("[background-agent] promptAsync error:", error);
		const rt = ctx.resolveTaskAttemptBySession(sessionID);
		const et = rt?.task;
		if (rt && !rt.isCurrent) {
			log("[background-agent] Ignoring prompt error from stale attempt session", {
				sessionID,
				currentAttemptID: rt.task.currentAttemptID,
				attemptID: rt.attemptID,
			});
			return;
		}
		if (et) {
			const ei = {
				name: extractErrorName(error),
				message: extractErrorMessage(error),
				statusCode: extractErrorStatusCode(error),
			};
			if (await ctx.tryFallbackRetry(et, ei, "promptAsync.launch")) return;
			const em = ei.message ?? (error instanceof Error ? error.message : String(error));
			const te =
				em.includes("agent.name") || em.includes("undefined") || isAgentNotFoundError(error)
					? `Agent "${input.agent}" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.`
					: em;
			if (et.currentAttemptID) finalizeAttempt(et, et.currentAttemptID, "interrupt", te);
			else {
				et.status = "interrupt";
				et.error = te;
				et.completedAt = new Date();
			}
			if (et.rootSessionId) {
				const cc = ctx.rootDescendantCounts.get(et.rootSessionId) ?? 0;
				if (cc <= 1) ctx.rootDescendantCounts.delete(et.rootSessionId);
				else ctx.rootDescendantCounts.set(et.rootSessionId, cc - 1);
			}
			if (et.concurrencyKey) {
				ctx.concurrencyManager.release(et.concurrencyKey);
				et.concurrencyKey = undefined;
			}
			removeTaskToastTracking(et.id);
			clearDelegatedChildSessionBootstrap(sessionID);
			await ctx.abortSessionWithLogging(sessionID, "launch error cleanup");
			ctx.markForNotification(et);
			ctx.enqueueNotificationForParent(et.parentSessionId, () => ctx.notifyParentSession(et)).catch((err) => {
				log("[background-agent] Failed to notify on error:", err);
			});
		}
	});
	log("[background-agent] tmux callback check", {
		hasCallback: !!ctx.onSubagentSessionCreated,
		tmuxEnabled: ctx.tmuxEnabled,
		isInsideTmux: isInsideTmux(),
		sessionID,
		parentID: input.parentSessionId,
	});
	if (!input.suppressTmuxSpawn && ctx.onSubagentSessionCreated && ctx.tmuxEnabled && isInsideTmux()) {
		log("[background-agent] Invoking tmux callback (fire-and-forget)", { sessionID });
		void ctx
			.onSubagentSessionCreated({ sessionID, parentID: input.parentSessionId, title: input.description })
			.catch((err: unknown) => {
				log("[background-agent] Failed to spawn tmux pane:", err);
			});
	} else {
		log("[background-agent] SKIP tmux callback - conditions not met", {
			suppressTmuxSpawn: !!input.suppressTmuxSpawn,
		});
	}
}

// --- trackTask ---
export async function trackExternalTask(
	ctx: BgManagerAPI,
	input: {
		taskId: string;
		sessionId: string;
		parentSessionId: string;
		description: string;
		agent?: string;
		parentAgent?: string;
		concurrencyKey?: string;
	},
): Promise<BackgroundTask> {
	const et = ctx.tasks.get(input.taskId);
	if (et) {
		const pc = input.parentSessionId !== et.parentSessionId;
		if (pc) {
			ctx.cleanupPendingByParent(et);
			updateTaskParent(ctx, et, input.parentSessionId);
		}
		if (input.parentAgent !== undefined) et.parentAgent = input.parentAgent;
		if (!et.concurrencyGroup)
			et.concurrencyGroup = input.concurrencyKey
				? ctx.concurrencyManager.getConcurrencyKey(input.concurrencyKey)
				: et.agent;
		if (et.sessionId) subagentSessions.add(et.sessionId);
		ctx.startPolling();
		if (et.status === "pending" || et.status === "running") {
			const p = ctx.pendingByParent.get(input.parentSessionId) ?? new Set();
			p.add(et.id);
			ctx.pendingByParent.set(input.parentSessionId, p);
		} else if (!pc) ctx.cleanupPendingByParent(et);
		log("[background-agent] External task already registered:", {
			taskId: et.id,
			sessionID: et.sessionId,
			status: et.status,
		});
		return et;
	}
	const ck = input.concurrencyKey ? ctx.concurrencyManager.getConcurrencyKey(input.concurrencyKey) : undefined;
	const cg = ck ?? input.agent ?? "task";
	if (ck) await ctx.concurrencyManager.acquire(ck);
	const t: BackgroundTask = {
		id: input.taskId,
		sessionId: input.sessionId,
		parentSessionId: input.parentSessionId,
		parentMessageId: "",
		description: input.description,
		prompt: "",
		agent: input.agent || "task",
		status: "running",
		startedAt: new Date(),
		progress: { toolCalls: 0, lastUpdate: new Date() },
		parentAgent: input.parentAgent,
		concurrencyKey: ck,
		concurrencyGroup: cg,
	};
	addTask(ctx, t);
	subagentSessions.add(input.sessionId);
	ctx.startPolling();
	ctx.taskHistory.record(input.parentSessionId, {
		id: t.id,
		sessionID: input.sessionId,
		agent: input.agent || "task",
		description: input.description,
		status: "running",
		startedAt: t.startedAt,
	});
	if (input.parentSessionId) {
		const p = ctx.pendingByParent.get(input.parentSessionId) ?? new Set();
		p.add(t.id);
		ctx.pendingByParent.set(input.parentSessionId, p);
	}
	log("[background-agent] Registered external task:", { taskId: t.id, sessionID: input.sessionId });
	return t;
}

// --- resume ---
export async function resumeTask(ctx: BgManagerAPI, input: ResumeInput): Promise<BackgroundTask> {
	const et = ctx.findBySession(input.sessionId);
	if (!et) throw new Error(`Task not found for session: ${input.sessionId}`);
	if (!et.sessionId) throw new Error(`Task has no sessionID: ${et.id}`);
	if (et.status === "running") {
		log("[background-agent] Resume skipped - task already running:", { taskId: et.id, sessionID: et.sessionId });
		return et;
	}
	const rs = captureResumeTaskSnapshot(et);
	const ct = ctx.completionTimers.get(et.id);
	if (ct) {
		clearTimeout(ct);
		ctx.completionTimers.delete(et.id);
	}
	const ck = ctx.concurrencyManager.getConcurrencyKey(et.concurrencyGroup ?? et.agent);
	await ctx.concurrencyManager.acquire(ck);
	et.concurrencyKey = ck;
	et.concurrencyGroup = ck;
	et.status = "running";
	et.completedAt = undefined;
	et.error = undefined;
	updateTaskParent(ctx, et, input.parentSessionId);
	et.parentMessageId = input.parentMessageId;
	et.parentModel = input.parentModel;
	et.parentAgent = input.parentAgent;
	if (input.parentTools) et.parentTools = input.parentTools;
	et.startedAt = new Date();
	et.progress = {
		toolCalls: et.progress?.toolCalls ?? 0,
		toolCallWindow: et.progress?.toolCallWindow,
		countedToolPartIDs: et.progress?.countedToolPartIDs,
		lastUpdate: new Date(),
	};
	ctx.startPolling();
	if (et.sessionId) subagentSessions.add(et.sessionId);
	if (input.parentSessionId) {
		const p = ctx.pendingByParent.get(input.parentSessionId) ?? new Set();
		p.add(et.id);
		ctx.pendingByParent.set(input.parentSessionId, p);
	}
	const tm = getTaskToastManager();
	if (tm) tm.addTask({ id: et.id, description: et.description, agent: et.agent, isBackground: true });
	log("[background-agent] Resuming task:", { taskId: et.id, sessionID: et.sessionId });
	log("[background-agent] Resuming task - calling prompt (fire-and-forget) with:", {
		sessionID: et.sessionId,
		agent: et.agent,
		model: et.model,
		promptLength: input.prompt.length,
	});
	const rm = et.model ? { providerID: et.model.providerID, modelID: et.model.modelID } : undefined;
	const rv = et.model?.variant;
	if (et.model) applySessionPromptParams(et.sessionId!, et.model);
	dispatchInternalPrompt({
		mode: "async",
		client: ctx.client,
		sessionID: et.sessionId,
		source: "background-agent-resume",
		settleMs: 0,
		queueBehavior: "defer",
		input: {
			path: { id: et.sessionId },
			body: {
				agent: et.agent,
				...(rm ? { model: rm } : {}),
				...(rv ? { variant: rv } : {}),
				tools: (() => {
					const ts = {
						task: false,
						call_omo_agent: true,
						question: false,
						...getAgentToolRestrictions(et.agent, { includeTeamToolDenylist: et.teamRunId === undefined }),
					};
					setSessionTools(et.sessionId!, ts);
					return ts;
				})(),
				parts: [createInternalAgentTextPart(input.prompt)],
			},
			query: { directory: ctx.directory },
		},
	})
		.then((pr) => {
			if (pr.status === "failed") {
				if (isAmbiguousPostDispatchPromptFailure(pr)) {
					log(
						"[background-agent] resume prompt may have been accepted before ambiguous failure; continuing to poll",
						{
							taskId: et.id,
							sessionID: et.sessionId,
							error: pr.error instanceof Error ? pr.error.message : String(pr.error),
						},
					);
					return;
				}
				throw pr.error;
			}
			if (pr.status === "queued") {
				log("[background-agent] resume prompt queued by prompt dispatcher:", {
					taskId: et.id,
					sessionID: et.sessionId,
					queuedBy: pr.queuedBy,
				});
				return;
			}
			if (pr.status !== "dispatched") {
				log("[background-agent] resume prompt skipped by promptAsync gate:", {
					taskId: et.id,
					sessionID: et.sessionId,
					status: pr.status,
				});
				restoreTaskAfterSkippedResume(ctx, et, rs, pr.status);
			}
		})
		.catch(async (error: unknown) => {
			log("[background-agent] resume prompt error:", error);
			const ei = {
				name: extractErrorName(error),
				message: extractErrorMessage(error),
				statusCode: extractErrorStatusCode(error),
			};
			if (await ctx.tryFallbackRetry(et, ei, "promptAsync.resume")) return;
			et.status = "interrupt";
			const em = ei.message ?? (error instanceof Error ? error.message : String(error));
			et.error = em;
			et.completedAt = new Date();
			if (et.rootSessionId) {
				const cc = ctx.rootDescendantCounts.get(et.rootSessionId) ?? 0;
				if (cc <= 1) ctx.rootDescendantCounts.delete(et.rootSessionId);
				else ctx.rootDescendantCounts.set(et.rootSessionId, cc - 1);
			}
			if (et.concurrencyKey) {
				ctx.concurrencyManager.release(et.concurrencyKey);
				et.concurrencyKey = undefined;
			}
			removeTaskToastTracking(et.id);
			if (et.sessionId) {
				clearDelegatedChildSessionBootstrap(et.sessionId);
				await ctx.abortSessionWithLogging(et.sessionId, "resume error cleanup");
			}
			ctx.markForNotification(et);
			ctx.enqueueNotificationForParent(et.parentSessionId, () => ctx.notifyParentSession(et)).catch((err) => {
				log("[background-agent] Failed to notify on resume error:", err);
			});
		});
	return et;
}
