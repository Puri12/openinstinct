import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { dataPaths } from "../../daemon/src/paths.ts";
import { openStateStore } from "../../daemon/src/store/index.ts";
import { requestControl } from "../lib/control-client.ts";

interface Options {
  readonly home: string;
  readonly socket: string;
  readonly pid?: number;
  readonly durationMs: number;
  /** Minimum terminal children for the child-success gate to be evidence-bearing. */
  readonly minChildren: number;
}

interface Sample {
  readonly at: string;
  readonly elapsedMs: number;
  readonly pid?: number;
  readonly rssBytes?: number;
  readonly fdCount?: number;
  readonly socketP99Ms?: number;
  readonly eventLoopP99Ms?: number;
  readonly eventLoopP50Ms?: number;
  readonly childCompleted?: number;
  readonly childTerminal?: number;
  readonly failedDeliveries?: number;
  readonly unexplainedFailures?: number;
  readonly monitorDelivered?: number;
  readonly error?: string;
}

const SAMPLE_INTERVAL_MS = 60_000;
/** G4 prescribes excluding the first hour of RSS movement as warm-up. */
const WARMUP_MS = 60 * 60_000;
const SOCKET_PROBES_PER_SAMPLE = 10;
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

try {
  await main(parseOptions(process.argv.slice(2)));
} catch (error) {
  console.log(`GATE harness ${messageOf(error)} FAIL`);
  console.log("ACTION adapter-flip mandate: Stop new monitor work, switch to the alternate adapter documented in docs/runbook.md, restart, and repeat the soak from a clean baseline.");
  console.log("METRIC soak_verdict=fail");
  process.exitCode = 1;
}

async function main(options: Options): Promise<void> {
  const paths = dataPaths(options.home);
  const logPath = join(paths.logs, "soak.ndjson");
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  const deadline = startedAt + options.durationMs;
  const samples: Sample[] = [];
  const latencies: number[] = [];
  const pid = options.pid ?? await findDaemonPid(options.socket);
  console.log(
    "WORKLOAD the G4 soak is only evidence-bearing under load: before starting, author a one-minute cron monitor from the owner chat (it exercises monitor firings, child sessions, and owner deliveries together) and leave it enabled for the full window.",
  );

  let lastMaintenanceAt = 0;
  while (true) {
    const sample = await collectSample(paths.stateDb, options.socket, pid, startedAt, latencies);
    samples.push(sample);
    appendFileSync(logPath, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
    console.log(`SAMPLE elapsed=${Math.round(sample.elapsedMs / 1_000)}s rss=${formatBytes(sample.rssBytes)} fd=${String(sample.fdCount ?? "n/a")} p99=${formatMs(sample.socketP99Ms)} loop=${formatMs(sample.eventLoopP99Ms)}`);
    // Orchestrate the maintenance leg of the prescribed workload mix hourly;
    // cron firings and delegations come from the operator-seeded monitor.
    if (Date.now() - lastMaintenanceAt >= 60 * 60_000) {
      lastMaintenanceAt = Date.now();
      await requestControl(options.socket, "maintenance.run", {}, 30_000).catch(() => undefined);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await Bun.sleep(Math.min(SAMPLE_INTERVAL_MS, remaining));
  }

  const verdict = printVerdict(samples, latencies, options);
  if (verdict === "fail") {
    console.log("ACTION adapter-flip mandate: Stop new monitor work, switch to the alternate adapter documented in docs/runbook.md, restart, and repeat the soak from a clean baseline.");
    process.exitCode = 1;
  }
  if (verdict === "insufficient") {
    console.log("ACTION the run produced too little workload to judge the gates; seed the cron-monitor workload and repeat.");
    process.exitCode = 1;
  }
  console.log(`METRIC soak_verdict=${verdict}`);
}

async function collectSample(
  stateDb: string,
  socket: string,
  pid: number,
  startedAt: number,
  latencies: number[],
): Promise<Sample> {
  const base = { at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, pid };
  try {
    const [rssBytes, fdCount, probeLatencies, workload] = await Promise.all([
      daemonRssBytes(pid),
      daemonFdCount(pid),
      probeStatusLatency(socket),
      workloadEvidence(stateDb),
    ]);
    latencies.push(...probeLatencies);
    return {
      ...base,
      rssBytes,
      fdCount,
      socketP99Ms: percentile(probeLatencies, 0.99),
      ...(workload.eventLoopP99Ms === undefined ? {} : { eventLoopP99Ms: workload.eventLoopP99Ms }),
      ...(workload.eventLoopP50Ms === undefined ? {} : { eventLoopP50Ms: workload.eventLoopP50Ms }),
      childCompleted: workload.completed,
      childTerminal: workload.terminal,
      failedDeliveries: workload.failedDeliveries,
      unexplainedFailures: workload.unexplainedFailures,
      monitorDelivered: workload.monitorDelivered,
    };
  } catch (error) {
    return { ...base, error: messageOf(error) };
  }
}

async function probeStatusLatency(socket: string): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < SOCKET_PROBES_PER_SAMPLE; index += 1) {
    const started = performance.now();
    const response = await requestControl(socket, "status.get", {}, 5_000);
    if (response.payload.bootstrap === undefined) {
      throw new Error("status.get returned no bootstrap payload");
    }
    values.push(performance.now() - started);
  }
  return values;
}

async function daemonRssBytes(pid: number): Promise<number> {
  const result = await runCommand(["ps", "-o", "rss=", "-p", String(pid)]);
  if (result.exitCode !== 0) {
    throw new Error(`ps could not read daemon RSS: ${compactOutput(result.stderr)}`);
  }
  const kib = Number(result.stdout.trim().split(/\s+/)[0]);
  if (!Number.isFinite(kib) || kib < 0) {
    throw new Error(`ps returned an invalid RSS value: ${compactOutput(result.stdout)}`);
  }
  return kib * 1024;
}

async function daemonFdCount(pid: number): Promise<number> {
  const result = await runCommand(["lsof", "-p", String(pid), "-Fn"]);
  if (result.exitCode !== 0) {
    throw new Error(`lsof could not read daemon file descriptors: ${compactOutput(result.stderr)}`);
  }
  return result.stdout.split(/\r?\n/).filter((line) => line.startsWith("f")).length;
}

async function findDaemonPid(socket: string): Promise<number> {
  // The socket path must be passed as a file operand. `lsof -U <path>` ignores the
  // path and enumerates every UNIX socket on the host, which silently resolved to
  // hundreds of unrelated pids and made the soak gates meaningless.
  const result = await runCommand(["lsof", "-t", "--", socket]);
  if (result.exitCode !== 0) {
    throw new Error(`cannot discover daemon pid for ${socket}; pass --pid explicitly (${compactOutput(result.stderr)})`);
  }
  const pids = [...new Set(result.stdout.split(/\s+/).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid))];
  if (pids.length !== 1) {
    throw new Error(`expected one daemon pid for ${socket}, found ${pids.join(",") || "none"}; pass --pid explicitly`);
  }
  return pids[0]!;
}

function workloadEvidence(stateDb: string): {
  readonly completed: number;
  readonly terminal: number;
  readonly failedDeliveries: number;
  readonly unexplainedFailures: number;
  readonly monitorDelivered: number;
  readonly eventLoopP99Ms?: number;
  readonly eventLoopP50Ms?: number;
} {
  if (!existsSync(stateDb)) {
    throw new Error(`state database is missing: ${stateDb}`);
  }
  const store = openStateStore(stateDb);
  try {
    const terminal = store.listChildren().filter((child) => isTerminalChildState(child.state));
    const failed = store.listDeliveries()
      .filter((delivery) => delivery.state === "expired" || delivery.state === "failed_ambiguous");
    // A no-retry failure is "explained" when its record carries a classified
    // cause. Anything terminal without one — across deliveries, monitor events,
    // and children — is the unexplained class the G4 gate must hold at zero.
    const unexplainedDeliveries = failed.filter((delivery) => delivery.lastErrorCode === undefined).length;
    const unexplainedMonitorEvents = store.listMonitorEvents()
      .filter((event) => event.stage === "failed" && event.lastErrorCode === undefined).length;
    const unexplainedChildren = terminal
      .filter((child) => child.state !== "completed" && child.state !== "cancelled" && child.errorCode === undefined).length;
    const monitorDelivered = store.listMonitorEvents().filter((event) => event.stage === "delivered").length;
    const readLoopMeta = (key: string): number | undefined => {
      const value = store.getMeta(key);
      return value !== undefined && /^\d+(\.\d+)?$/.test(value) ? Number(value) : undefined;
    };
    const eventLoopP99Ms = readLoopMeta("runtime.event_loop_p99_ms");
    const eventLoopP50Ms = readLoopMeta("runtime.event_loop_p50_ms");
    return {
      completed: terminal.filter((child) => child.state === "completed").length,
      terminal: terminal.length,
      failedDeliveries: failed.length,
      unexplainedFailures: unexplainedDeliveries + unexplainedMonitorEvents + unexplainedChildren,
      monitorDelivered,
      ...(eventLoopP99Ms === undefined ? {} : { eventLoopP99Ms }),
      ...(eventLoopP50Ms === undefined ? {} : { eventLoopP50Ms }),
    };
  } finally {
    store.close();
  }
}

function printVerdict(
  samples: readonly Sample[],
  latencies: readonly number[],
  options: Options,
): "pass" | "fail" | "insufficient" {
  const first = samples[0];
  const last = samples.at(-1);
  const completeSamples = samples.filter((sample) => sample.error === undefined && sample.rssBytes !== undefined && sample.fdCount !== undefined);
  const sampleErrors = samples.filter((sample) => sample.error !== undefined);

  // G4: the first hour is warm-up and is excluded from the growth slope. Runs
  // shorter than two hours have no post-warm-up window and use the full run,
  // which makes them smoke tests rather than gate evidence.
  const warmupApplies = last !== undefined && last.elapsedMs >= 2 * WARMUP_MS;
  const growthBase = warmupApplies
    ? completeSamples.find((sample) => sample.elapsedMs >= WARMUP_MS) ?? first
    : first;
  const elapsedHours = growthBase && last ? Math.max((last.elapsedMs - growthBase.elapsedMs) / 3_600_000, 1 / 60) : 1 / 60;
  const rss = last?.rssBytes;
  const growthMiBPerHour = growthBase?.rssBytes === undefined || last?.rssBytes === undefined
    ? undefined
    : (last.rssBytes - growthBase.rssBytes) / MIB / elapsedHours;
  const fdDelta = first?.fdCount === undefined || last?.fdCount === undefined
    ? undefined
    : last.fdCount - first.fdCount;
  const p99 = latencies.length === 0 ? undefined : percentile(latencies, 0.99);

  // Workload deltas over the soak window, not lifetime totals.
  const childTerminal = first?.childTerminal === undefined || last?.childTerminal === undefined
    ? undefined
    : last.childTerminal - first.childTerminal;
  const childCompleted = first?.childCompleted === undefined || last?.childCompleted === undefined
    ? undefined
    : last.childCompleted - first.childCompleted;
  const newUnexplainedFailures = first?.unexplainedFailures === undefined || last?.unexplainedFailures === undefined
    ? undefined
    : last.unexplainedFailures - first.unexplainedFailures;
  const newFailedDeliveries = first?.failedDeliveries === undefined || last?.failedDeliveries === undefined
    ? undefined
    : last.failedDeliveries - first.failedDeliveries;
  const eventLoopP99 = last?.eventLoopP99Ms;
  const monitorDelivered = first?.monitorDelivered === undefined || last?.monitorDelivered === undefined
    ? undefined
    : last.monitorDelivered - first.monitorDelivered;
  const childSuccessRate = childTerminal === undefined || childCompleted === undefined || childTerminal === 0
    ? undefined
    : childCompleted / childTerminal;
  const enoughWorkload = childTerminal !== undefined && childTerminal >= options.minChildren;

  const gates: readonly [string, string, boolean][] = [
    ["RSS", `${formatBytes(rss)} < 1.5GiB`, rss !== undefined && rss < 1.5 * GIB],
    [
      "RSS growth",
      `${growthMiBPerHour === undefined ? "n/a" : growthMiBPerHour.toFixed(2)}MiB/h < 50MiB/h (warmup ${warmupApplies ? "excluded" : "not applicable: run too short"})`,
      growthMiBPerHour !== undefined && growthMiBPerHour < 50,
    ],
    ["FD delta", `${fdDelta === undefined ? "n/a" : String(fdDelta)} <= 10`, fdDelta !== undefined && fdDelta <= 10],
    ["Socket p99", `${formatMs(p99)} < 250ms`, p99 !== undefined && p99 < 250],
    [
      "Event-loop p99",
      `${formatMs(eventLoopP99)} < 250ms (daemon-side rolling window; p50=${formatMs(last?.eventLoopP50Ms)})`,
      eventLoopP99 !== undefined && eventLoopP99 < 250,
    ],
    [
      "Child success",
      childSuccessRate === undefined
        ? `insufficient evidence (${String(childTerminal ?? "n/a")} terminal children in window; need >= ${options.minChildren})`
        : `${(childSuccessRate * 100).toFixed(2)}% (${childCompleted}/${childTerminal} in window) >= 99%`,
      childSuccessRate !== undefined && childSuccessRate >= 0.99,
    ],
    [
      "Unexplained no-retry failures",
      `${newUnexplainedFailures === undefined ? "n/a" : String(newUnexplainedFailures)} terminal delivery failures without a recorded cause in window == 0 (total failed in window: ${newFailedDeliveries === undefined ? "n/a" : String(newFailedDeliveries)})`,
      newUnexplainedFailures !== undefined && newUnexplainedFailures === 0,
    ],
  ];
  for (const [name, value, passed] of gates) {
    console.log(`GATE ${name} ${value} ${passed ? "PASS" : "FAIL"}`);
  }
  console.log(`GATE workload ${String(childTerminal ?? "n/a")} terminal children, ${String(monitorDelivered ?? "n/a")} monitor deliveries in window (need >= ${options.minChildren} children) ${enoughWorkload ? "PASS" : "INSUFFICIENT"}`);
  if (sampleErrors.length > 0 || completeSamples.length !== samples.length) {
    console.log(`GATE sampling ${sampleErrors.length}/${samples.length} samples failed FAIL`);
  }

  const hardFailure = !gates.filter(([name]) => name !== "Child success").every(([, , passed]) => passed)
    || sampleErrors.length > 0
    || completeSamples.length !== samples.length;
  if (hardFailure) {
    return "fail";
  }
  if (!enoughWorkload || childSuccessRate === undefined) {
    // Resource gates held but the run cannot judge child success: never report
    // a vacuous 100% pass on zero children.
    return "insufficient";
  }
  return childSuccessRate >= 0.99 ? "pass" : "fail";
}

async function runCommand(argv: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function parseOptions(args: readonly string[]): Options {
  let home = process.env.HOME;
  let socket: string | undefined;
  let pid: number | undefined;
  let hours = 24;
  let minutes: number | undefined;
  let minChildren: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = args[index + 1];
    if (value === "--home" && next) {
      home = next;
      index += 1;
    } else if (value === "--socket" && next) {
      socket = next;
      index += 1;
    } else if (value === "--pid" && next) {
      pid = Number(next);
      index += 1;
    } else if (value === "--hours" && next) {
      hours = Number(next);
      index += 1;
    } else if (value === "--minutes" && next) {
      minutes = Number(next);
      index += 1;
    } else if (value === "--min-children" && next) {
      minChildren = Number(next);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete option: ${value}`);
    }
  }
  if (!home || !home.startsWith("/")) {
    throw new Error("HOME or --home must be an absolute path");
  }
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) {
    throw new Error("--pid must be a positive integer");
  }
  if (!Number.isFinite(hours) || hours <= 0 || (minutes !== undefined && !Number.isFinite(minutes))) {
    throw new Error("--hours and --minutes must be positive numbers");
  }
  if (minutes !== undefined && (minutes <= 0 || args.includes("--hours"))) {
    throw new Error("use exactly one of --hours or --minutes, with a positive value");
  }
  const durationMs = (minutes ?? hours * 60) * 60_000;
  if (!Number.isSafeInteger(durationMs) || durationMs < SAMPLE_INTERVAL_MS) {
    throw new Error("soak duration must be at least one minute");
  }
  if (minChildren !== undefined && (!Number.isSafeInteger(minChildren) || minChildren < 1)) {
    throw new Error("--min-children must be a positive integer");
  }
  const paths = dataPaths(home);
  return {
    home,
    socket: socket ?? paths.controlSocket,
    ...(pid === undefined ? {} : { pid }),
    durationMs,
    // G4 prescribes ~24 delegations over 24h; scale proportionally, minimum 1.
    minChildren: minChildren ?? Math.max(1, Math.round(durationMs / 3_600_000)),
  };
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index]!;
}

function isTerminalChildState(state: string): boolean {
  return state === "completed" || state === "failed" || state === "timeout" || state === "cancelled" || state === "orphaned";
}

function formatBytes(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value / MIB).toFixed(1)}MiB`;
}

function formatMs(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value.toFixed(1)}ms`;
}

function compactOutput(value: string): string {
  return Array.from(value.replace(/\s+/g, " ").trim()).slice(0, 300).join("");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
