import type { NdjsonLogger } from "../log.ts";
import type { DeliveryRecord } from "../store/index.ts";
import type { DeliveryService, OutboundDelivery } from "./service.ts";

export type OwnerOutbound = Omit<OutboundDelivery, "handle">;

export interface OutboxBinding {
  readonly turnId: string;
  readonly handle: string | undefined;
  readonly generation: number;
  readonly attachedAtBind: boolean;
  admit(outbound: OwnerOutbound): DeliveryRecord | undefined;
  markRead(): Promise<boolean>;
  setTyping(on: boolean): Promise<boolean>;
}

/**
 * Routes owner-bound effects through the currently attached iMessage lane.
 * A binding captures one lane generation so a turn cannot resume mirroring to
 * a replacement lane after detach/attach.
 */
export class OwnerOutbox {
  private delivery: DeliveryService | undefined;
  private ownerHandle: string | undefined;
  private laneGeneration = 0;
  // Keep the reason on detach so drops explain why the optional lane is down.
  private detachReason = "detached";

  public constructor(private readonly deps: { readonly logger: NdjsonLogger }) {}

  public attach(delivery: DeliveryService, handle: string): void {
    if (this.delivery !== undefined && this.ownerHandle === handle) {
      return;
    }
    this.delivery = delivery;
    this.ownerHandle = handle;
    this.laneGeneration += 1;
  }

  /** A reason argument keeps detached proactive/turn drops diagnosable. */
  public detach(reason = "detached"): void {
    this.detachReason = reason;
    if (this.delivery === undefined) {
      return;
    }
    this.delivery = undefined;
    this.ownerHandle = undefined;
    this.laneGeneration += 1;
  }

  public get attached(): boolean {
    return this.delivery !== undefined;
  }

  public get handle(): string | undefined {
    return this.ownerHandle;
  }

  public get generation(): number {
    return this.laneGeneration;
  }

  public bind(turnId: string): OutboxBinding {
    const generation = this.laneGeneration;
    const handle = this.ownerHandle;
    const delivery = this.delivery;
    const attachedAtBind = delivery !== undefined;
    const detachReason = this.detachReason;

    return {
      turnId,
      handle,
      generation,
      attachedAtBind,
      admit: (outbound) => {
        if (!attachedAtBind) {
          this.logSkipped(outbound, {
            turnId,
            reason: "detached_at_turn_start",
            detachReason,
          });
          return undefined;
        }
        if (this.laneGeneration !== generation) {
          this.logSkipped(outbound, {
            turnId,
            reason: "lane_changed",
            boundGeneration: generation,
            generation: this.laneGeneration,
          });
          return undefined;
        }
        return delivery!.admit({ ...outbound, handle: handle! });
      },
      markRead: async () => {
        if (!attachedAtBind || this.laneGeneration !== generation) {
          return false;
        }
        await delivery!.markRead(handle!);
        return true;
      },
      setTyping: async (on) => {
        if (!attachedAtBind || this.laneGeneration !== generation) {
          return false;
        }
        await delivery!.setTyping(handle!, on);
        return true;
      },
    };
  }

  public admit(outbound: OwnerOutbound): DeliveryRecord | undefined {
    const delivery = this.delivery;
    const handle = this.ownerHandle;
    if (delivery === undefined || handle === undefined) {
      this.logSkipped(outbound, {
        reason: "detached",
        detachReason: this.detachReason,
      });
      return undefined;
    }
    return delivery.admit({ ...outbound, handle });
  }

  private logSkipped(
    outbound: OwnerOutbound,
    fields: {
      readonly turnId?: string;
      readonly reason: "detached" | "detached_at_turn_start" | "lane_changed";
      readonly detachReason?: string;
      readonly boundGeneration?: number;
      readonly generation?: number;
    },
  ): void {
    this.deps.logger.write("info", "delivery", "delivery_skipped_no_imessage_lane", {
      idempotencyKey: outbound.idempotencyKey,
      kind: outboundKind(outbound),
      ...fields,
    });
  }
}

function outboundKind(outbound: OwnerOutbound): "text" | "filePath" | "segment" {
  if (outbound.filePath !== undefined) {
    return "filePath";
  }
  return outbound.idempotencyKey.startsWith("segment:") ? "segment" : "text";
}
