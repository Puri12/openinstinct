import type { ChildRecord, ChildState, StateStore } from "../store/index.ts";
import { truncateUtf8 } from "./utf8.ts";

export interface ChildStatusReader {
  getChild(childId: string): ChildRecord | undefined;
  listLiveChildren(limit?: number): ChildRecord[];
  countLiveChildren(): number;
  refresh?(): void;
}

/**
 * Store-backed cache for the synchronous main-session status tool. Production
 * callers refresh this snapshot from lifecycle mutation events; status reads
 * never enter SQLite or touch an omo engine session.
 */
export class StateStoreChildStatusReader implements ChildStatusReader {
  private children = new Map<string, ChildRecord>();

  public constructor(private readonly store: StateStore) {
    this.refresh();
  }

  public refresh(): void {
    this.children = new Map(this.store.listChildren().map((child) => [child.id, child]));
  }

  public update(child: ChildRecord): void {
    this.children.set(child.id, child);
  }

  public getChild(childId: string): ChildRecord | undefined {
    return this.children.get(childId);
  }

  public listLiveChildren(limit?: number): ChildRecord[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error("live child limit must be a positive safe integer");
    }
    const live = [...this.children.values()]
      .filter((child) => child.state === "requested" || child.state === "admitted" || child.state === "running" || child.state === "idle" || child.state === "cold")
      .sort((a, b) => {
        const activity = (b.lastActivityAt ?? b.updatedAt).localeCompare(a.lastActivityAt ?? a.updatedAt);
        return activity !== 0 ? activity : b.id.localeCompare(a.id);
      });
    return limit === undefined ? live : live.slice(0, limit);
  }

  public countLiveChildren(): number {
    let count = 0;
    for (const child of this.children.values()) {
      if (child.state === "requested" || child.state === "admitted" || child.state === "running" || child.state === "idle" || child.state === "cold") {
        count += 1;
      }
    }
    return count;
  }
}

export type PublicChildState = "running" | "idle" | "cold" | "terminated";

export interface ChildStatusDetail {
  readonly childId: string;
  readonly title: string;
  readonly state: PublicChildState;
  readonly queued?: boolean;
  readonly terminalState?: ChildState;
  readonly terminalReason?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly lastActivityAt?: string;
  readonly toolCalls: number;
  readonly tokens?: number;
  readonly turnSeq: number;
  readonly lastAssistantText?: string;
}

export function publicState(record: ChildRecord): Pick<ChildStatusDetail, "state" | "queued" | "terminalState" | "terminalReason"> {
  switch (record.state) {
    case "requested":
    case "admitted":
      return { state: "running", queued: true };
    case "running":
      return { state: "running" };
    case "idle":
      return { state: "idle" };
    case "cold":
      return { state: "cold" };
    case "completed":
    case "failed":
    case "timeout":
    case "cancelled":
    case "orphaned":
    case "terminated":
      return {
        state: "terminated",
        terminalState: record.state,
        ...(record.errorCode === undefined && record.terminalSummary === undefined
          ? {}
          : { terminalReason: record.errorCode ?? record.terminalSummary! }),
      };
  }
}

export function childStatusDetail(
  record: ChildRecord,
  statusTextMaxBytes: number,
  includeLastAssistantText: boolean,
): ChildStatusDetail {
  const publicFields = publicState(record);
  const visibleText = includeLastAssistantText
    && (publicFields.state === "running" || publicFields.state === "idle" || publicFields.state === "cold")
    && record.lastAssistantText !== undefined
    ? { lastAssistantText: truncateUtf8(record.lastAssistantText, statusTextMaxBytes) }
    : {};
  return {
    childId: record.id,
    title: record.title,
    ...publicFields,
    createdAt: record.createdAt,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.lastActivityAt === undefined ? {} : { lastActivityAt: record.lastActivityAt }),
    toolCalls: record.toolCalls,
    ...(record.tokens === undefined ? {} : { tokens: record.tokens }),
    turnSeq: record.turnSeq,
    ...visibleText,
  };
}

export function statusSummary(detail: Omit<ChildStatusDetail, "lastAssistantText">): string {
  return `${detail.childId}: ${detail.title} (${detail.state})`;
}
