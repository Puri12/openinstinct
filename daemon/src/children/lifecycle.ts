import {
  DEFAULT_CHILD_IDLE_TIMEOUT_MS as RUNTIME_DEFAULT_CHILD_IDLE_TIMEOUT_MS,
  DEFAULT_CHILD_WARM_TTL_MS as RUNTIME_DEFAULT_CHILD_WARM_TTL_MS,
  DEFAULT_CONVERSATIONAL_CHILD_TIMEOUT_MS as RUNTIME_DEFAULT_CONVERSATIONAL_CHILD_TIMEOUT_MS,
  DEFAULT_DAEMON_CHILD_TIMEOUT_MS as RUNTIME_DEFAULT_DAEMON_CHILD_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_CHILDREN as RUNTIME_DEFAULT_MAX_CONCURRENT_CHILDREN,
  DEFAULT_MAX_LIVE_CHILDREN as RUNTIME_DEFAULT_MAX_LIVE_CHILDREN,
} from "../runtime-config.ts";

import { holdForDrill } from "../drills/hooks.ts";
import { stat } from "node:fs/promises";
import type { ChildOrigin, ChildPriority, ChildRecord, ReceiptRecord } from "../store/index.ts";
import type { ChildConversation, ChildReportOutcome, ChildTurnResult, ConversationalChildRunner } from "./conversation.ts";
import { ChildRegistry, type TerminalAdmission } from "./registry.ts";
import type { ChildRunResult, ChildRunner } from "./runner.ts";
import { ChildSessionPool } from "./session-pool.ts";
import { createTerminalReport, TerminalJournal, type TerminalReport } from "./terminal-journal.ts";

export const DEFAULT_CONVERSATIONAL_CHILD_TIMEOUT_MS = RUNTIME_DEFAULT_CONVERSATIONAL_CHILD_TIMEOUT_MS;
export const DEFAULT_DAEMON_CHILD_TIMEOUT_MS = RUNTIME_DEFAULT_DAEMON_CHILD_TIMEOUT_MS;
export const DEFAULT_MAX_CONCURRENT_CHILDREN = RUNTIME_DEFAULT_MAX_CONCURRENT_CHILDREN;
export const DEFAULT_CHILD_WARM_TTL_MS = RUNTIME_DEFAULT_CHILD_WARM_TTL_MS;
export const DEFAULT_CHILD_IDLE_TIMEOUT_MS = RUNTIME_DEFAULT_CHILD_IDLE_TIMEOUT_MS;
export const DEFAULT_MAX_LIVE_CHILDREN = RUNTIME_DEFAULT_MAX_LIVE_CHILDREN;
export const DEFAULT_CHILD_DISPOSE_TIMEOUT_MS = 5_000;

export interface ChildLifecycleOptions {
  readonly registry: ChildRegistry;
  readonly journal: TerminalJournal;
  /** One-shot runner used only for daemon-kind children. */
  readonly runner: ChildRunner;
  readonly conversation: ConversationalChildRunner;
  readonly daemonRunner?: ChildRunner;
  /** Selects a daemon runner from durable child fields without adding runner-specific registry state. */
  readonly daemonRunnerSelector?: (child: ChildRecord) => ChildRunner | undefined;
  readonly maxConcurrent?: number;
  readonly maxLive?: number;
  readonly warmTtlMs?: number;
  readonly idleTimeoutMs?: number;
  readonly defaultConversationalTimeoutMs?: number;
  readonly defaultDaemonTimeoutMs?: number;
  readonly now?: () => Date;
  readonly onReceipt?: (receipt: ReceiptRecord) => void | Promise<void>;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
  readonly onChildUpdated?: (child: ChildRecord) => void;
  readonly disposeTimeoutMs?: number;
  readonly onReport?: (input: { readonly childId: string; readonly title: string; readonly text: string; readonly toolCallId: string; readonly truncated?: boolean }) => ChildReportOutcome;
}

export interface DelegateBackgroundRequest {
  readonly title: string;
  readonly prompt: string;
  readonly timeoutMs?: number;
}

export interface DaemonChildRequest {
  readonly title: string;
  readonly prompt: string;
  readonly origin: Exclude<ChildOrigin, "owner">;
  readonly timeoutMs?: number;
  readonly priority?: ChildPriority;
  /** Called after durable child admission and before execution is scheduled. */
  readonly onAdmitted?: (child: ChildRecord) => void;
}

export type NudgeOutcome =
  | { readonly status: "steered" | "started" | "queued" }
  | { readonly status: "cold"; readonly queued: true };

export type ReleaseOutcome = { readonly status: "released" | "cancelling" };

interface ActiveChild {
  readonly child: ChildRecord;
  readonly controller: AbortController;
}

interface TurnRequest {
  prompt: string;
  receipt: boolean;
  first: boolean;
  needsResume: boolean;
}

interface ConversationalChildState {
  phase: "queued" | "opening" | "running" | "cancelling" | "idle" | "disposing" | "cold" | "terminated";
  generation: number;
  mutex: Promise<void>;
  conversation?: ChildConversation;
  poolGeneration?: number;
  request?: TurnRequest;
  /** OR-only for the current opening/running turn; reset before every settlement. */
  receiptWanted: boolean;
  cancelRequested: boolean;
  cancelGeneration?: number;
  controller?: AbortController;
  idleSince?: number;
}

/**
 * Owns durable admission, bounded execution, and recovery for every child
 * kind. Task-tool children retain a conversational SDK object while idle;
 * daemon-kind children retain the established one-shot runner path.
 */
export class ChildLifecycle {
  private readonly now: () => Date;
  private readonly maxConcurrent: number;
  private readonly maxLive: number;
  private readonly warmTtlMs: number;
  private readonly disposeTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly defaultConversationalTimeoutMs: number;
  private readonly defaultDaemonTimeoutMs: number;
  private readonly active = new Map<string, ActiveChild>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly pendingDaemons: ChildRecord[] = [];
  private readonly pendingDaemonIds = new Set<string>();
  private readonly conversations = new Map<string, ConversationalChildState>();
  /** Durable child rows mirrored for synchronous tool lookup; refreshed on every lifecycle mutation. */
  private readonly children = new Map<string, ChildRecord>();
  private readonly pool: ChildSessionPool;
  private stopped = false;
  private pumpScheduled = false;
  private releaseWrites = 0;

  public constructor(private readonly options: ChildLifecycleOptions) {
    this.now = options.now ?? (() => new Date());
    for (const child of options.registry.list()) {
      this.children.set(child.id, child);
    }
    this.maxConcurrent = positiveInteger(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_CHILDREN, "maxConcurrent");
    this.maxLive = positiveInteger(options.maxLive ?? DEFAULT_MAX_LIVE_CHILDREN, "maxLive");
    if (this.maxLive < this.maxConcurrent) {
      throw new Error("maxLive must be greater than or equal to maxConcurrent");
    }
    this.warmTtlMs = positiveInteger(options.warmTtlMs ?? DEFAULT_CHILD_WARM_TTL_MS, "warmTtlMs");
    this.disposeTimeoutMs = positiveInteger(options.disposeTimeoutMs ?? DEFAULT_CHILD_DISPOSE_TIMEOUT_MS, "disposeTimeoutMs");
    this.idleTimeoutMs = positiveInteger(options.idleTimeoutMs ?? DEFAULT_CHILD_IDLE_TIMEOUT_MS, "idleTimeoutMs");
    this.defaultConversationalTimeoutMs = positiveInteger(
      options.defaultConversationalTimeoutMs ?? DEFAULT_CONVERSATIONAL_CHILD_TIMEOUT_MS,
      "defaultConversationalTimeoutMs",
    );
    this.defaultDaemonTimeoutMs = positiveInteger(
      options.defaultDaemonTimeoutMs ?? DEFAULT_DAEMON_CHILD_TIMEOUT_MS,
      "defaultDaemonTimeoutMs",
    );
    this.pool = new ChildSessionPool({
      runner: options.conversation,
      now: this.now,
      onEvent: (event, fields) => this.event(event, fields),
      ...(options.onReport === undefined
        ? {}
        : { onReport: ({ childId, title, report }) => options.onReport!({ childId, title, ...report }) }),
    });
  }

  /** Slots are held only while a daemon run or conversational opening/turn is active. */
  public get activeCount(): number {
    return this.active.size;
  }

  public get queuedCount(): number {
    let queued = this.pendingDaemons.length;
    for (const state of this.conversations.values()) {
      if (state.request && (state.phase === "queued" || state.phase === "idle" || state.phase === "cold" || state.phase === "disposing")) {
        queued += 1;
      }
    }
    return queued;
  }

  /** Enqueues a conversational task-tool child and returns before it starts. */
  public delegate(input: DelegateBackgroundRequest): ChildRecord {
    this.assertRunning();
    this.enforceLiveCap();
    const requested = this.options.registry.register({
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: input.title,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs ?? this.defaultConversationalTimeoutMs,
    });
    const admitted = this.options.registry.markAdmitted(requested.id);
    this.remember(admitted);
    this.conversations.set(admitted.id, this.newConversationState("queued", {
      prompt: admitted.prompt,
      receipt: true,
      first: true,
      needsResume: false,
    }));
    this.event("requested", {
      childId: admitted.id,
      kind: admitted.kind,
      origin: admitted.origin,
      priority: admitted.priority,
      title: admitted.title,
    });
    this.schedulePump();
    return admitted;
  }

  /** Schedules a daemon-originated child; monitor work wins the next free slot. */
  public spawnDaemon(input: DaemonChildRequest): ChildRecord {
    this.assertRunning();
    this.enforceLiveCap();
    const requested = this.options.registry.register({
      kind: "daemon",
      priority: input.priority ?? "monitor",
      origin: input.origin,
      title: input.title,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs ?? this.defaultDaemonTimeoutMs,
    });
    const admitted = this.options.registry.markAdmitted(requested.id);
    this.remember(admitted);
    this.event("requested", {
      childId: admitted.id,
      kind: admitted.kind,
      origin: admitted.origin,
      priority: admitted.priority,
      title: admitted.title,
    });
    try {
      input.onAdmitted?.(admitted);
    } catch (error) {
      this.failAdmission(admitted, error);
      throw error;
    }
    this.enqueueDaemon(admitted);
    this.schedulePump();
    return admitted;
  }

  /** Synchronously enqueues or steers a live conversational child. */
  public nudge(childId: string, text: string, input: { readonly receipt: boolean }): NudgeOutcome {
    const child = this.childFor(childId);
    if (!child) {
      throw new Error(`child_not_found: ${childId}`);
    }
    if (child.kind !== "task_tool" || isTerminal(child.state)) {
      throw new Error(`child_not_live: ${childId} is ${child.state}`);
    }
    const state = this.stateFor(child);
    return this.transition(childId, (current) => {
      switch (current.phase) {
        case "running":
          current.conversation?.steer(text);
          current.receiptWanted = current.receiptWanted || input.receipt;
          this.event("child_nudged", { childId, status: "steered", queued: false, receipt: input.receipt });
          return { status: "steered" };
        case "opening":
          this.coalesce(current, text, input.receipt, false);
          this.event("child_nudged", { childId, status: "queued", queued: true, receipt: input.receipt });
          return { status: "queued" };
        case "idle":
          if (current.request) {
            this.coalesce(current, text, input.receipt, false);
            this.schedulePump();
            this.event("child_nudged", { childId, status: "queued", queued: true, receipt: input.receipt });
            return { status: "queued" };
          }
          current.request = { prompt: text, receipt: input.receipt, first: false, needsResume: false };
          this.schedulePump();
          this.event("child_nudged", { childId, status: "started", queued: false, receipt: input.receipt });
          return { status: "started" };
        case "cold":
          if (current.request) {
            this.coalesce(current, text, input.receipt, true);
            this.schedulePump();
            this.event("child_nudged", { childId, status: "queued", queued: true, receipt: input.receipt });
            return { status: "queued" };
          }
          current.request = { prompt: text, receipt: input.receipt, first: false, needsResume: true };
          this.schedulePump();
          this.event("child_nudged", { childId, status: "cold", queued: true, receipt: input.receipt });
          return { status: "cold", queued: true };
        case "queued":
        case "disposing":
        case "cancelling":
          this.coalesce(current, text, input.receipt, current.phase === "disposing" || current.phase === "cancelling");
          this.schedulePump();
          this.event("child_nudged", { childId, status: "queued", queued: true, receipt: input.receipt });
          return { status: "queued" };
        case "terminated":
          throw new Error(`child_not_live: ${childId} is ${child.state}`);
      }
    });
  }

  /** Releases an idle child without a receipt, or cancels its active turn. */
  public release(childId: string): ReleaseOutcome {
    const child = this.childFor(childId);
    if (!child) {
      throw new Error(`child_not_found: ${childId}`);
    }
    if (child.kind !== "task_tool" || isTerminal(child.state)) {
      throw new Error(`child_not_live: ${childId} is ${child.state}`);
    }
    const state = this.stateFor(child);
    return this.transition(childId, (current) => {
      if (current.phase === "opening" || current.phase === "running") {
        const activeGeneration = current.generation;
        current.cancelGeneration = activeGeneration;
        current.cancelRequested = true;
        current.generation += 1;
        current.phase = "cancelling";
        const controller = current.controller;
        if (controller) {
          setTimeout(() => {
            try {
              controller.abort();
            } catch (error) {
              this.event("child_abort_failed", { childId, message: messageOf(error) });
            }
          }, 0);
        }
        this.event("child_released", { childId, status: "cancelling" });
        return { status: "cancelling" };
      }
      if (current.phase === "queued") {
        current.request = undefined;
        current.receiptWanted = false;
        current.phase = "terminated";
        current.generation += 1;
        this.remember(this.logicalTerminated(child, "released"));
        this.scheduleReleaseWrite(child.id, () => this.options.registry.markQueuedTerminated(child.id));
        this.event("child_terminated", { childId, reason: "released" });
        this.event("child_released", { childId, status: "released" });
        return { status: "released" };
      }
      if (current.phase === "idle" || current.phase === "cold") {
        this.scheduleDormantRelease(child, current);
        this.event("child_released", { childId, status: "released" });
        return { status: "released" };
      }
      throw new Error(`child_not_live: ${childId} is ${child.state}`);
    });
  }

  /** Retained for daemon callers; conversational callers use release. */
  public async cancel(childId: string): Promise<ChildRecord | undefined> {
    const child = this.options.registry.get(childId);
    if (!child) {
      return undefined;
    }
    if (child.kind === "task_tool") {
      this.release(childId);
      return this.options.registry.get(childId);
    }
    const queuedIndex = this.pendingDaemons.findIndex((candidate) => candidate.id === childId);
    if (queuedIndex !== -1) {
      const [queued] = this.pendingDaemons.splice(queuedIndex, 1);
      this.pendingDaemonIds.delete(childId);
      if (!queued) {
        return this.options.registry.get(childId);
      }
      const admission = await this.publishTerminal(queued, queued.createdAt, cancelledResult("Background task was cancelled before execution."));
      this.remember(admission.child);
      this.notifyReceipt(admission.receipt);
      return admission.child;
    }
    const active = this.active.get(childId);
    if (active) {
      active.controller.abort();
      await this.executions.get(childId);
    }
    return this.options.registry.get(childId);
  }

  /** Store-only reader used by synchronous child tools. */
  public status(childId: string): ChildRecord | undefined {
    return this.childFor(childId);
  }


  private scheduleDormantRelease(child: ChildRecord, state: ConversationalChildState): void {
    // Release is logically and durably complete before best-effort warm-session
    // disposal. This frees live capacity immediately even if dispose hangs.
    this.remember(this.logicalTerminated(child, "released"));
    this.scheduleReleaseWrite(child.id, () => this.options.registry.markTerminated(child.id, "released"));
    const generation = state.generation + 1;
    const poolGeneration = state.poolGeneration;
    state.generation = generation;
    state.cancelRequested = false;
    state.cancelGeneration = undefined;
    state.request = undefined;
    state.receiptWanted = false;
    state.idleSince = undefined;
    state.phase = "disposing";
    void this.serialize(state, async () => {
      let timedOut = false;
      let disposeError: unknown;
      try {
        if (poolGeneration !== undefined) {
          timedOut = await this.disposePoolBounded(child.id, poolGeneration);
        }
      } catch (error) {
        disposeError = error;
      } finally {
        this.completeDormantRelease(child, state, generation);
      }
      if (timedOut) {
        this.event("child_dispose_timeout", { childId: child.id, timeoutMs: this.disposeTimeoutMs });
      }
      if (disposeError !== undefined) {
        this.event("child_dispose_failed", { childId: child.id, message: messageOf(disposeError) });
      }
    }).catch((error) => {
      this.event("child_dispose_failed", { childId: child.id, message: messageOf(error) });
      this.completeDormantRelease(child, state, generation);
    });
  }

  private async disposePoolBounded(childId: string, generation: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.disposeTimeoutMs);
    });
    try {
      await Promise.race([this.pool.dispose(childId, generation), timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    return timedOut;
  }


  private completeDormantRelease(child: ChildRecord, state: ConversationalChildState, generation: number): void {
    try {
      this.transition(child.id, (current) => {
        if (current !== state || current.generation !== generation || current.phase !== "disposing") {
          return;
        }
        const durable = this.options.registry.get(child.id);
        if (current.request !== undefined) {
          if (durable?.state === "idle") {
            this.remember(this.options.registry.markCold(child.id));
          }
          current.phase = "cold";
          current.poolGeneration = undefined;
          current.conversation = undefined;
          this.event("child_cold", { childId: child.id, reason: "release_race" });
          this.schedulePump();
          return;
        }
        if (durable && !isTerminal(durable.state)) {
          this.remember(this.options.registry.markTerminated(child.id, "released"));
        }
        current.phase = "terminated";
        current.poolGeneration = undefined;
        current.conversation = undefined;
        this.event("child_terminated", { childId: child.id, reason: "released" });
      });
    } catch (error) {
      if (state.generation === generation && state.phase === "disposing") {
        state.phase = "terminated";
        state.poolGeneration = undefined;
        state.conversation = undefined;
      }
      this.event("child_termination_failed", { childId: child.id, reason: "released", message: messageOf(error) });
    }
  }

  public sweep(now = this.now()): void {
    if (this.stopped || !Number.isFinite(now.getTime())) {
      return;
    }
    const nowMs = now.getTime();
    for (const child of this.options.registry.listLive()) {
      if ((child.state !== "idle" && child.state !== "cold") || !this.idleTimeoutElapsed(child, nowMs)) {
        continue;
      }
      if (child.kind === "task_tool") {
        const state = this.stateFor(child);
        if (state.request || state.phase !== child.state || this.active.has(child.id)) {
          continue;
        }
      }
      this.terminateDormant(child, "idle_timeout");
    }
    for (const child of this.options.registry.listLive()) {
      if (child.kind !== "task_tool" || child.state !== "idle") {
        continue;
      }
      const state = this.stateFor(child);
      if (state.phase !== "idle" || state.request || this.active.has(child.id) || !this.warmTtlElapsed(child, state, nowMs)) {
        continue;
      }
      this.disposeWarmToCold(child, state);
    }
  }

  /**
   * Replays journal-first crashes, requeues known-not-started work, and admits
   * one durable orphan receipt whenever liveness or a resume transcript cannot
   * be proven after a restart.
   */
  public async reconcile(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const persisted = this.options.registry.list();
    this.children.clear();
    for (const child of persisted) {
      this.children.set(child.id, child);
    }
    for (const child of persisted) {
      const recovered = this.recoverTerminal(child.id);
      if (recovered) {
        this.event("terminal_recovered", {
          childId: child.id,
          receiptId: recovered.receipt.id,
          checksum: recovered.child.terminalChecksum,
        });
        this.notifyReceipt(recovered.receipt);
        continue;
      }
      if (child.state === "requested" || child.state === "admitted") {
        const admitted = child.state === "requested" ? this.options.registry.markAdmitted(child.id) : child;
        this.remember(admitted);
        if (admitted.kind === "daemon") {
          this.enqueueDaemon(admitted);
        } else {
          this.conversations.set(admitted.id, this.newConversationState("queued", {
            prompt: admitted.prompt,
            receipt: true,
            first: true,
            needsResume: false,
          }));
        }
        this.event("requeued_after_restart", { childId: admitted.id, priority: admitted.priority });
        continue;
      }
      if (child.state === "running") {
        this.orphan(child, "liveness_unprovable");
        continue;
      }
      if (child.kind !== "task_tool" || (child.state !== "idle" && child.state !== "cold")) {
        continue;
      }
      if (!(await hasReadableSessionFile(child.sessionFile))) {
        this.orphan(child, "session_file_missing");
        continue;
      }
      if (child.state === "idle") {
        this.remember(this.options.registry.markCold(child.id));
        this.event("child_cold", { childId: child.id, reason: "restart" });
      }
      this.conversations.set(child.id, this.newConversationState("cold"));
    }
    this.schedulePump();
  }

  /** Idempotently projects a published report into child state and receipt state. */
  public recoverTerminal(childId: string): TerminalAdmission | undefined {
    const report = this.options.journal.recoverTerminal(childId);
    if (!report) {
      return undefined;
    }
    const admission = this.options.registry.admitTerminal(report, this.options.journal.pathFor(childId));
    this.remember(admission.child);
    return admission;
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.pendingDaemons.length = 0;
    this.pendingDaemonIds.clear();
    for (const { controller } of this.active.values()) {
      controller.abort();
    }
    await Promise.allSettled([...this.executions.values()]);
    await this.disposeAllBounded();
    for (const child of this.options.registry.list()) {
      if (child.kind !== "task_tool" || child.state !== "idle") {
        continue;
      }
      this.remember(this.options.registry.markCold(child.id));
      const state = this.stateFor(child);
      state.phase = "cold";
      state.conversation = undefined;
      state.poolGeneration = undefined;
      state.idleSince = undefined;
      state.receiptWanted = false;
      this.event("child_cold", { childId: child.id, reason: "stop" });
    }
  }

  private async disposeAllBounded(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.disposeTimeoutMs);
    });
    try {
      await Promise.race([this.pool.disposeAll().catch((error) => {
        this.event("child_dispose_failed", { message: messageOf(error) });
      }), timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    if (timedOut) {
      this.event("child_dispose_timeout", { timeoutMs: this.disposeTimeoutMs });
    }
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error("child lifecycle is stopped");
    }
  }

  private enforceLiveCap(): void {
    const liveChildren = (): ChildRecord[] => [...this.children.values()].filter((child) => !isTerminal(child.state));
    while (liveChildren().length >= this.maxLive) {
      const victim = liveChildren()
        .filter((child) => child.state === "idle" || child.state === "cold")
        .sort((left, right) => (left.lastActivityAt ?? left.createdAt).localeCompare(right.lastActivityAt ?? right.createdAt))[0];
      if (!victim || !this.terminateDormant(victim, "evicted")) {
        throw Object.assign(new Error("child_cap_reached"), { code: "child_cap_reached" });
      }
      this.event("child_evicted", { childId: victim.id, kind: victim.kind, origin: victim.origin });
    }
  }

  private terminateDormant(child: ChildRecord, reason: "released" | "idle_timeout" | "evicted"): boolean {
    if (child.state !== "idle" && child.state !== "cold") {
      return false;
    }
    if (child.kind !== "task_tool") {
      this.remember(this.options.registry.markTerminated(child.id, reason));
      this.event("child_terminated", { childId: child.id, reason });
      return true;
    }
    const state = this.stateFor(child);
    if (state.request || this.active.has(child.id) || (state.phase !== "idle" && state.phase !== "cold")) {
      return false;
    }
    const generation = state.generation + 1;
    const poolGeneration = state.poolGeneration;
    this.remember(this.options.registry.markTerminated(child.id, reason));
    state.generation = generation;
    state.request = undefined;
    state.receiptWanted = false;
    state.idleSince = undefined;
    state.phase = "disposing";
    if (poolGeneration === undefined) {
      this.completeTerminatedDispose(child, state, generation, reason);
    } else {
      void this.serialize(state, async () => {
        let timedOut = false;
        let disposeError: unknown;
        try {
          timedOut = await this.disposePoolBounded(child.id, poolGeneration);
        } catch (error) {
          disposeError = error;
        } finally {
          this.completeTerminatedDispose(child, state, generation, reason);
        }
        if (timedOut) {
          this.event("child_dispose_timeout", { childId: child.id, timeoutMs: this.disposeTimeoutMs });
        }
        if (disposeError !== undefined) {
          this.event("child_dispose_failed", { childId: child.id, message: messageOf(disposeError) });
        }
      }).catch((error) => {
        this.event("child_dispose_failed", { childId: child.id, message: messageOf(error) });
        this.completeTerminatedDispose(child, state, generation, reason);
      });
    }
    this.event("child_terminated", { childId: child.id, reason });
    return true;
  }

  private completeTerminatedDispose(
    child: ChildRecord,
    state: ConversationalChildState,
    generation: number,
    reason: "released" | "idle_timeout" | "evicted",
  ): void {
    try {
      this.transition(child.id, (current) => {
        if (current.generation !== generation || current.phase !== "disposing") {
          return;
        }
        current.phase = "terminated";
        current.conversation = undefined;
        current.poolGeneration = undefined;
      });
    } catch (error) {
      if (state.generation === generation && state.phase === "disposing") {
        state.phase = "terminated";
        state.conversation = undefined;
        state.poolGeneration = undefined;
      }
      this.event("child_termination_failed", { childId: child.id, reason, message: messageOf(error) });
    }
  }

  private disposeWarmToCold(child: ChildRecord, state: ConversationalChildState): void {
    const generation = state.generation + 1;
    const poolGeneration = state.poolGeneration;
    state.generation = generation;
    state.phase = "disposing";
    if (poolGeneration === undefined) {
      this.completeWarmDispose(child, state, generation);
      return;
    }
    void this.serialize(state, async () => {
      let disposeError: unknown;
      let timedOut = false;
      try {
        timedOut = await this.disposeWarmBounded(child.id, poolGeneration);
      } catch (error) {
        disposeError = error;
      } finally {
        this.completeWarmDispose(child, state, generation);
      }
      if (timedOut) {
        this.event("child_dispose_timeout", { childId: child.id, timeoutMs: this.disposeTimeoutMs });
      }
      if (disposeError !== undefined) {
        this.event("child_dispose_failed", { childId: child.id, message: messageOf(disposeError) });
      }
    }).catch((error) => {
      this.event("child_dispose_failed", { childId: child.id, message: messageOf(error) });
      this.completeWarmDispose(child, state, generation);
    });
  }

  private async disposeWarmBounded(childId: string, generation: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.disposeTimeoutMs);
    });
    try {
      await Promise.race([this.pool.disposeToCold(childId, generation), timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    return timedOut;
  }

  private completeWarmDispose(child: ChildRecord, state: ConversationalChildState, generation: number): void {
    let queued = false;
    try {
      queued = this.transition(child.id, (current) => {
        if (current !== state || current.generation !== generation || current.phase !== "disposing") {
          return false;
        }
        const durable = this.options.registry.get(child.id);
        if (!durable || durable.state !== "idle") {
          return false;
        }
        this.remember(this.options.registry.markCold(child.id));
        current.phase = "cold";
        current.conversation = undefined;
        current.poolGeneration = undefined;
        current.idleSince = undefined;
        current.receiptWanted = false;
        return current.request !== undefined;
      });
    } catch (error) {
      if (state.generation === generation && state.phase === "disposing") {
        let durable: ChildRecord | undefined;
        try {
          durable = this.options.registry.get(child.id);
        } catch {
          durable = undefined;
        }
        state.phase = durable && isTerminal(durable.state) ? "terminated" : "cold";
        state.conversation = undefined;
        state.poolGeneration = undefined;
        state.idleSince = undefined;
        state.receiptWanted = false;
      }
      this.event("child_dispose_failed", { childId: child.id, message: messageOf(error) });
      return;
    }
    if (queued || this.childFor(child.id)?.state === "cold") {
      this.event("child_cold", { childId: child.id, reason: "warm_ttl" });
    }
    if (queued) {
      this.schedulePump();
    }
  }

  private idleTimeoutElapsed(child: ChildRecord, nowMs: number): boolean {
    const activity = Date.parse(child.lastActivityAt ?? child.updatedAt);
    return Number.isFinite(activity) && nowMs - activity >= this.idleTimeoutMs;
  }

  private warmTtlElapsed(child: ChildRecord, state: ConversationalChildState, nowMs: number): boolean {
    const idleSince = state.idleSince ?? Date.parse(child.lastActivityAt ?? child.updatedAt);
    return Number.isFinite(idleSince) && nowMs - idleSince >= this.warmTtlMs;
  }

  private orphan(child: ChildRecord, reason: "session_file_missing" | "liveness_unprovable"): void {
    const admission = this.options.registry.admitOrphanReceipt(child, reason);
    this.remember(admission.child);
    if (child.kind === "task_tool") {
      const state = this.stateFor(child);
      state.phase = "terminated";
      state.request = undefined;
      state.receiptWanted = false;
      state.idleSince = undefined;
    }
    this.event("orphaned", {
      childId: admission.child.id,
      kind: child.kind,
      origin: child.origin,
      reason,
      receiptId: admission.receipt.id,
    });
    this.notifyReceipt(admission.receipt);
  }

  private enqueueDaemon(child: ChildRecord): void {
    if (this.pendingDaemonIds.has(child.id) || this.active.has(child.id)) {
      return;
    }
    this.pendingDaemons.push(child);
    this.pendingDaemonIds.add(child.id);
  }

  private schedulePump(): void {
    if (this.stopped || this.pumpScheduled) {
      return;
    }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  /** The only code path that acquires a child slot. */
  private pump(): void {
    if (this.stopped || this.releaseWrites > 0) {
      return;
    }
    while (this.active.size < this.maxConcurrent) {
      const daemon = this.nextDaemon();
      if (daemon) {
        this.startDaemon(daemon);
        continue;
      }
      const conversational = this.nextConversation();
      if (!conversational) {
        return;
      }
      this.startConversation(conversational.child, conversational.state);
    }
  }

  private nextDaemon(): ChildRecord | undefined {
    const monitorIndex = this.pendingDaemons.findIndex((child) => child.priority === "monitor");
    const index = monitorIndex === -1 ? 0 : monitorIndex;
    const child = this.pendingDaemons.splice(index, 1)[0];
    if (child) {
      this.pendingDaemonIds.delete(child.id);
    }
    return child;
  }

  private nextConversation(): { readonly child: ChildRecord; readonly state: ConversationalChildState } | undefined {
    for (const [childId, state] of this.conversations) {
      if (this.active.has(childId) || !state.request || (state.phase !== "queued" && state.phase !== "idle" && state.phase !== "cold")) {
        continue;
      }
      const child = this.childFor(childId);
      if (!child || child.kind !== "task_tool" || isTerminal(child.state)) {
        state.request = undefined;
        state.receiptWanted = false;
        state.phase = "terminated";
        continue;
      }
      return { child, state };
    }
    return undefined;
  }

  private startDaemon(admitted: ChildRecord): void {
    const controller = new AbortController();
    this.active.set(admitted.id, { child: admitted, controller });
    const execution = this.executeDaemon(admitted, controller).catch((error) => {
      this.event("lifecycle_failed", { childId: admitted.id, message: messageOf(error) });
    }).finally(() => {
      this.active.delete(admitted.id);
      this.executions.delete(admitted.id);
      this.schedulePump();
    });
    this.executions.set(admitted.id, execution);
  }

  private startConversation(admitted: ChildRecord, state: ConversationalChildState): void {
    const controller = new AbortController();
    const generation = ++state.generation;
    state.phase = "opening";
    state.controller = controller;
    this.active.set(admitted.id, { child: admitted, controller });
    let running: ChildRecord;
    try {
      running = this.options.registry.markRunning(admitted.id);
      this.remember(running);
    } catch (error) {
      this.active.delete(admitted.id);
      state.controller = undefined;
      state.phase = "terminated";
      this.event("lifecycle_failed", { childId: admitted.id, message: messageOf(error) });
      this.schedulePump();
      return;
    }
    this.event("running", { childId: running.id, kind: running.kind, origin: running.origin, priority: running.priority, runner: this.options.conversation.name });
    const startedAt = this.timestamp();
    const execution = this.serialize(state, () => this.executeConversation(running, state, generation, controller, startedAt)).catch((error) => {
      // Journal/store failures remain recoverable from the durable running row.
      this.event("terminal_not_exposed", { childId: running.id, message: messageOf(error) });
    }).finally(() => {
      this.active.delete(running.id);
      this.executions.delete(running.id);
      this.schedulePump();
    });
    this.executions.set(running.id, execution);
  }

  private async executeDaemon(admitted: ChildRecord, controller: AbortController): Promise<void> {
    const startedAt = this.timestamp();
    try {
      const child = this.options.registry.markRunning(admitted.id);
      this.remember(child);
      const runner = this.runnerFor(child);
      this.event("running", { childId: child.id, kind: child.kind, origin: child.origin, priority: child.priority, runner: runner.name });
      const result = await this.runWithTimeout(child, controller, runner);
      const admission = await this.publishTerminal(child, startedAt, result);
      this.remember(admission.child);
      this.event("receipt_persisted", { childId: child.id, receiptId: admission.receipt.id });
      this.notifyReceipt(admission.receipt);
    } catch (error) {
      this.event("terminal_not_exposed", { childId: admitted.id, message: messageOf(error) });
    }
  }

  private async openConversation(
    child: ChildRecord,
    signal: AbortSignal,
    needsResume: boolean,
  ): Promise<{ readonly conversation: ChildConversation; readonly generation: number }> {
    if (needsResume) {
      await assertReadableSessionFile(child.sessionFile);
    }
    return this.pool.open(child, signal);
  }

  private async executeConversation(
    child: ChildRecord,
    state: ConversationalChildState,
    generation: number,
    controller: AbortController,
    startedAt: string,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forced: ChildRunResult | undefined;
    let resolveForced!: (result: ChildRunResult) => void;
    const forcedPromise = new Promise<ChildRunResult>((resolve) => { resolveForced = resolve; });
    const force = (result: ChildRunResult): void => {
      if (forced !== undefined) {
        return;
      }
      forced = result;
      resolveForced(result);
    };
    const onAbort = (): void => {
      if (!forced) {
        force(cancelledResult("Background task was cancelled."));
      }
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) {
      onAbort();
    }
    timer = setTimeout(() => {
      const timeout = timeoutResult(child);
      forced = timeout;
      controller.abort();
      resolveForced(timeout);
    }, child.timeoutMs);

    const needsResume = state.request?.needsResume === true;
    const opened = this.openConversation(child, controller.signal, needsResume).then(
      (entry) => ({ kind: "opened" as const, entry }),
      (error) => ({ kind: "open_failed" as const, error }),
    );
    try {
      const opening = await Promise.race([
        opened,
        forcedPromise.then((result) => ({ kind: "forced" as const, result })),
      ]);
      if (opening.kind === "forced") {
        void opened.then((late) => {
          if (late.kind === "opened") {
            this.scheduleConversationDispose(child.id, late.entry.generation);
          }
        }).catch((error) => {
          this.event("child_dispose_failed", { childId: child.id, message: messageOf(error) });
        });
        await this.finishConversationTerminal(child, state, generation, opening.result, startedAt);
        return;
      }
      if (opening.kind === "open_failed") {
        const failure = state.cancelRequested ? cancelledResult("Background task was cancelled.") : (forced ?? openFailure(opening.error, controller.signal.aborted, needsResume));
        if (needsResume && forced === undefined) {
          this.event("child_resume_failed", { childId: child.id, message: messageOf(opening.error) });
        }
        await this.finishConversationTerminal(child, state, generation, failure, startedAt);
        return;
      }

      const entry = opening.entry;
      const request = this.transition(child.id, (current) => {
        if (current !== state || !this.matchesGeneration(current, generation) || (current.phase !== "opening" && current.phase !== "cancelling") || forced !== undefined) {
          return undefined;
        }
        current.conversation = entry.conversation;
        current.poolGeneration = entry.generation;
        if (current.cancelRequested) {
          return undefined;
        }
        current.phase = "running";
        const queued = current.request;
        if (!queued) {
          return undefined;
        }
        // A receipt:true nudge can arrive while opening; it must survive clearing request.
        current.receiptWanted = current.receiptWanted || queued.receipt;
        current.request = undefined;
        return queued;
      });
      if (!request) {
        if (forced || state.cancelRequested) {
          await this.finishConversationTerminal(child, state, generation, forced ?? cancelledResult("Background task was cancelled."), startedAt);
        } else {
          this.scheduleConversationDispose(child.id, entry.generation);
        }
        return;
      }
      if (request.needsResume) {
        this.event("child_resumed", { childId: child.id, sessionFile: child.sessionFile });
      }
      const turn = Promise.resolve()
        .then(() => entry.conversation.turn(request.prompt, controller.signal, (progress) => {
          try {
            this.remember(this.options.registry.updateProgress(child.id, progress));
          } catch {
            // The child may have been terminated while an SDK progress event was queued.
          }
        }))
        .then((result) => ({ kind: "turn" as const, result }), (error) => ({ kind: "turn_failed" as const, error }));
      const outcome = await Promise.race([
        turn,
        forcedPromise.then((result) => ({ kind: "forced" as const, result })),
      ]);
      if (state.cancelRequested) {
        await this.finishConversationTerminal(child, state, generation, cancelledResult("Background task was cancelled."), startedAt);
        return;
      }
      if (outcome.kind === "forced") {
        await this.finishConversationTerminal(child, state, generation, outcome.result, startedAt);
        return;
      }
      if (outcome.kind === "turn_failed") {
        await this.finishConversationTerminal(child, state, generation, forced ?? {
          state: controller.signal.aborted ? "cancelled" : "failed",
          summary: controller.signal.aborted ? "Background task was cancelled." : `Background task failed: ${messageOf(outcome.error)}`,
          errorCode: controller.signal.aborted ? "cancelled" : "child_runner_failed",
          errorMessage: messageOf(outcome.error),
        }, startedAt);
        return;
      }
      if (outcome.result.state === "completed") {
        this.finishConversationIdle(child, state, generation, outcome.result);
      } else {
        await this.finishConversationTerminal(child, state, generation, forced ?? turnResultToTerminal(outcome.result), startedAt);
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  private finishConversationIdle(
    child: ChildRecord,
    state: ConversationalChildState,
    generation: number,
    result: ChildTurnResult,
  ): void {
    const admission = this.transition(child.id, (current) => {
      if (current !== state || current.phase !== "running" || current.generation !== generation) {
        return undefined;
      }
      const publish = current.receiptWanted;
      current.receiptWanted = false;
      current.cancelRequested = false;
      current.cancelGeneration = undefined;
      const turnSeq = child.turnSeq + 1;
      const sessionFile = current.conversation?.sessionFile;
      const idle = publish
        ? this.options.registry.admitTurnReceipt(child, turnSeq, result.text, sessionFile)
        : { child: this.options.registry.markIdle(child.id, { ...(sessionFile === undefined ? {} : { sessionFile }), lastAssistantText: result.text, turnSeq }) };
      this.remember(idle.child);
      current.phase = "idle";
      current.idleSince = this.now().getTime();
      current.controller = undefined;
      this.event("child_idle", { childId: child.id, turnSeq, receipt: publish });
      return publish ? idle as TerminalAdmission : undefined;
    });
    if (admission) {
      this.event("receipt_persisted", { childId: child.id, receiptId: admission.receipt.id });
      this.notifyReceipt(admission.receipt);
    }
  }

  private async finishConversationTerminal(
    child: ChildRecord,
    state: ConversationalChildState,
    generation: number,
    terminal: ChildRunResult,
    startedAt: string,
  ): Promise<void> {
    const final = this.transition(child.id, (current) => {
      if (current !== state || !this.matchesGeneration(current, generation) || (current.phase !== "opening" && current.phase !== "running" && current.phase !== "cancelling")) {
        return undefined;
      }
      const droppedNudge = current.request !== undefined && !current.request.first;
      current.receiptWanted = false;
      current.cancelRequested = false;
      current.cancelGeneration = undefined;
      current.request = undefined;
      current.phase = "terminated";
      current.controller = undefined;
      current.idleSince = undefined;
      const poolGeneration = current.poolGeneration;
      const sessionFile = current.conversation?.sessionFile;
      current.poolGeneration = undefined;
      current.conversation = undefined;
      return {
        poolGeneration,
        sessionFile,
        result: droppedNudge ? { ...terminal, summary: `${terminal.summary}; 1 queued nudge was dropped` } : terminal,
      };
    });
    if (!final) {
      return;
    }
    try {
      const admission = await this.publishTerminal(child, startedAt, {
        ...final.result,
        ...(final.sessionFile === undefined ? {} : { sessionFile: final.sessionFile }),
      });
      this.remember(admission.child);
      this.event("receipt_persisted", { childId: child.id, receiptId: admission.receipt.id });
      this.notifyReceipt(admission.receipt);
    } finally {
      if (final.poolGeneration !== undefined) {
        this.scheduleConversationDispose(child.id, final.poolGeneration);
      }
    }
  }

  private scheduleConversationDispose(childId: string, generation: number): void {
    void this.disposePoolBounded(childId, generation).then((timedOut) => {
      if (timedOut) {
        this.event("child_dispose_timeout", { childId, timeoutMs: this.disposeTimeoutMs });
      }
    }, (error) => {
      this.event("child_dispose_failed", { childId, message: messageOf(error) });
    });
  }

  private async publishTerminal(
    child: ChildRecord,
    startedAt: string,
    result: ChildRunResult,
  ): Promise<TerminalAdmission> {
    const report = toTerminalReport(child, startedAt, this.timestamp(), result);
    // Journal publication is intentionally before both child terminal state and receipt admission.
    const journalPath = this.options.journal.writeTerminal(report);
    this.event("journal_written", { childId: child.id, checksum: report.checksum, journalPath });
    await holdForDrill("post-journal-pre-receipt");
    return this.options.registry.admitTerminal(report, journalPath);
  }

  private failAdmission(child: ChildRecord, error: unknown): void {
    const completedAt = this.timestamp();
    const report = createTerminalReport({
      childId: child.id,
      title: child.title,
      state: "cancelled",
      startedAt: child.createdAt,
      completedAt,
      summary: `Background task admission failed: ${messageOf(error)}`,
      errorCode: "child_admission_failed",
      errorMessage: messageOf(error),
    });
    try {
      const journalPath = this.options.journal.writeTerminal(report);
      const admission = this.options.registry.admitTerminal(report, journalPath);
      this.remember(admission.child);
      this.event("child_admission_failed", { childId: child.id, errorCode: report.errorCode });
      this.notifyReceipt(admission.receipt);
      return;
    } catch (publicationError) {
      try {
        this.remember(this.options.registry.markQueuedTerminated(child.id));
      } catch {
        // Preserve the original callback failure; reconcile can inspect the row.
      }
      this.event("terminal_not_exposed", { childId: child.id, message: messageOf(publicationError) });
    }
  }

  private async runWithTimeout(
    child: ChildRecord,
    controller: AbortController,
    runner: ChildRunner,
  ): Promise<ChildRunResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let settled = false;
    let timeoutResult: ChildRunResult | undefined;
    let resolveTimeout: ((value: ChildRunResult) => void) | undefined;
    let resolveCancelled: ((value: ChildRunResult) => void) | undefined;
    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const markSettled = (): void => {
      settled = true;
      clearTimer();
    };
    const armTimeout = (): void => {
      if (settled || timedOut || controller.signal.aborted) {
        return;
      }
      clearTimer();
      timer = setTimeout(() => {
        timer = undefined;
        if (settled || timedOut || controller.signal.aborted) {
          return;
        }
        timedOut = true;
        const terminal: ChildRunResult = {
          state: "timeout",
          summary: `Background task exceeded its ${Math.ceil(child.timeoutMs / 1_000)}s inactivity timeout.`,
          errorCode: "child_timeout",
          errorMessage: "child runner exceeded its configured inactivity timeout",
        };
        timeoutResult = terminal;
        markSettled();
        controller.abort();
        resolveTimeout?.(terminal);
      }, child.timeoutMs);
    };
    const cancelled = new Promise<ChildRunResult>((resolve) => {
      resolveCancelled = resolve;
    });
    const onAbort = (): void => {
      if (settled || timedOut) {
        return;
      }
      markSettled();
      resolveCancelled?.({
        state: "cancelled",
        summary: "Background task was cancelled.",
        errorCode: "cancelled",
        errorMessage: "child lifecycle cancelled the task",
      });
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) {
      onAbort();
    }

    const timeout = new Promise<ChildRunResult>((resolve) => {
      resolveTimeout = resolve;
      armTimeout();
    });
    const running: Promise<ChildRunResult> = Promise.resolve()
      .then(() => {
        if (settled || controller.signal.aborted) {
          return {
            state: "cancelled" as const,
            summary: "Background task was cancelled before its runner started.",
            errorCode: "cancelled",
            errorMessage: "child lifecycle cancelled the task before runner start",
          };
        }
        return runner.run({
          childId: child.id,
          title: child.title,
          prompt: child.prompt,
          onProgress: (progress) => {
            if (settled || timedOut || controller.signal.aborted) {
              return;
            }
            try {
              this.remember(this.options.registry.updateProgress(child.id, progress));
            } catch { /* child may have been reaped */ }
            armTimeout();
          },
        }, controller.signal);
      })
      .catch((error): ChildRunResult => ({
        state: controller.signal.aborted ? "cancelled" : "failed",
        summary: controller.signal.aborted ? "Background task was cancelled." : `Background task failed: ${messageOf(error)}`,
        errorCode: controller.signal.aborted ? "cancelled" : "child_runner_failed",
        errorMessage: messageOf(error),
      }));
    const observedRunning = running.then((result) => {
      if (!settled) {
        markSettled();
      }
      return result;
    });
    // A runner that ignores cancellation must not block durable timeout or
    // cancellation publication; it still receives the abort signal.
    try {
      const result = await Promise.race([observedRunning, timeout, cancelled]);
      if (!settled) {
        markSettled();
      }
      return timedOut && timeoutResult ? timeoutResult : result;
    } finally {
      markSettled();
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  private stateFor(child: ChildRecord): ConversationalChildState {
    const existing = this.conversations.get(child.id);
    if (existing) {
      return existing;
    }
    const phase = child.state === "idle"
      ? "idle"
      : child.state === "cold"
        ? "cold"
        : isTerminal(child.state)
          ? "terminated"
          : child.state === "running"
            ? "running"
            : "queued";
    const state = this.newConversationState(phase, phase === "queued" ? {
      prompt: child.prompt,
      receipt: true,
      first: true,
      needsResume: false,
    } : undefined);
    this.conversations.set(child.id, state);
    return state;
  }

  private newConversationState(
    phase: ConversationalChildState["phase"],
    request?: TurnRequest,
  ): ConversationalChildState {
    return {
      phase,
      generation: 0,
      mutex: Promise.resolve(),
      ...(request === undefined ? {} : { request }),
      receiptWanted: false,
      cancelRequested: false,
    };
  }

  private logicalTerminated(child: ChildRecord, reason: string): ChildRecord {
    const at = this.timestamp();
    return { ...child, state: "terminated", updatedAt: at, terminalAt: at, terminalSummary: reason };
  }

  private scheduleReleaseWrite(childId: string, write: () => ChildRecord): void {
    this.releaseWrites += 1;
    const attempt = (): void => {
      if (this.stopped) {
        this.releaseWrites -= 1;
        return;
      }
      queueMicrotask(() => {
        try {
          this.remember(write());
          this.releaseWrites -= 1;
          this.schedulePump();
        } catch (error) {
          this.event("child_termination_retry", { childId, reason: "released", message: messageOf(error), retryAfterMs: 1_000 });
          const timer = setTimeout(attempt, 1_000);
          timer.unref?.();
        }
      });
    };
    attempt();
  }

  private remember(child: ChildRecord): ChildRecord {
    this.children.set(child.id, child);
    this.options.onChildUpdated?.(child);
    return child;
  }

  private childFor(childId: string): ChildRecord | undefined {
    return this.children.get(childId);
  }

  /** Synchronous state mutations cannot interleave; asynchronous work is serialized per child. */
  private matchesGeneration(state: ConversationalChildState, generation: number): boolean {
    return state.generation === generation || (state.cancelRequested && state.cancelGeneration === generation);
  }

  private transition<T>(childId: string, mutation: (state: ConversationalChildState) => T): T {
    const state = this.conversations.get(childId);
    if (!state) {
      throw new Error(`unknown conversational child state: ${childId}`);
    }
    return mutation(state);
  }

  private serialize<T>(state: ConversationalChildState, work: () => Promise<T>): Promise<T> {
    const queued = state.mutex.then(work, work);
    state.mutex = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private coalesce(state: ConversationalChildState, text: string, receipt: boolean, needsResume: boolean): void {
    if (state.request) {
      state.request.prompt = `${state.request.prompt}\n\n${text}`;
      state.request.receipt = state.request.receipt || receipt;
      state.request.needsResume = state.request.needsResume || needsResume;
      return;
    }
    state.request = { prompt: text, receipt, first: false, needsResume };
  }

  private notifyReceipt(receipt: ReceiptRecord): void {
    if (!this.options.onReceipt) {
      return;
    }
    void Promise.resolve(this.options.onReceipt(receipt)).catch((error) => {
      this.event("receipt_follow_up_failed", { childId: receipt.childId, receiptId: receipt.id, message: messageOf(error) });
    });
  }

  private runnerFor(child: ChildRecord): ChildRunner {
    return this.options.daemonRunnerSelector?.(child) ?? this.options.daemonRunner ?? this.options.runner;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private event(event: string, fields: Record<string, unknown>): void {
    try {
      this.options.onEvent?.(event, fields);
    } catch {
      // Observability cannot alter lifecycle state or tool completion.
    }
  }
}

function toTerminalReport(
  child: ChildRecord,
  startedAt: string,
  completedAt: string,
  result: ChildRunResult,
): TerminalReport {
  return createTerminalReport({
    childId: child.id,
    title: child.title,
    state: result.state,
    startedAt,
    completedAt,
    summary: result.summary,
    ...(result.sessionFile === undefined ? {} : { sessionFile: result.sessionFile }),
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    ...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
  });
}

function cancelledResult(summary: string): ChildRunResult {
  return {
    state: "cancelled",
    summary,
    errorCode: "cancelled",
    errorMessage: "child lifecycle cancelled the task",
  };
}

function timeoutResult(child: ChildRecord): ChildRunResult {
  return {
    state: "timeout",
    summary: `Background task exceeded its ${Math.ceil(child.timeoutMs / 1_000)}s timeout.`,
    errorCode: "child_timeout",
    errorMessage: "child runner exceeded its configured timeout",
  };
}

function turnResultToTerminal(result: ChildTurnResult): ChildRunResult {
  if (result.state === "cancelled") {
    return {
      state: "cancelled",
      summary: "Background task was cancelled.",
      errorCode: result.errorCode ?? "cancelled",
      errorMessage: result.errorMessage ?? "child lifecycle cancelled the task",
    };
  }
  return {
    state: "failed",
    summary: `Background task failed: ${result.errorMessage ?? "child conversation failed"}`,
    errorCode: result.errorCode ?? "child_runner_failed",
    errorMessage: result.errorMessage ?? "child conversation failed",
  };
}

async function assertReadableSessionFile(sessionFile: string | undefined): Promise<void> {
  if (!sessionFile) {
    throw new Error("child session file is missing");
  }
  const details = await stat(sessionFile);
  if (!details.isFile() || details.size === 0) {
    throw new Error("child session file is missing or empty");
  }
}

async function hasReadableSessionFile(sessionFile: string | undefined): Promise<boolean> {
  try {
    await assertReadableSessionFile(sessionFile);
    return true;
  } catch {
    return false;
  }
}

function openFailure(error: unknown, aborted: boolean, needsResume: boolean): ChildRunResult {
  if (aborted) {
    return cancelledResult("Background task was cancelled.");
  }
  return {
    state: "failed",
    summary: needsResume ? `Background task resume failed: ${messageOf(error)}` : `Background task failed: ${messageOf(error)}`,
    errorCode: needsResume ? "resume_failed" : "child_runner_failed",
    errorMessage: messageOf(error),
  };
}

function isOpening(state: ConversationalChildState): boolean {
  return state.phase === "opening";
}

function isTerminal(state: ChildRecord["state"]): boolean {
  return state === "completed" || state === "failed" || state === "timeout" || state === "cancelled"
    || state === "orphaned" || state === "terminated";
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
