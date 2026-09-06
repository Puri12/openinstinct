import type { MonitorStore } from "../monitors/store.ts";
import type { StateStore } from "../store/index.ts";

export const COMPUTER_USAGE_MONITOR_ID = "computer-usage-insight";
const SEED_META = "insights.computer_usage.seeded";

/**
 * Daily proactive suggestion, in the spirit of Codex's computer-history
 * onboarding: a daemon child studies how the owner actually uses this Mac and
 * texts a few concrete automation proposals before being asked. Runs at 09:00
 * local; the monitor runtime's boot catch-up makes the first run happen on
 * onboarding day rather than tomorrow.
 */
export const COMPUTER_USAGE_INSTRUCTION = [
  "Study how the owner uses this Mac over roughly the last 7 days and propose automations they have not asked for.",
  "Evidence to inspect (read-only, skip anything missing or unreadable): shell history (~/.zsh_history, ~/.bash_history, fish history), recent commands' working directories, git repositories under ~/Documents and ~/Projects and their recent commit/branch activity, ~/Downloads and ~/Desktop churn (mdls / ls -lt), Calendar and Reminders via `icalBuddy` or `osascript` if available, recently opened apps and documents (`mdfind kMDItemLastUsedDate` within the window), recurring cron/launchd jobs, and the OpenInstinct memory corpus under ~/.openinstinct/memory for prior owner preferences and past proposals.",
  "Look for repetition: the same command chains typed by hand, the same files moved or renamed, the same sites or apps opened on a schedule, meetings that always need prep, and chores the owner keeps deferring.",
  "Compare against prior proposals in memory so you do not repeat one the owner already accepted or declined.",
  "Return at most three proposals, ranked by time saved. Each proposal is one or two plain sentences: what you observed (with a concrete number or example), what you would automate, and how the owner triggers it (a monitor you can author, a background task, or a shortcut). If nothing worth proposing was found, say so in one sentence rather than inventing something.",
  "Never modify files, install software, or author monitors during this analysis; propose only. Do not include secrets, full paths of personal files, or raw history lines in the update.",
].join(" ");

export function seedComputerUsageInsight(store: StateStore, monitors: MonitorStore): boolean {
  if (store.getMeta(SEED_META) !== undefined) {
    return false;
  }
  if (!monitors.get(COMPUTER_USAGE_MONITOR_ID)) {
    monitors.create({
      id: COMPUTER_USAGE_MONITOR_ID,
      name: "Computer usage insight",
      trigger: { kind: "cron", expression: "0 9 * * *" },
      instruction: COMPUTER_USAGE_INSTRUCTION,
      eventTypes: ["cron"],
      burstPolicy: "dedupe",
      timeoutSec: 1_500,
    });
  }
  store.setMeta(SEED_META, "1");
  return true;
}
