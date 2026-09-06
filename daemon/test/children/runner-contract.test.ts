import { join } from "node:path";

import {
  SdkInProcessRunner,
  type ChildAgentSession,
  type ChildSessionFactory,
} from "../../src/children/runners/sdk-inprocess.ts";
import { GjcExternalRunner } from "../../src/children/runners/gjc-external.ts";
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
  name: "SdkInProcessRunner",
  create: (root) => new SdkInProcessRunner({ root, factory: sessionFactory }),
});

registerRunnerContract({
  name: "GjcExternalRunner",
  create: (root) => new GjcExternalRunner({
    root,
    gjcPath: join(import.meta.dir, "../fixtures/children/gjc-stub.sh"),
    killGraceMs: 100,
    env: { ...process.env, HOME: root },
  }),
});
