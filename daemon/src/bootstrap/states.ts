import type { ConfigProbeResult } from "./probes.ts";

export type BootstrapState =
  | "starting"
  | "credentials_blocked"
  | "config_blocked"
  | "identity_blocked"
  | "permission_blocked"
  | "running"
  | "degraded";

export type ProbeStatus = "passed" | "missing" | "invalid" | "denied" | "unknown" | "error";

export interface ProbeResult {
  readonly status: ProbeStatus;
  readonly reason?: string;
  readonly aliases?: readonly string[];
}

export interface ProbeSnapshot {
  readonly config: ConfigProbeResult;
  readonly credentials?: ProbeResult;
  readonly messages?: ProbeResult;
  readonly fda?: ProbeResult;
  readonly accessibility?: ProbeResult;
}

export interface BootstrapSnapshot {
  readonly state: BootstrapState;
  readonly probes: ProbeSnapshot;
  readonly imessageHandle?: string;
  readonly reason?: string;
}

export interface BootstrapProbes {
  readonly config: () => Promise<ConfigProbeResult>;
  readonly credentials?: () => Promise<ProbeResult>;
  readonly messages?: () => Promise<ProbeResult>;
  readonly fda: () => Promise<ProbeResult>;
  readonly accessibility: () => Promise<ProbeResult>;
}

const STARTING_PROBES: ProbeSnapshot = {
  config: { status: "unknown" },
};

function isPassed(probe: ProbeResult): boolean {
  return probe.status === "passed";
}

/** Evaluates core credentials and optional iMessage permission probes. */
export class BootstrapMachine {
  private current: BootstrapSnapshot = {
    state: "starting",
    probes: STARTING_PROBES,
  };

  public constructor(private readonly probes: BootstrapProbes) {}

  public get snapshot(): BootstrapSnapshot {
    return this.current;
  }

  public async evaluate(): Promise<BootstrapSnapshot> {
    try {
      const config = await this.probes.config();
      const credentials = this.probes.credentials === undefined
        ? { status: "passed" as const }
        : await this.probes.credentials();
      if (credentials.status === "missing") {
        return this.set({
          state: "credentials_blocked",
          probes: { config, credentials },
          reason: credentials.reason,
        });
      }

      let messages: ProbeResult | undefined;
      let fda: ProbeResult | undefined;
      let accessibility: ProbeResult | undefined;
      if (config.allowlistHandle !== undefined) {
        [messages, fda, accessibility] = await Promise.all([
          this.probes.messages?.() ?? Promise.resolve(undefined),
          this.probes.fda(),
          this.probes.accessibility(),
        ]);
      }

      const probes: ProbeSnapshot = {
        config,
        credentials,
        ...(messages === undefined ? {} : { messages }),
        ...(fda === undefined ? {} : { fda }),
        ...(accessibility === undefined ? {} : { accessibility }),
      };
      const reason = config.status !== "passed"
        ? config.reason
        : accessibility !== undefined && !isPassed(accessibility)
          ? accessibility.reason
          : messages?.status === "unknown"
            ? messages.reason
            : undefined;
      return this.set({
        state: "running",
        probes,
        ...(config.allowlistHandle === undefined ? {} : { imessageHandle: config.allowlistHandle }),
        ...(reason === undefined ? {} : { reason }),
      });
    } catch (error) {
      return this.set({
        state: "degraded",
        probes: this.current.probes,
        reason: error instanceof Error ? error.message : "bootstrap probe failed",
      });
    }
  }

  public markDegraded(reason: string): BootstrapSnapshot {
    return this.set({
      state: "degraded",
      probes: this.current.probes,
      reason,
    });
  }

  private set(next: BootstrapSnapshot): BootstrapSnapshot {
    this.current = next;
    return next;
  }
}
