export interface AcceptanceInterimMessage {
  readonly body: string;
  readonly createdAt: string;
}

export function isPromptHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function hasCadenceReport(
  messages: readonly AcceptanceInterimMessage[],
  token: string,
  startedAt?: string,
): boolean {
  return messages.some((message) => message.body.includes(token)
    && (startedAt === undefined || message.createdAt >= startedAt));
}
