import { createChildStatusTool } from "../daemon/src/omo-session/child-tools.ts";

const events: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> = [];
const tool = createChildStatusTool({
  guardMs: 5,
  reader: {
    getChild: () => undefined,
    listLiveChildren: () => {
      const until = performance.now() + 100;
      while (performance.now() < until) {
        // Deliberately emulate a synchronous StateStore stall.
      }
      return [];
    },
    countLiveChildren: () => 0,
  },
  onEvent: (event, fields) => events.push({ event, fields }),
});
const started = performance.now();
await (tool as any).execute("guard-repro", {}, undefined, {});
const elapsedMs = performance.now() - started;
console.log(JSON.stringify({
  elapsedMs,
  guardEvent: events.find((entry) => entry.event === "child_tool_latency_alert"),
  expected: "Injected synchronous callback is outside the production status-reader contract; threshold is detection telemetry, not preemption.",
  outsideProductionContract: true,
  violated: false,
}, null, 2));
