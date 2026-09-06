import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { StateStore } from "../store/index.ts";

const MAC_EPOCH_MS = Date.UTC(2001, 0, 1);

export interface InboundAttachment {
  readonly path: string;
  readonly mime: string | undefined;
  readonly transferName: string | undefined;
}

export interface InboundMessage {
  readonly guid: string;
  readonly rowid: number;
  readonly senderHandle: string | undefined;
  readonly text: string;
  readonly isFromMe: boolean;
  readonly threadOriginatorGuid: string | undefined;
  readonly replyToGuid: string | undefined;
  readonly attachments: readonly InboundAttachment[];
  readonly timestamp: string;
}

export interface InboundMessageReader {
  readNewMessages(): InboundMessage[];
  advanceCursor(rowid: number): void;
}

interface ChatRow {
  readonly rowid: number;
  readonly guid: string | null;
  readonly sender_handle: string | null;
  readonly text: string | null;
  readonly attributed_body: Uint8Array | null;
  readonly is_from_me: number;
  readonly timestamp: number | bigint | string | null;
  readonly thread_originator_guid: string | null;
  readonly associated_message_guid: string | null;
  readonly attachment_path: string | null;
  readonly attachment_mime: string | null;
  readonly attachment_transfer_name: string | null;
}

interface MutableMessage {
  readonly message: Omit<InboundMessage, "attachments">;
  readonly attachments: InboundAttachment[];
  readonly attachmentKeys: Set<string>;
}

export interface ChatDbReaderOptions {
  readonly chatDbPath?: string;
  readonly store: StateStore;
  /** Fired when the cursor is (re)anchored at the present instead of read. */
  readonly onCursorAnchored?: (event: { readonly cursor: number; readonly reason: "first_contact" | "identity_changed" }) => void;
}

/**
 * Opens a fresh read-only connection for every cursor query. This leaves WAL
 * discovery to SQLite and intentionally avoids immutable=1, which would hide
 * uncheckpointed Messages writes.
 */
export class ChatDbReader implements InboundMessageReader {
  private readonly chatDbPath: string;

  public constructor(private readonly options: ChatDbReaderOptions) {
    this.chatDbPath = options.chatDbPath ?? join(homedir(), "Library", "Messages", "chat.db");
  }

  /** `after` overrides the persisted cursor as the read position (never lower than it). */
  public readNewMessages(after?: number): InboundMessage[] {
    const db = new Database(this.chatDbPath, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      // The cursor is a bare ROWID, so it is only meaningful against the chat.db
      // it was taken from. Bind it to a fingerprint (path + earliest row guid)
      // and re-anchor whenever the identity changes: a different macOS user or a
      // wiped Messages library must never inherit a stale offset, which would
      // either replay history or silently skip rows.
      const fingerprint = chatDbFingerprint(db, this.chatDbPath);
      const bound = this.options.store.getMeta(CHAT_FINGERPRINT_META);
      let cursor = this.options.store.getChatCursor();
      if (cursor === undefined || bound !== fingerprint) {
        // First contact (or identity change): anchor at the present. Replaying
        // the owner's message history as fresh prompts is never acceptable.
        const row = db.query("SELECT max(ROWID) AS rowid FROM message").get() as { readonly rowid: number | null };
        cursor = row.rowid ?? 0;
        this.options.store.setChatCursor(cursor);
        this.options.store.setMeta(CHAT_FINGERPRINT_META, fingerprint);
        this.options.onCursorAnchored?.({
          cursor,
          reason: bound === undefined ? "first_contact" : "identity_changed",
        });
        return [];
      }
      if (after !== undefined && after > cursor) cursor = after;
      const rows = db.query(`
        SELECT
          m.ROWID AS rowid,
          m.guid AS guid,
          h.id AS sender_handle,
          m.text AS text,
          m.attributedBody AS attributed_body,
          m.is_from_me AS is_from_me,
          m.date AS timestamp,
          m.thread_originator_guid AS thread_originator_guid,
          m.associated_message_guid AS associated_message_guid,
          a.filename AS attachment_path,
          a.mime_type AS attachment_mime,
          a.transfer_name AS attachment_transfer_name
        FROM message AS m
        LEFT JOIN handle AS h ON h.ROWID = m.handle_id
        LEFT JOIN chat_message_join AS cmj ON cmj.message_id = m.ROWID
        LEFT JOIN chat AS c ON c.ROWID = cmj.chat_id
        LEFT JOIN message_attachment_join AS maj ON maj.message_id = m.ROWID
        LEFT JOIN attachment AS a ON a.ROWID = maj.attachment_id
        WHERE m.ROWID > ?
        ORDER BY m.ROWID ASC, a.ROWID ASC
      `).all(cursor) as ChatRow[];
      return groupRows(rows);
    } finally {
      db.close();
    }
  }

  public advanceCursor(rowid: number): void {
    this.options.store.setChatCursor(rowid);
  }
}

export const CHAT_FINGERPRINT_META = "imessage.chat_db_fingerprint";

function chatDbFingerprint(db: Database, path: string): string {
  const first = db.query("SELECT guid FROM message ORDER BY ROWID ASC LIMIT 1").get() as { readonly guid: string | null } | null;
  return `${path}\u0000${first?.guid ?? ""}`;
}

/**
 * Binds the store's cursor to `chatDbPath` at `cursor`. Test seam for suites
 * that write chat.db before boot and deliberately want those rows replayed;
 * production never calls this.
 */
export function bindChatCursor(store: StateStore, chatDbPath: string, cursor: number): void {
  const db = new Database(chatDbPath, { readonly: true });
  try {
    store.setMeta(CHAT_FINGERPRINT_META, chatDbFingerprint(db, chatDbPath));
    store.setChatCursor(cursor);
  } finally {
    db.close();
  }
}

/**
 * Since macOS 13, Messages stores the body in `attributedBody` (a typedstream
 * NSAttributedString) and leaves `text` NULL for most rows. Extract the leading
 * NSString payload: after the "NSString" class marker comes 0x01 0x94 0x84 0x01
 * then either 0x2B <len> <utf8> (len < 128) or 0x2B 0x81 <len16 LE> <utf8>.
 */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string | undefined {
  if (!blob || blob.length === 0) {
    return undefined;
  }
  const marker = Buffer.from("NSString");
  const buffer = Buffer.from(blob);
  const at = buffer.indexOf(marker);
  if (at < 0) {
    return undefined;
  }
  let index = at + marker.length;
  // Skip class-chain bytes until the length-prefix opcode 0x2B ('+').
  while (index < buffer.length && buffer[index] !== 0x2b) {
    index += 1;
  }
  if (index >= buffer.length) {
    return undefined;
  }
  index += 1;
  let length = buffer[index]!;
  index += 1;
  if (length === 0x81) {
    length = buffer.readUInt16LE(index);
    index += 2;
  } else if (length === 0x82) {
    length = buffer.readUInt32LE(index);
    index += 4;
  }
  if (index + length > buffer.length) {
    return undefined;
  }
  return buffer.subarray(index, index + length).toString("utf8");
}

function groupRows(rows: readonly ChatRow[]): InboundMessage[] {
  const grouped = new Map<number, MutableMessage>();

  for (const row of rows) {
    let entry = grouped.get(row.rowid);
    if (!entry) {
      entry = {
        message: {
          guid: row.guid ?? "",
          rowid: row.rowid,
          senderHandle: row.sender_handle ?? undefined,
          text: row.text ?? decodeAttributedBody(row.attributed_body) ?? "",
          isFromMe: row.is_from_me === 1,
          threadOriginatorGuid: row.thread_originator_guid ?? undefined,
          replyToGuid: row.associated_message_guid ?? undefined,
          timestamp: messageTimestamp(row.timestamp),
        },
        attachments: [],
        attachmentKeys: new Set(),
      };
      grouped.set(row.rowid, entry);
    }

    const attachment = toAttachment(row);
    if (attachment) {
      const key = `${attachment.path}\u0000${attachment.mime ?? ""}\u0000${attachment.transferName ?? ""}`;
      if (!entry.attachmentKeys.has(key)) {
        entry.attachmentKeys.add(key);
        entry.attachments.push(attachment);
      }
    }
  }

  return [...grouped.values()].map(({ message, attachments }) => ({ ...message, attachments }));
}

function toAttachment(row: ChatRow): InboundAttachment | undefined {
  if (row.attachment_path === null || row.attachment_path.length === 0) {
    return undefined;
  }

  return {
    path: normalizeAttachmentPath(row.attachment_path),
    mime: row.attachment_mime ?? undefined,
    transferName: row.attachment_transfer_name ?? undefined,
  };
}

function normalizeAttachmentPath(path: string): string {
  if (path.startsWith("file://")) {
    try {
      return fileURLToPath(path);
    } catch {
      return path;
    }
  }
  if (path === "~") {
    return homedir();
  }
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function messageTimestamp(value: ChatRow["timestamp"]): string {
  const raw = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(raw)) {
    return new Date(MAC_EPOCH_MS).toISOString();
  }

  const absolute = Math.abs(raw);
  const milliseconds = absolute >= 1e15
    ? raw / 1e6
    : absolute >= 1e12
      ? raw / 1e3
      : absolute >= 1e10
        ? raw
        : raw * 1_000;
  const date = new Date(MAC_EPOCH_MS + milliseconds);
  return Number.isNaN(date.getTime()) ? new Date(MAC_EPOCH_MS).toISOString() : date.toISOString();
}
