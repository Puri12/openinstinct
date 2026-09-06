import { randomUUID } from "node:crypto";

import { holdForDrill } from "../drills/hooks.ts";
import {
  DEFAULT_CHILD_INTERIM_BATCH_MS,
  DEFAULT_CHILD_INTERIM_MAX_BYTES,
  DEFAULT_CHILD_INTERIM_RATE_PER_MINUTE,
} from "../runtime-config.ts";
import type { InterimBatchRecord, StateStore } from "../store/index.ts";
import type { MainTurnInput, MainTurnResult } from "../omo-session/main-session.ts";
import { truncateUtf8, utf8Bytes } from "./utf8.ts";

export interface InterimTurnDelivery {
  readonly turnId?: string;
  readonly deliveryId?: string;
  readonly turnKind?: MainTurnResult["kind"];
}

export interface InterimTurner {
  readonly busy: boolean;
  steer(input: MainTurnInput): Promise<boolean>;
  turn(prompt: string): Promise<MainTurnResult>;
  onTurnDelivered(listener: (delivery: InterimTurnDelivery) => void): void | (() => void);
  currentOwnerTurnId?(): string | undefined;
  transcriptContains?(marker: string): boolean;
  readonly messages?: unknown;
}

export interface InterimDeliveryAdmitter {
  admitOwnerReply(input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }): { readonly id?: string };
}

export interface InterimAdmission {
  readonly accepted: boolean;
  readonly truncated?: boolean;
  readonly bytes?: number;
  readonly reason?: "rate_limited";
  readonly retryAfterSec?: number;
}

export interface InterimInboxOptions {
  readonly store: StateStore;
  readonly mainSession: InterimTurner & { admitOwnerReply(input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }): { readonly id?: string } };
  readonly batchMs?: number;
  readonly ratePerMinute?: number;
  readonly maxBytes?: number;
  readonly now?: () => Date;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Durable, child-only progress delivery. Admissions never invoke the main
 * session; a timer collects them into one serialized background follow-up.
 */
export class InterimInbox {
  private readonly now: () => Date;
  private readonly batchMs: number;
  private readonly ratePerMinute: number;
  private readonly maxBytes: number;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly windows = new Map<string, number[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private serial: Promise<void> = Promise.resolve();
  private stopped = false;

  public constructor(private readonly options: InterimInboxOptions) {
    this.now = options.now ?? (() => new Date());
    this.batchMs = positiveInteger(options.batchMs ?? DEFAULT_CHILD_INTERIM_BATCH_MS, "interim batchMs");
    this.ratePerMinute = positiveInteger(
      options.ratePerMinute ?? DEFAULT_CHILD_INTERIM_RATE_PER_MINUTE,
      "interim ratePerMinute",
    );
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_CHILD_INTERIM_MAX_BYTES, "interim maxBytes");
  }

  /** Synchronously persists one report or its durable omission count. */
  public admit(input: {
    readonly childId: string;
    readonly title: string;
    readonly text: string;
    readonly toolCallId: string;
    readonly truncated?: boolean;
  }): InterimAdmission {
    const now = this.now();
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("interim clock is invalid");
    }
    const idempotencyKey = `interim:${input.childId}:${input.toolCallId}`;
    const existing = this.options.store.getInterimMessageByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.batchId === undefined) {
        this.arm();
      }
      return { accepted: true, truncated: existing.truncated, bytes: utf8Bytes(existing.body) };
    }

    const window = (this.windows.get(input.childId) ?? []).filter((at) => nowMs - at < 60_000);
    this.windows.set(input.childId, window);
    if (window.length >= this.ratePerMinute) {
      const omitted = this.options.store.incrementInterimOmitted(input.childId, now.toISOString());
      const retryAfterSec = Math.max(1, Math.ceil((window[0]! + 60_000 - nowMs) / 1_000));
      this.event("interim_dropped", { childId: input.childId, omitted, retryAfterSec });
      this.arm();
      return { accepted: false, reason: "rate_limited", retryAfterSec };
    }

    const body = truncateUtf8(input.text, this.maxBytes);
    const truncated = input.truncated === true || body !== input.text;
    const message = this.options.store.admitInterimMessage({
      id: randomUUID(),
      childId: input.childId,
      idempotencyKey,
      body,
      truncated,
    }, now.toISOString());
    window.push(nowMs);
    this.windows.set(input.childId, window);
    this.event("interim_persisted", {
      childId: input.childId,
      messageId: message.id,
      truncated,
      bytes: utf8Bytes(body),
    });
    this.arm();
    return { accepted: true, truncated, bytes: utf8Bytes(body) };
  }

  /** Runs one durable assignment and main-session admission at a time. */
  public flush(): Promise<void> {
    if (this.flushing) {
      return this.flushing;
    }
    this.clearTimer();
    const prior = this.serial;
    let run!: Promise<void>;
    run = prior.then(() => this.flushOne(), () => this.flushOne()).finally(() => {
      if (this.flushing === run) {
        this.flushing = undefined;
      }
      if (!this.stopped && (this.options.store.listUnbatchedInterim().length > 0 || this.hasOmittedInterim())) {
        this.arm();
      }
    });
    this.serial = run.catch(() => undefined);
    this.flushing = run;
    return run;
  }

  /** Replays durable work after child recovery has established the live registry. */
  public replay(): Promise<void> {
    const prior = this.serial;
    const run = prior.then(() => this.replayOne(), () => this.replayOne());
    this.serial = run.catch(() => undefined);
    return run;
  }

  private async replayOne(): Promise<void> {
    for (const batch of this.options.store.listInterimBatches("injected")) {
      const existingDelivery = this.options.store.getDeliveryByIdempotencyKey(`interim-batch:${batch.id}`);
      if (existingDelivery) {
        this.deliver(batch.id, { deliveryId: existingDelivery.id, outcome: "owner_text" });
        continue;
      }
      if (this.transcriptContains(markerFor(batch.id))) {
        this.deliver(batch.id, { outcome: "reply_lost" });
        this.event("interim_reply_lost", { batchId: batch.id });
        continue;
      }
      this.event("interim_replayed", { batchId: batch.id, attempt: batch.attempt + 1 });
      await this.injectAsTurn(batch);
    }

    for (const batch of this.options.store.listInterimBatches("assigned")) {
      this.event("interim_replayed", { batchId: batch.id, attempt: batch.attempt + 1 });
      await this.injectAsTurn(batch);
    }

    if (this.options.store.listUnbatchedInterim().length > 0 || this.hasOmittedInterim()) {
      await this.flushOne();
    }
  }

  public stop(): void {
    this.stopped = true;
    this.clearTimer();
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  private async flushOne(): Promise<void> {
    const assignment = this.options.store.assignInterimBatch(this.now().toISOString());
    if (!assignment) {
      return;
    }
    this.event("interim_batch_assigned", { batchId: assignment.batch.id, count: assignment.messages.length });
    if (this.options.mainSession.busy && this.options.mainSession.currentOwnerTurnId?.() !== undefined) {
      await this.injectAsSteer(assignment.batch);
      return;
    }
    await this.injectAsTurn(assignment.batch);
  }

  private async injectAsSteer(batch: InterimBatchRecord): Promise<void> {
    const ownerTurnId = this.options.mainSession.currentOwnerTurnId?.();
    if (ownerTurnId === undefined) {
      await this.injectAsTurn(batch);
      return;
    }
    const waiter = this.waitForOwnerDelivery(ownerTurnId);
    const injected = this.options.store.markInterimBatchInjected(
      batch.id,
      "steer",
      this.now().toISOString(),
      ownerTurnId,
    );
    this.event("interim_batch_injected", { batchId: injected.id, mode: "steer", attempt: injected.attempt });
    await holdForDrill("mid-interim-batch");
    try {
      const steered = await this.options.mainSession.steer({
        owner: false,
        text: `[Background task update, not from the owner] ${injected.prompt}`,
      });
      if (!steered) {
        waiter.cancel();
        await this.injectAsTurn(injected);
        return;
      }
      const delivery = await waiter.promise;
      if (delivery.turnKind === "failed") {
        await this.injectAsTurn(injected);
        return;
      }
      this.deliver(injected.id, {
        outcome: "owner_text",
        ...(delivery.deliveryId === undefined ? {} : { deliveryId: delivery.deliveryId }),
      });
    } catch (error) {
      waiter.cancel();
      this.event("interim_batch_failed", { batchId: injected.id, mode: "steer", message: messageOf(error) });
      this.retryUnseen(injected.id);
    }
  }

  private async injectAsTurn(batch: InterimBatchRecord): Promise<void> {
    let injected: InterimBatchRecord | undefined;
    try {
      injected = this.options.store.markInterimBatchInjected(batch.id, "turn", this.now().toISOString());
      this.event("interim_batch_injected", { batchId: injected.id, mode: "turn", attempt: injected.attempt });
      await holdForDrill("mid-interim-batch");

      let result: MainTurnResult;
      try {
        result = await this.options.mainSession.turn([
          injected.prompt,
          "If the owner should hear this, say it in one plain line; otherwise reply exactly [[no-owner-message]].",
        ].join("\n\n"));
      } catch (error) {
        this.event("interim_batch_failed", { batchId: injected.id, mode: "turn", message: messageOf(error) });
        this.retryUnseen(injected.id);
        return;
      }
      if (result.kind === "failed") {
        this.event("interim_batch_failed", { batchId: injected.id, mode: "turn", code: result.code, message: result.message });
        this.retryUnseen(injected.id);
        return;
      }
      let text = result.text.trim();
      if (text === "[[no-owner-message]]") {
        this.deliver(injected.id, { outcome: "silent" });
        return;
      }
      let admitted: { readonly id?: string };
      try {
        admitted = this.admitOwnerReply({ idempotencyKey: `interim-batch:${injected.id}`, text });
      } catch (error) {
        this.event("interim_batch_rephrase", { batchId: injected.id, message: messageOf(error) });
        try {
          result = await this.options.mainSession.turn(`${injected.prompt}\n\nYour previous draft was unsafe. Rephrase without raw tokens/paths; preserve only the actionable owner decision, or reply exactly [[no-owner-message]].`);
        } catch (retryError) {
          this.event("interim_batch_failed", { batchId: injected.id, mode: "turn", message: messageOf(retryError) });
          this.retryUnseen(injected.id);
          return;
        }
        if (result.kind === "failed") {
          this.event("interim_batch_failed", { batchId: injected.id, mode: "turn", code: result.code, message: result.message });
          this.retryUnseen(injected.id);
          return;
        }
        text = result.text.trim();
        if (text === "[[no-owner-message]]") {
          this.deliver(injected.id, { outcome: "silent" });
          return;
        }
        try {
          admitted = this.admitOwnerReply({ idempotencyKey: `interim-batch:${injected.id}`, text });
        } catch (retryError) {
          this.event("interim_batch_rephrased_unsafely", { batchId: injected.id, message: messageOf(retryError) });
          this.retryUnseen(injected.id);
          return;
        }
      }
      this.deliver(injected.id, { outcome: "owner_text", ...(admitted.id === undefined || admitted.id.length === 0 ? {} : { deliveryId: admitted.id }) });
    } catch (error) {
      if (injected !== undefined) {
        this.event("interim_batch_failed", { batchId: injected.id, mode: "turn", message: messageOf(error) });
        this.retryUnseen(injected.id);
        return;
      }
      throw error;
    }
  }

  private admitOwnerReply(input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }): { readonly id?: string } {
    return this.options.mainSession.admitOwnerReply(input);
  }

  private waitForOwnerDelivery(ownerTurnId: string | undefined): {
    readonly promise: Promise<InterimTurnDelivery>;
    readonly cancel: () => void;
  } {
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    let resolve!: (delivery: InterimTurnDelivery) => void;
    const promise = new Promise<InterimTurnDelivery>((done) => {
      resolve = done;
    });
    const finish = (delivery: InterimTurnDelivery): void => {
      if (settled || (ownerTurnId !== undefined && delivery.turnId !== ownerTurnId)) {
        return;
      }
      settled = true;
      unsubscribe?.();
      resolve(delivery);
    };
    const registered = this.options.mainSession.onTurnDelivered(finish);
    unsubscribe = typeof registered === "function" ? registered : undefined;
    if (settled) {
      unsubscribe?.();
    }
    return {
      promise,
      cancel: () => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe?.();
      },
    };
  }

  private deliver(
    batchId: string,
    input: { readonly deliveryId?: string; readonly outcome: "owner_text" | "silent" | "reply_lost" },
  ): void {
    const delivered = this.options.store.markInterimBatchDelivered(batchId, input, this.now().toISOString());
    this.event("interim_batch_delivered", { batchId: delivered.id, outcome: input.outcome });
  }

  private retryUnseen(batchId: string): void {
    if (this.stopped) {
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (this.stopped) {
        return;
      }
      const batch = this.options.store.getInterimBatch(batchId);
      if (!batch || batch.state !== "injected") {
        return;
      }
      if (this.transcriptContains(markerFor(batch.id))) {
        this.deliver(batch.id, { outcome: "reply_lost" });
        this.event("interim_reply_lost", { batchId: batch.id });
        return;
      }
      void this.injectAsTurn(batch).catch((error) => {
        this.event("interim_batch_failed", { batchId: batch.id, mode: "turn", message: messageOf(error) });
      });
    }, this.batchMs);
    this.retryTimers.add(timer);
  }

  private transcriptContains(marker: string): boolean {
    if (this.options.mainSession.transcriptContains) {
      return this.options.mainSession.transcriptContains(marker);
    }
    return containsMarker(this.options.mainSession.messages, marker);
  }

  private hasOmittedInterim(): boolean {
    return this.options.store.listChildren().some((child) => child.interimOmitted > 0);
  }

  private arm(): void {
    if (this.stopped || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error) => {
        this.event("interim_flush_failed", { message: messageOf(error) });
      });
    }, this.batchMs);
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private event(event: string, fields: Record<string, unknown>): void {
    this.options.onEvent?.(event, fields);
  }
}

function markerFor(batchId: string): string {
  return `[interim-batch ${batchId}]`;
}

function containsMarker(value: unknown, marker: string, seen = new Set<object>()): boolean {
  if (typeof value === "string") {
    return value.includes(marker);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsMarker(entry, marker, seen));
  }
  return Object.values(value as Record<string, unknown>).some((entry) => containsMarker(entry, marker, seen));
}



function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
