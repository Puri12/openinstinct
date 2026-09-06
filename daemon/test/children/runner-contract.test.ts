import { join } from "node:path";

import {
  OmoInProcessRunner,
  type ChildAgentSession,
  type ChildSessionFactory,
} from "../../src/children/runners/omo-inprocess.ts";
import { OmoExternalRunner } from "../../src/children/runners/omo-external.ts";
import { registerRunnerContract } from "./runner-contract.ts";

class ContractSession implements ChildAgentSession {
  public readonly sessionFile = "/tmp/runner-contract-child.jsonl";
  private readonly listeners = new Set<(event: unknown) => void>();
  private rejectPrompt: ((reason?: unknown) => void) | undefined;

  public async prompt(prompt: string): Promise<void> {
    if (prompt.includes("CRASH")) {
      throw new Error("fixture crash");
    }
    if (prompt.includes("HANG")) {
      await new Promise<void>((_resolve, reject) => {
        this.rejectPrompt = reject;
      });
      return;
    }
    for (const listener of this.listeners) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "fixture result" },
      });
    }
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async abort(): Promise<void> {
    this.rejectPrompt?.(new Error("cancelled"));
  }
}

const sessionFactory: ChildSessionFactory = {
  create: async () => new ContractSession(),
};

registerRunnerContract({
  name: "OmoInProcessRunner",
  create: (root) => new OmoInProcessRunner({ root, factory: sessionFactory }),
});

registerRunnerContract({
  name: "OmoExternalRunner",
  create: (root) => new OmoExternalRunner({
    root,
    cliPath: join(import.meta.dir, "../fixtures/children/omo-stub.sh"),
    killGraceMs: 100,
    env: { ...process.env, HOME: root },
  }),
});
