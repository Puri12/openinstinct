export type ChildTurnState = "completed" | "failed" | "cancelled";

export interface ChildTurnResult {
  readonly state: ChildTurnState;
  readonly text: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface ChildReport {
  readonly text: string;
  readonly toolCallId: string;
  readonly truncated?: boolean;
}

export interface ChildReportOutcome {
  readonly accepted: boolean;
  readonly truncated?: boolean;
  readonly bytes?: number;
  readonly reason?: "rate_limited";
  readonly retryAfterSec?: number;
}

export interface ChildConversation {
  readonly sessionFile: string | undefined;
  readonly promptHash?: string;
  turn(
    prompt: string,
    signal: AbortSignal,
    onProgress: (progress: { readonly tokens?: number; readonly toolCalls?: number }) => void,
  ): Promise<ChildTurnResult>;
  /** Void-fired; implementations report failures through their onEvent callback. */
  steer(text: string): void;
  lastAssistantText(): string;
  dispose(): Promise<void>;
}

export interface ConversationalChildRunner {
  readonly name: string;
  open(input: {
    readonly childId: string;
    readonly title: string;
    readonly sessionFile?: string;
    readonly onReport?: (report: ChildReport) => ChildReportOutcome;
  }, signal: AbortSignal): Promise<ChildConversation>;
}
