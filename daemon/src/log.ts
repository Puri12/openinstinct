import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface LogEntry extends LogFields {
  readonly level: LogLevel;
  readonly ts: string;
  readonly module: string;
  readonly event: string;
}

export class NdjsonLogger {
  public constructor(private readonly path: string) {}

  public write(level: LogLevel, module: string, event: string, fields: LogFields = {}): void {
    const entry: LogEntry = {
      ...fields,
      level,
      ts: new Date().toISOString(),
      module,
      event,
    };

    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }
}
