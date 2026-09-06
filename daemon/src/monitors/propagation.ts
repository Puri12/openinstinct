import { randomUUID } from "node:crypto";

import type { OwnerReplyInput } from "../omo-session/main-session.ts";
import { isSafeOwnerText } from "../omo-session/owner-text.ts";
import { holdForDrill } from "../drills/hooks.ts";
import { MEMORY_CANONICALIZATION_PENDING_META_PREFIX } from "../memory/adapters/canonicalize.ts";

import type { ChildLifecycle } from "../children/lifecycle.ts";
import type {
  ChildRecord,
  ChildState,
  MonitorEventLease,
  MonitorEventRecord,
  MonitorEventStage,
  ReceiptRecord,
  StateStore,
} from "../store/index.ts";
import { MonitorStore } from "./store.ts";
import type { MonitorSpec, MonitorTriggerEvent } from "./types.ts";

const DEFAULT_LEASE_MS = 30_000;
const TRIAGE_RETRY_BACKOFF_MS = 1_000;

const FAILURE_STATES: ReadonlySet<ChildState> = new Set(["failed", "timeout", "orphaned"]);

type TriageEventContext = Pick<MonitorEventRecord, "eventType" | "payloadJson" | "catchUp"> & {
  readonly id?: string;
};

interface TriageOwnerResult {
  readonly kind: "message" | "silent" | "retry";
  readonly text?: string;
}

export interface MonitorPropagationOptions {
  readonly store: StateStore;
  readonly monitors: MonitorStore;
  readonly lifecycle: Pick<ChildLifecycle, "spawnDaemon">;
  readonly mainSession: {
    turn(prompt: string): Promise<{ readonly kind: "reply"; readonly text: string } | { readonly kind: "failed"; readonly code: string; readonly message: string }>;
    admitOwnerReply(input: OwnerReplyInput): { readonly id: string };
  };
  readonly ownerId?: string;
  readonly leaseMs?: number;
  readonly now?: () => Date;
  readonly isPaused?: () => boolean;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
}



/**
 * Durable monitor-event state machine. Every side effect is fenced by a lease
 * epoch, daemon child dispatches use monitor priority, and owner delivery uses
 * one fixed idempotency key per event.
 */
export class MonitorPropagation {
  private readonly now: () => Date;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private queue: Promise<void> = Promise.resolve();
  private leaseRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private leaseRetryAt: number | undefined;
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deferredMonitorEvents = new Map<string, number>();
  private readonly deferredReceipts = new Map<string, number>();
  private readonly triageRetries = new Map<string, number>();
  private stopped = false;

  public constructor(private readonly options: MonitorPropagationOptions) {
    this.now = options.now ?? (() => new Date());
    this.ownerId = options.ownerId ?? randomUUID();
    this.leaseMs = positiveDuration(options.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs");
  }

  public async admitTrigger(monitor: MonitorSpec, event: MonitorTriggerEvent): Promise<MonitorEventRecord> {
    if (this.stopped) {
      throw new Error("monitor propagation is stopped");
    }
    const admitted = this.options.monitors.admitEvent(monitor, event);
    this.event("admitted", {
      monitorId: monitor.id,
      monitorEventId: admitted.id,
      eventType: admitted.eventType,
      catchUp: admitted.catchUp,
    });
    await this.drain();
    return this.options.store.getMonitorEvent(admitted.id) ?? admitted;
  }

  /** Processes persisted admitted/batched/authored work and terminal child recovery. */
  public drain(): Promise<void> {
    const work = this.enqueue(async () => {
      if (this.stopped || this.options.isPaused?.()) {
        return;
      }
      await this.recoverDispatched();
      if (this.stopped) {
        return;
      }
      await this.recoverUncorrelatedReceipts();
      while (!this.stopped) {
        if (this.options.isPaused?.()) {
          return;
        }
        const next = this.options.store.listClaimableMonitorEvents(this.timestamp(), 100)
          .find((event) => !this.isDeferred(this.deferredMonitorEvents, event.id));
        if (!next) {
          return;
        }
        await this.processClaimable(next);
      }
    });
    void work.then(() => this.scheduleLeaseRetry(), () => this.scheduleLeaseRetry());
    return work;
  }

  /** Boot replay entrypoint. Safe to call repeatedly from a fresh process. */
  public reconcile(): Promise<void> {
    const work = this.enqueue(async () => {
      if (this.stopped) {
        return;
      }
      const exhausted = this.options.store.failExhaustedAuthoredMonitorEvents(this.timestamp());
      if (exhausted > 0) {
        this.event("triage_exhausted_recovered", { count: exhausted });
      }
      if (this.options.isPaused?.()) {
        return;
      }
      await this.recoverDispatched();
      if (this.stopped) {
        return;
      }
      await this.recoverUncorrelatedReceipts();
      while (!this.stopped) {
        if (this.options.isPaused?.()) {
          return;
        }
        const next = this.options.store.listClaimableMonitorEvents(this.timestamp(), 100)
          .find((event) => !this.isDeferred(this.deferredMonitorEvents, event.id));
        if (!next) {
          return;
        }
        await this.processClaimable(next);
      }
    });
    void work.then(() => this.scheduleLeaseRetry(), () => this.scheduleLeaseRetry());
    return work;
  }
  /** Returns true when a receipt belongs to a live monitor event and is consumed here. */
  public async onChildReceipt(receipt: ReceiptRecord): Promise<boolean> {
    if (this.stopped) {
      return false;
    }
    const event = this.options.store.getMonitorEventByChildId(receipt.childId);
    if (!event || event.stage === "failed") {
      return false;
    }
    await this.enqueue(async () => {
      if (this.stopped) {
        return;
      }
      await this.completeDispatched(event.id);
      if (this.stopped) {
        return;
      }
      const settled = this.options.store.getMonitorEvent(event.id);
      if (settled?.stage === "delivered" && typeof receipt.id === "string" && receipt.id.length > 0 && receipt.state !== "delivered" && this.options.store.getReceipt(receipt.id)) {
        this.options.store.markReceiptDelivered(receipt.id, this.timestamp());
      }
    });
    return !this.stopped;
  }

  /** Consumes terminal monitor/memory receipts without a live event correlation. */
  public async onUncorrelatedChildReceipt(receipt: ReceiptRecord): Promise<boolean> {
    if (this.stopped) {
      return false;
    }
    const child = this.options.store.getChild(receipt.childId);
    if (!child || (child.origin !== "monitor" && child.origin !== "memory")) {
      return false;
    }
    const event = this.options.store.getMonitorEventByChildId(child.id);
    if (event && event.stage !== "failed") {
      return false;
    }
    if (child.origin === "memory" && this.options.store.getMeta(`${MEMORY_CANONICALIZATION_PENDING_META_PREFIX}${child.id}`) !== undefined) {
      return false;
    }
    if (receipt.state === "delivered" || this.isDeferred(this.deferredReceipts, receipt.id)) {
      return true;
    }
    await this.enqueue(() => this.triageUncorrelated(child, receipt));
    return !this.stopped;
  }

  public stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.deferredMonitorEvents.clear();
    this.deferredReceipts.clear();
    this.triageRetries.clear();
    this.clearLeaseRetry();
  }

  private clearLeaseRetry(): void {
    if (this.leaseRetryTimer) {
      clearTimeout(this.leaseRetryTimer);
    }
    this.leaseRetryTimer = undefined;
    this.leaseRetryAt = undefined;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    const pending = this.queue.then(async () => {
      if (this.stopped) {
        return;
      }
      await work();
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private scheduleLeaseRetry(): void {
    if (this.stopped || this.options.isPaused?.()) {
      this.clearLeaseRetry();
      return;
    }
    const now = this.now().getTime();
    let events: MonitorEventRecord[];
    try {
      events = this.options.store.listMonitorEvents();
    } catch {
      this.clearLeaseRetry();
      return;
    }
    const nextExpiry = events
      .filter((event) => isClaimableStage(event.stage) && event.leaseExpiresAt !== undefined)
      .map((event) => Date.parse(event.leaseExpiresAt!))
      .filter((value) => Number.isFinite(value) && value > now)
      .sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) {
      this.clearLeaseRetry();
      return;
    }
    if (this.leaseRetryTimer && this.leaseRetryAt !== undefined && this.leaseRetryAt <= nextExpiry) {
      return;
    }
    this.clearLeaseRetry();
    this.leaseRetryAt = nextExpiry;
    this.leaseRetryTimer = setTimeout(() => {
      if (this.stopped) {
        return;
      }
      this.leaseRetryTimer = undefined;
      this.leaseRetryAt = undefined;
      void this.drain().catch((error) => {
        if (this.stopped) {
          return;
        }
        this.event("lease_retry_failed", { message: messageOf(error) });
      });
    }, Math.max(1, nextExpiry - now + 1));
  }

  private async recoverDispatched(): Promise<void> {
    for (const event of this.options.store.listDispatchedMonitorEvents()) {
      if (this.stopped) {
        return;
      }
      await this.completeDispatched(event.id);
    }
  }

  private async recoverUncorrelatedReceipts(): Promise<void> {
    for (const receipt of this.options.store.listPersistedReceipts({ origin: ["monitor", "memory"] })) {
      if (this.stopped) {
        return;
      }
      const child = this.options.store.getChild(receipt.childId);
      if (!child || !isTerminal(child)) {
        continue;
      }
      const event = this.options.store.getMonitorEventByChildId(child.id);
      if (event && event.stage !== "failed") {
        await this.completeDispatched(event.id);
        if (this.stopped) {
          return;
        }
        const settled = this.options.store.getMonitorEvent(event.id);
        if (settled?.stage === "delivered" && receipt.state !== "delivered") {
          this.options.store.markReceiptDelivered(receipt.id, this.timestamp());
        }
        continue;
      }
      if (child.origin === "memory" && this.options.store.getMeta(`${MEMORY_CANONICALIZATION_PENDING_META_PREFIX}${child.id}`) !== undefined) {
        continue;
      }
      await this.triageUncorrelated(child, receipt);
    }
  }

  private async triageUncorrelated(child: ChildRecord, receipt: ReceiptRecord): Promise<void> {
    if (this.stopped || receipt.state === "delivered" || this.isDeferred(this.deferredReceipts, receipt.id)) {
      return;
    }
    if (!FAILURE_STATES.has(child.state)) {
      this.event("uncorrelated_receipt_ignored", {
        childId: child.id,
        origin: child.origin,
        state: child.state,
        ...(child.errorCode === undefined ? {} : { code: child.errorCode }),
      });
      if (!this.stopped) {
        this.options.store.markReceiptDelivered(receipt.id, this.timestamp());
      }
      return;
    }
    const monitor = this.options.monitors.list().find((candidate) => `Monitor: ${candidate.name}` === child.title);
    const context: TriageEventContext = {
      eventType: "child_recovery",
      payloadJson: JSON.stringify({
        childId: child.id,
        origin: child.origin,
        state: child.state,
        errorCode: child.errorCode ?? null,
        reason: receipt.projection,
      }),
      catchUp: false,
    };
    const outcome = await this.composeOwnerText(monitor, context, child);
    if (this.stopped) {
      return;
    }
    if (outcome.kind === "retry") {
      this.event("uncorrelated_receipt_retry", { childId: child.id, origin: child.origin });
      this.deferReceiptRetry(child, receipt, "triage_retry");
      return;
    }
    if (outcome.kind === "message") {
      try {
        this.admitOwnerReply({
          idempotencyKey: `child-recovery:${receipt.id}`,
          text: outcome.text!,
          childId: child.id,
        });
      } catch (error) {
        if (this.stopped) {
          return;
        }
        this.event("uncorrelated_receipt_retry", { childId: child.id, origin: child.origin, message: messageOf(error) });
        this.deferReceiptRetry(child, receipt, "owner_delivery_failed");
        return;
      }
    }
    if (this.stopped) {
      return;
    }
    this.options.store.markReceiptDelivered(receipt.id, this.timestamp());
    this.event("uncorrelated_receipt_triaged", {
      childId: child.id,
      origin: child.origin,
      state: child.state,
      ...(child.errorCode === undefined ? {} : { code: child.errorCode }),
      silent: outcome.kind === "silent",
    });
  }


  private deferReceiptRetry(child: ChildRecord, receipt: ReceiptRecord, reason: string): void {
    if (this.stopped) {
      return;
    }
    const now = this.now().getTime();
    this.deferredReceipts.set(receipt.id, (Number.isFinite(now) ? now : Date.now()) + TRIAGE_RETRY_BACKOFF_MS);
    if (reason === "triage_retry") {
      this.event("triage_retryable", { childId: child.id, receiptId: receipt.id, reason });
    }
    this.scheduleRetry(`receipt:${receipt.id}`, () => {
      if (this.stopped) {
        return;
      }
      this.deferredReceipts.delete(receipt.id);
      const current = this.options.store.getReceipt(receipt.id);
      if (!current || current.state === "delivered") {
        return;
      }
      void this.onUncorrelatedChildReceipt(current).catch((error) => {
        if (this.stopped) {
          return;
        }
        this.event("triage_retry_failed", { childId: child.id, receiptId: receipt.id, message: messageOf(error) });
      });
    }, reason);
  }

  private scheduleRetry(key: string, retry: () => void, reason: string): void {
    if (this.stopped || this.retryTimers.has(key)) {
      return;
    }
    this.event("triage_retry_scheduled", { key, reason, retryAfterMs: TRIAGE_RETRY_BACKOFF_MS });
    const timer = setTimeout(() => {
      if (this.stopped) {
        return;
      }
      this.retryTimers.delete(key);
      retry();
    }, TRIAGE_RETRY_BACKOFF_MS);
    timer.unref?.();
    this.retryTimers.set(key, timer);
  }

  private isDeferred(retries: Map<string, number>, key: string): boolean {
    const retryAt = retries.get(key);
    if (retryAt === undefined) {
      return false;
    }
    const now = this.now().getTime();
    if (Number.isFinite(now) && now >= retryAt) {
      retries.delete(key);
      return false;
    }
    return true;
  }

  private async completeDispatched(eventId: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    const event = this.options.store.getMonitorEvent(eventId);
    if (!event || event.stage !== "dispatched" || !event.childId) {
      return;
    }
    const child = this.options.store.getChild(event.childId);
    if (!child || !isTerminal(child)) {
      return;
    }
    const claimed = this.claim(event.id, ["dispatched"]);
    if (!claimed || this.stopped) {
      return;
    }
    try {
      const authored = this.options.store.transitionMonitorEvent({
        lease: leaseOf(claimed),
        expectedStage: "dispatched",
        nextStage: "authored",
        now: this.timestamp(),
        ...(child.errorCode === undefined ? {} : { lastErrorCode: child.errorCode }),
        releaseLease: false,
      });
      if (!authored || this.stopped) {
        return;
      }
      this.event("authored", { monitorEventId: authored.id, childId: child.id, childState: child.state });
      await this.deliverAuthored(authored);
    } catch (error) {
      if (!this.stopped) {
        this.fail(claimed, error);
      }
    }
  }

  private async processClaimable(candidate: MonitorEventRecord): Promise<void> {
    if (this.stopped || this.options.isPaused?.()) {
      return;
    }
    const claimed = this.claim(candidate.id, [candidate.stage]);
    if (!claimed || this.stopped) {
      return;
    }
    try {
      switch (claimed.stage) {
        case "admitted": {
          const batched = this.options.store.transitionMonitorEvent({
            lease: leaseOf(claimed),
            expectedStage: "admitted",
            nextStage: "batched",
            now: this.timestamp(),
            releaseLease: false,
          });
          if (batched && !this.stopped) {
            this.event("batched", { monitorEventId: batched.id, monitorId: batched.monitorId });
            await this.dispatchBatched(batched);
          }
          return;
        }
        case "batched":
          await this.dispatchBatched(claimed);
          return;
        case "authored":
          await this.deliverAuthored(claimed);
          return;
        default:
          return;
      }
    } catch (error) {
      if (!this.stopped) {
        this.fail(claimed, error);
      }
    }
  }

  private async dispatchBatched(event: MonitorEventRecord): Promise<void> {
    if (this.stopped) {
      return;
    }
    const monitor = this.options.monitors.get(event.monitorId);
    if (!monitor || !monitor.enabled) {
      const failed = this.options.store.transitionMonitorEvent({
        lease: leaseOf(event),
        expectedStage: "batched",
        nextStage: "failed",
        now: this.timestamp(),
        releaseLease: true,
        lastErrorCode: monitor ? "monitor_disabled" : "monitor_missing",
        lastErrorMessage: monitor ? "monitor was disabled before dispatch" : "monitor no longer exists",
      });
      if (failed) {
        this.event("failed", { monitorEventId: failed.id, code: failed.lastErrorCode });
      }
      return;
    }

    let dispatched: MonitorEventRecord | undefined;
    const child = this.options.lifecycle.spawnDaemon({
      title: `Monitor: ${monitor.name}`,
      prompt: childPrompt(monitor, event),
      origin: "monitor",
      timeoutMs: timeoutMilliseconds(monitor.timeoutSec),
      priority: "monitor",
      onAdmitted: (admittedChild) => {
        if (this.stopped) {
          return;
        }
        dispatched = this.options.store.transitionMonitorEvent({
          lease: leaseOf(event),
          expectedStage: "batched",
          nextStage: "dispatched",
          now: this.timestamp(),
          childId: admittedChild.id,
          releaseLease: true,
        });
        if (!dispatched) {
          throw new Error(`monitor event dispatch fencing failed: ${event.id}`);
        }
      },
    });
    if (dispatched) {
      this.event("dispatched", {
        monitorEventId: dispatched.id,
        monitorId: dispatched.monitorId,
        childId: child.id,
        epoch: event.epoch,
      });
    }
  }

  /** Returns a safe owner message, or an explicit retry/silence decision. */
  private async composeOwnerText(
    monitor: MonitorSpec | undefined,
    event: TriageEventContext,
    child: ChildRecord | undefined,
  ): Promise<TriageOwnerResult> {
    const reference = event.id ?? child?.id ?? "uncorrelated";
    if (this.stopped) {
      return { kind: "retry" };
    }
    let first: Awaited<ReturnType<typeof this.options.mainSession.turn>>;
    try {
      first = await this.options.mainSession.turn(triagePrompt(monitor, event, child));
    } catch (error) {
      if (this.stopped) {
        return { kind: "retry" };
      }
      this.event("triage_turn_failed", { monitorEventId: reference, code: errorCodeOf(error), message: messageOf(error) });
      return { kind: "retry" };
    }
    if (this.stopped) {
      return { kind: "retry" };
    }
    if (first.kind !== "reply") {
      this.event("triage_turn_failed", { monitorEventId: reference, code: first.code });
      return { kind: "retry" };
    }
    let candidate = first.text.trim();
    if (candidate === SILENT_MARKER || candidate.length === 0) {
      this.event("triage_silent", { monitorEventId: reference });
      return { kind: "silent" };
    }
    let safe = safeTriageText(candidate, event, child);
    if (safe === undefined) {
      if (this.stopped) {
        return { kind: "retry" };
      }
      let retry: Awaited<ReturnType<typeof this.options.mainSession.turn>>;
      try {
        retry = await this.options.mainSession.turn(rephrasePrompt(monitor, event, child));
      } catch (error) {
        if (this.stopped) {
          return { kind: "retry" };
        }
        this.event("triage_turn_failed", { monitorEventId: reference, code: errorCodeOf(error), message: messageOf(error) });
        return { kind: "retry" };
      }
      if (this.stopped) {
        return { kind: "retry" };
      }
      if (retry.kind !== "reply") {
        this.event("triage_turn_failed", { monitorEventId: reference, code: retry.code });
        return { kind: "retry" };
      }
      candidate = retry.text.trim();
      if (candidate === SILENT_MARKER || candidate.length === 0) {
        return { kind: "silent" };
      }
      safe = safeTriageText(candidate, event, child);
    }
    if (safe !== undefined) {
      return { kind: "message", text: safe };
    }
    this.event("triage_rephrased_unsafely", { monitorEventId: reference });
    return { kind: "retry" };
  }

  private async deliverAuthored(event: MonitorEventRecord): Promise<void> {
    if (this.stopped) {
      return;
    }
    const monitor = this.options.monitors.get(event.monitorId);
    if (!monitor) {
      const failed = this.options.store.transitionMonitorEvent({
        lease: leaseOf(event),
        expectedStage: "authored",
        nextStage: "failed",
        now: this.timestamp(),
        releaseLease: true,
        lastErrorCode: "monitor_missing",
        lastErrorMessage: "monitor no longer exists",
      });
      if (failed) {
        this.triageRetries.delete(event.id);
        this.event("failed", { monitorEventId: failed.id, code: "monitor_missing" });
      }
      return;
    }
    const child = event.childId === undefined ? undefined : this.options.store.getChild(event.childId);
    const intentKey = `monitor-event:${event.id}`;
    const outcome = await this.composeOwnerText(monitor, event, child);
    if (this.stopped) {
      return;
    }
    if (outcome.kind === "retry") {
      this.event("owner_delivery_deferred", { monitorEventId: event.id, reason: "triage_retry" });
      this.scheduleAuthoredRetry(event, "triage_retry");
      return;
    }
    if (outcome.kind === "silent") {
      const delivered = this.options.store.transitionMonitorEvent({
        lease: leaseOf(event),
        expectedStage: "authored",
        nextStage: "delivered",
        deliveryIntentKey: intentKey,
        now: this.timestamp(),
        releaseLease: true,
      });
      if (delivered) {
        this.triageRetries.delete(event.id);
        this.event("delivered", { monitorEventId: delivered.id, intentKey, silent: true });
      }
      return;
    }
    let delivery: { readonly id: string };
    try {
      delivery = this.options.mainSession.admitOwnerReply({
        idempotencyKey: intentKey,
        text: outcome.text!,
        ...(event.childId === undefined ? {} : { childId: event.childId }),
      });
    } catch (error) {
      if (this.stopped) {
        return;
      }
      this.event("owner_delivery_deferred", { monitorEventId: event.id, reason: "owner_delivery_failed", message: messageOf(error) });
      this.scheduleAuthoredRetry(event, "owner_delivery_failed");
      return;
    }
    if (this.stopped) {
      return;
    }
    const deliveryId = delivery.id.length > 0 && this.options.store.getDelivery(delivery.id) ? delivery.id : undefined;
    await holdForDrill("mid-propagation");
    if (this.stopped) {
      return;
    }
    if (event.childId !== undefined) {
      this.options.store.markPersistedReceiptsForChildDelivered(event.childId, this.timestamp());
    }
    if (this.stopped) {
      return;
    }
    const delivered = this.options.store.transitionMonitorEvent({
      lease: leaseOf(event),
      expectedStage: "authored",
      nextStage: "delivered",
      now: this.timestamp(),
      ...(deliveryId === undefined ? {} : { deliveryId }),
      deliveryIntentKey: intentKey,
      releaseLease: true,
    });
    if (delivered) {
      this.triageRetries.delete(event.id);
      this.event("delivered", {
        monitorEventId: delivered.id,
        ...(deliveryId === undefined ? { dropped: true } : { deliveryId }),
        intentKey,
      });
    }
  }

  private scheduleAuthoredRetry(event: MonitorEventRecord, reason: string): void {
    if (this.stopped) {
      return;
    }
    const attempt = (this.triageRetries.get(event.id) ?? 0) + 1;
    this.triageRetries.set(event.id, attempt);
    if (attempt >= 3) {
      const exhausted = this.options.store.transitionMonitorEvent({
        lease: leaseOf(event),
        expectedStage: "authored",
        nextStage: "failed",
        now: this.timestamp(),
        releaseLease: true,
        lastErrorCode: "triage_exhausted",
        lastErrorMessage: "main-session triage retry exhausted",
      });
      if (exhausted) {
        this.event("failed", { monitorEventId: exhausted.id, code: "triage_exhausted", attempts: attempt });
      }
      return;
    }
    this.event("triage_retryable", { monitorEventId: event.id, reason, attempt, maxAttempts: 3 });
    this.scheduleRetry(`authored:${event.id}`, () => {
      if (this.stopped) {
        return;
      }
      let current: MonitorEventRecord | undefined;
      try {
        current = this.options.store.getMonitorEvent(event.id);
      } catch {
        return;
      }
      if (!current || current.stage !== "authored" || current.leaseOwner !== event.leaseOwner || current.leaseId !== event.leaseId || current.epoch !== event.epoch) {
        return;
      }
      void this.enqueue(async () => {
        if (this.stopped) {
          return;
        }
        let latest: MonitorEventRecord | undefined;
        try {
          latest = this.options.store.getMonitorEvent(event.id);
        } catch {
          return;
        }
        if (!latest || latest.stage !== "authored" || latest.leaseOwner !== event.leaseOwner || latest.leaseId !== event.leaseId || latest.epoch !== event.epoch) {
          return;
        }
        await this.deliverAuthored(latest);
      }).catch((error) => {
        if (!this.stopped) {
          this.event("triage_retry_failed", { monitorEventId: event.id, message: messageOf(error) });
        }
      });
    }, reason);
  }
  private admitOwnerReply(input: OwnerReplyInput): { readonly id: string } {
    return this.options.mainSession.admitOwnerReply(input);
  }

  private claim(id: string, stages: readonly MonitorEventStage[]): MonitorEventRecord | undefined {
    if (this.stopped) {
      return undefined;
    }
    const now = this.now();
    return this.options.store.claimMonitorEvent(
      id,
      stages,
      this.ownerId,
      randomUUID(),
      new Date(now.getTime() + this.leaseMs).toISOString(),
      now.toISOString(),
    );
  }

  private fail(event: MonitorEventRecord, error: unknown): void {
    if (this.stopped) {
      return;
    }
    const failed = this.options.store.failMonitorEvent(
      leaseOf(event),
      this.timestamp(),
      "propagation_failed",
      messageOf(error),
    );
    this.event("failed", {
      monitorEventId: event.id,
      attempts: event.attempts,
      terminal: failed?.stage === "failed",
      message: messageOf(error),
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private event(event: string, fields: Record<string, unknown>): void {
    if (this.stopped) {
      return;
    }
    this.options.onEvent?.(event, fields);
  }
}

function leaseOf(event: MonitorEventRecord): MonitorEventLease {
  if (!event.leaseOwner || !event.leaseId || event.epoch < 1) {
    throw new Error(`monitor event has no active lease: ${event.id}`);
  }
  return { id: event.id, owner: event.leaseOwner, leaseId: event.leaseId, epoch: event.epoch };
}

function childPrompt(monitor: MonitorSpec, event: MonitorEventRecord): string {
  return [
    `You are executing monitor “${monitor.name}”.`,
    "Never read ~/.openinstinct/children, ~/.openinstinct/logs, ~/.openinstinct/omo, session .jsonl transcripts, state.db, env, or secrets: they are huge and off-limits; anything you need from the past is in ~/.openinstinct/memory via memory_search. Keep total tool output small.",
    "Return a concise factual owner update as plain text (it is sent as an iMessage: no Markdown, no lists, no code fences). Do not send messages directly.",
    `Instruction: ${monitor.instruction}`,
    `Event type: ${event.eventType}`,
    `Event payload: ${event.payloadJson}`,
    event.catchUp ? "This is one coalesced boot catch-up event." : "",
  ].filter(Boolean).join("\n");
}

const SILENT_MARKER = "[[no-owner-message]]";
export const TRIAGE_PROMPT_PREFIX = "Monitor ";

function triagePrompt(monitor: MonitorSpec | undefined, event: TriageEventContext, child: ChildRecord | undefined): string {
  const timeout = isChildTimeout(child);
  const failed = child === undefined || child.state !== "completed";
  const heading = monitor
    ? (timeout
      ? `${TRIAGE_PROMPT_PREFIX}"${monitor.name}" (id ${monitor.id}) TIMED OUT due to inactivity. Assess it before you say anything to the owner.`
      : failed
        ? `${TRIAGE_PROMPT_PREFIX}"${monitor.name}" (id ${monitor.id}) FAILED. Triage it before you say anything to the owner.`
        : `${TRIAGE_PROMPT_PREFIX}"${monitor.name}" (id ${monitor.id}) produced a result. Relay it to the owner.`)
    : child === undefined
      ? `${TRIAGE_PROMPT_PREFIX}Background task FAILED after a restart. Triage it before you say anything to the owner.`
      : `${TRIAGE_PROMPT_PREFIX}Background task “${child.title}” (${child.origin} child) FAILED after a restart. Triage it before you say anything to the owner.`;
  const lines = [heading];
  if (monitor) {
    lines.push(
      `Schedule: ${formatTrigger(monitor)}; time zone ${monitor.tz}; timeout ${monitor.timeoutSec}s.`,
      `Instruction the monitor runs: ${monitor.instruction}`,
    );
  }
  lines.push(
    `Event: ${event.eventType}${event.catchUp ? " (coalesced boot catch-up)" : ""}; payload ${event.payloadJson}`,
    child === undefined
      ? "Child evidence: none (the monitor child never produced a terminal report)."
      : `Child state: ${child.state}${child.errorCode ? `; error code ${child.errorCode}` : ""}. Summary: ${child.terminalSummary ?? "(none)"}`,
  );
  if (failed) {
    lines.push(
      timeout
        ? `Assess the inactivity timeout, recover what you can (including correcting the monitor if needed), or explain why no recovery is safe. Then write the owner ONE short plain-text message. If no owner update is warranted, reply with exactly ${SILENT_MARKER} and nothing else. Never paste raw error codes, payload JSON, stack traces, file paths, receipt projections, or raw state tokens at the owner.`
        : monitor
          ? "Do this, in order: (1) work out the likely cause from the error code, summary, and instruction; (2) if it is something you can fix yourself — a bad instruction, a cron expression or time zone that cannot be right, a timeout that is too short, a schedule that fires too often — fix it now with monitor_author (update or disable), and note in memory_capture what you changed and why; (3) then write the owner ONE short plain-text message: what the monitor was for, what went wrong in a sentence, and what you already did about it or what you need from them. Never paste raw error codes, payload JSON, stack traces, file paths, receipt projections, or raw state tokens at the owner."
          : "Do this, in order: (1) work out the likely cause from the child evidence; (2) take any safe recovery action available; (3) only when the owner must decide something, write ONE short natural-language message describing the decision needed. Never paste raw error codes, payload JSON, stack traces, file paths, receipt projections, or raw state tokens at the owner.",
      "Receipt evidence is internal triage context only. The persistent main session is the sole owner-facing author; background workers never send owner messages directly.",
      `If the failure is transient, recovered, or needs nothing from the owner, reply with exactly ${SILENT_MARKER} and nothing else so no message is sent.`,
    );
  } else {
    lines.push(
      "Write the owner one short plain-text message with the useful content of the result. No headers, no lists, no Markdown. Do not mention that this came from a monitor unless it matters.",
    );
  }
  return lines.join("\n");
}

function safeTriageText(text: string, event: TriageEventContext, child: ChildRecord | undefined): string | undefined {
  const candidate = text.trim();
  if (!candidate || candidate === SILENT_MARKER) {
    return undefined;
  }
  const payloadFields = payloadSensitiveFields(event.payloadJson);
  const fragments = [
    child?.errorCode,
    child?.terminalSummary,
    child?.journalPath,
    child?.sessionFile,
    event.payloadJson,
    parseReason(event.payloadJson),
    ...payloadFields,
    ...payloadFields.flatMap(knownSensitiveTokens),
  ];
  return isSafeOwnerText(candidate, {
    forbiddenFragments: fragments,
    rejectInternalTokens: true,
  }) ? candidate : undefined;
}

function payloadSensitiveFields(payloadJson: string): string[] {
  const fields: string[] = [];
  try {
    collectSensitiveStrings(JSON.parse(payloadJson) as unknown, fields);
  } catch {
    // Trigger payloads are not required to be JSON objects in older rows.
  }
  return fields;
}

function knownSensitiveTokens(value: string): string[] {
  return Array.from(value.matchAll(/\b(?:session_file_missing|liveness_unprovable|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi), (match) => match[0]!);
}

function collectSensitiveStrings(value: unknown, fields: string[], key = ""): void {
  if (typeof value === "string") {
    if (/^(?:code|errorCode|errorMessage|reason|journalPath|sessionFile|artifactPath|projection|state)$/i.test(key)) {
      fields.push(value);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSensitiveStrings(item, fields, key);
    }
    return;
  }
  for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
    collectSensitiveStrings(entry, fields, entryKey);
  }
}

function rephrasePrompt(monitor: MonitorSpec | undefined, event: TriageEventContext, child: ChildRecord | undefined): string {
  return `${triagePrompt(monitor, event, child)}\n\nYour previous draft was unsafe. Rephrase without raw tokens/paths; preserve the actionable user decision. Do not quote receipt evidence.`;
}

function parseReason(payloadJson: string): string | undefined {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    return payload !== null && typeof payload === "object" && typeof (payload as { readonly reason?: unknown }).reason === "string"
      ? (payload as { readonly reason: string }).reason
      : undefined;
  } catch {
    return undefined;
  }
}

function isChildTimeout(child: ChildRecord | undefined): boolean {
  return child?.state === "timeout" || child?.errorCode === "child_timeout";
}

function formatTrigger(monitor: MonitorSpec): string {
  const t = monitor.trigger;
  switch (t.kind) {
    case "cron": return `cron ${t.expression}`;
    case "webhook": return "webhook";
    case "watcher": return `watcher over ${t.roots.length} root(s)`;
    case "script": return `script every ${t.intervalMs}ms`;
  }
}


function isTerminal(child: ChildRecord): boolean {
  return child.state === "completed" || child.state === "failed" || child.state === "timeout"
    || child.state === "cancelled" || child.state === "orphaned" || child.state === "terminated";
}

function isClaimableStage(stage: MonitorEventStage): boolean {
  return stage === "admitted" || stage === "batched" || stage === "authored";
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function timeoutMilliseconds(timeoutSec: number): number {
  const milliseconds = timeoutSec * 1_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new Error("monitor timeoutSec cannot be represented in milliseconds");
  }
  return milliseconds;
}
function errorCodeOf(error: unknown): string {
  if (error !== null && typeof error === "object" && typeof (error as { readonly code?: unknown }).code === "string") {
    return (error as { readonly code: string }).code;
  }
  return "triage_turn_failed";
}

function messageOf(error: unknown): string {
  return Array.from(error instanceof Error ? error.message : String(error)).slice(0, 500).join("");
}
