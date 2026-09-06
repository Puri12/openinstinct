export type ChildTerminalState = "completed" | "failed" | "timeout" | "cancelled";

export interface ChildRunRequest {
  readonly childId: string;
  readonly title: string;
  readonly prompt: string;
  /** Optional live progress sink (tokens in context, tool calls so far). */
  readonly onProgress?: (progress: { readonly tokens?: number; readonly toolCalls?: number }) => void;
}

export interface ChildRunResult {
  readonly state: ChildTerminalState;
  readonly summary: string;
  readonly sessionFile?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * Process-neutral adapter contract. Lifecycle ownership of timeouts and durable
 * terminal publication is deliberately outside runner implementations.
 */
export interface ChildRunner {
  readonly name: string;
  run(request: ChildRunRequest, signal: AbortSignal): Promise<ChildRunResult>;
}
