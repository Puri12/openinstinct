import { existsSync } from "node:fs";

import { defaultMonitorRuntimeConfig, readMonitorRuntimeConfig, type MonitorRuntimeConfig } from "./monitors/triggers.ts";
import type { NdjsonLogger } from "./log.ts";
import { defaultRuntimeConfig, readRuntimeConfig, type RuntimeConfig } from "./runtime-config.ts";

export interface CoreConfig {
  readonly runtime: RuntimeConfig;
  readonly monitors: MonitorRuntimeConfig;
}

/**
 * Reads runtime and monitor settings independently. Configuration is optional
 * for the core lane, so every read failure falls back to that scope's defaults.
 */
export async function readCoreConfig(
  path: string,
  logger: Pick<NdjsonLogger, "write">,
): Promise<CoreConfig> {
  if (!existsSync(path)) {
    logger.write("info", "main", "config_missing_defaults_applied", { path });
    return { runtime: defaultRuntimeConfig(), monitors: defaultMonitorRuntimeConfig() };
  }

  const [runtimeResult, monitorsResult] = await Promise.all([
    readRuntimeConfig(path).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, reason: messageOf(error) }),
    ),
    readMonitorRuntimeConfig(path).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, reason: messageOf(error) }),
    ),
  ]);

  let runtime: RuntimeConfig;
  if (runtimeResult.ok) {
    runtime = runtimeResult.value;
  } else {
    logger.write("warn", "main", "config_invalid_defaults_applied", {
      scope: "runtime",
      reason: runtimeResult.reason,
    });
    runtime = defaultRuntimeConfig();
  }

  let monitors: MonitorRuntimeConfig;
  if (monitorsResult.ok) {
    monitors = monitorsResult.value;
  } else {
    logger.write("warn", "main", "config_invalid_defaults_applied", {
      scope: "monitors",
      reason: monitorsResult.reason,
    });
    monitors = defaultMonitorRuntimeConfig();
  }
  return { runtime, monitors };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
