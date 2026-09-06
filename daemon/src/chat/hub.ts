import type { JsonObject } from "../control/schema.ts";
import type { NdjsonLogger } from "../log.ts";

export type OwnerSource = "imessage" | "panel";

export const PANEL_SOURCE_MARKER = "[sent from the Chat window]";

export interface ChatMessage {
  readonly role: "owner" | "assistant";
  readonly source?: OwnerSource;
  readonly text?: string;
  readonly image?: { readonly path: string; readonly caption: string };
  readonly at: string;
  readonly turnId?: string;
  readonly final?: boolean;
}

export interface ChatPresence {
  readonly source: OwnerSource;
  readonly turnId: string;
  readonly typing?: boolean;
  readonly read?: boolean;
  readonly at: string;
}

export type ChatEventSink = (topic: "chat.message" | "chat.presence", payload: JsonObject) => void;

export class ChatHub {
  private sequence = 0;
  private readonly sinks = new Set<ChatEventSink>();

  public constructor(private readonly logger?: NdjsonLogger) {}

  public subscribe(sink: ChatEventSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  public message(message: ChatMessage): number {
    const seq = this.nextSequence();
    const payload: JsonObject = {
      seq,
      role: message.role,
      ...(message.source === undefined ? {} : { source: message.source }),
      ...(message.text === undefined ? {} : { text: message.text }),
      ...(message.image === undefined ? {} : { image: { path: message.image.path, caption: message.image.caption } }),
      at: message.at,
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      ...(message.final === undefined ? {} : { final: message.final }),
    };
    this.emit("chat.message", payload);
    return seq;
  }

  public presence(presence: ChatPresence): number {
    const seq = this.nextSequence();
    const payload: JsonObject = {
      seq,
      source: presence.source,
      turnId: presence.turnId,
      ...(presence.typing === undefined ? {} : { typing: presence.typing }),
      ...(presence.read === undefined ? {} : { read: presence.read }),
      at: presence.at,
    };
    this.emit("chat.presence", payload);
    return seq;
  }

  public get lastSeq(): number {
    return this.sequence;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private emit(topic: "chat.message" | "chat.presence", payload: JsonObject): void {
    for (const sink of [...this.sinks]) {
      try {
        sink(topic, payload);
      } catch (error) {
        this.sinks.delete(sink);
        try {
          this.logger?.write("error", "chat", "subscriber_failed", {
            topic,
            message: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // A logger failure must not make a subscriber failure observable to callers.
        }
      }
    }
  }
}
