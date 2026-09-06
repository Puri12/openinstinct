export const DRILL_HOLD_POINTS = [
  "mid-turn",
  "mid-child",
  "post-journal-pre-receipt",
  "mid-closure",
  "mid-propagation",
  "mid-interim-batch",
] as const;

export type DrillHoldPoint = (typeof DRILL_HOLD_POINTS)[number];

export interface DrillSettings {
  readonly enabled: boolean;
  readonly holdPoint?: DrillHoldPoint;
}

/** Test hooks are opt-in and have no effect unless their OI_DRILL_* env is set. */
export function readDrillSettings(env: NodeJS.ProcessEnv = process.env): DrillSettings {
  const enabled = env.OI_DRILL_MODE === "1";
  const holdPoint = enabled && isDrillHoldPoint(env.OI_DRILL_HOLD) ? env.OI_DRILL_HOLD : undefined;
  return {
    enabled,
    ...(holdPoint === undefined ? {} : { holdPoint }),
  };
}

/**
 * Publishes a deterministic seam marker and intentionally never resolves. The
 * drill runner kills the process once this marker appears, proving recovery
 * from the durable rung preceding this await.
 */
export async function holdForDrill(point: DrillHoldPoint, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const settings = readDrillSettings(env);
  if (!settings.enabled || settings.holdPoint !== point) {
    return;
  }
  process.stdout.write(`OI_DRILL_HOLD_REACHED ${point} ${new Date().toISOString()}\n`);
  await new Promise<void>(() => undefined);
}

function isDrillHoldPoint(value: unknown): value is DrillHoldPoint {
  return typeof value === "string" && (DRILL_HOLD_POINTS as readonly string[]).includes(value);
}
