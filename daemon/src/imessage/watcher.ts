import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { InboundMessage, InboundMessageReader } from "./reader.ts";

export interface ImessageWatcherOptions {
  readonly reader: InboundMessageReader;
  readonly onMessages: (messages: readonly InboundMessage[]) => void | Promise<void>;
  readonly gate: () => boolean;
  readonly chatDbPath?: string;
  readonly debounceMs?: number;
  readonly pollIntervalMs?: number;
  readonly onError?: (error: Error) => void;
}

/**
 * Watches the directory rather than an individual SQLite file so WAL and SHM
 * writes wake the reader too. The poll timer is intentionally retained when
 * fs.watch is unavailable or coalesces an event.
 */
export class ImessageWatcher {
  private readonly chatDbPath: string;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly watchedNames: ReadonlySet<string>;
  private watcher: FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private flushing = false;
  private wakeAgain = false;
  private activeFlush: Promise<void> | undefined;

  public constructor(private readonly options: ImessageWatcherOptions) {
    this.chatDbPath = options.chatDbPath ?? join(homedir(), "Library", "Messages", "chat.db");
    this.debounceMs = options.debounceMs ?? 250;
    this.pollIntervalMs = options.pollIntervalMs ?? 3_000;
    const base = basename(this.chatDbPath);
    this.watchedNames = new Set([base, `${base}-wal`, `${base}-shm`]);
  }

  public start(): void {
    if (this.running || !this.options.gate()) {
      return;
    }

    this.running = true;
    this.startFileWatch();
    this.pollTimer = setInterval(() => this.scheduleWake(this.debounceMs), this.pollIntervalMs);
    this.scheduleWake(0);
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
    this.wakeAgain = false;
    await this.activeFlush;
  }

  public get isRunning(): boolean {
    return this.running;
  }

  private startFileWatch(): void {
    try {
      this.watcher = watch(dirname(this.chatDbPath), (_event, filename) => {
        if (!this.running || !this.isRelevantEvent(filename)) {
          return;
        }
        this.scheduleWake(this.debounceMs);
      });
      this.watcher.on("error", (error) => {
        this.watcher = undefined;
        this.reportError(error);
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  private isRelevantEvent(filename: string | Buffer | null): boolean {
    if (filename === null) {
      return true;
    }
    return this.watchedNames.has(basename(filename.toString()));
  }

  private scheduleWake(delay: number): void {
    if (!this.running) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.launchFlush();
    }, delay);
  }

  private launchFlush(): void {
    if (this.flushing) {
      this.wakeAgain = true;
      return;
    }
    const active = this.flush();
    this.activeFlush = active;
    void active.finally(() => {
      if (this.activeFlush === active) {
        this.activeFlush = undefined;
      }
    });
  }

  private async flush(): Promise<void> {
    if (!this.running || !this.options.gate()) {
      return;
    }
    if (this.flushing) {
      this.wakeAgain = true;
      return;
    }

    this.flushing = true;
    try {
      const messages = this.options.reader.readNewMessages();
      if (messages.length === 0 || !this.running || !this.options.gate()) {
        return;
      }
      await this.options.onMessages(messages);
      if (this.running && this.options.gate()) {
        this.options.reader.advanceCursor(messages.at(-1)!.rowid);
      }
    } catch (error) {
      this.reportError(error);
    } finally {
      this.flushing = false;
      if (this.wakeAgain) {
        this.wakeAgain = false;
        this.scheduleWake(0);
      }
    }
  }

  private reportError(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}
