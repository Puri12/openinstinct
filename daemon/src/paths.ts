import { homedir } from "node:os";
import { join } from "node:path";

export interface DataPaths {
  readonly home: string;
  readonly root: string;
  readonly config: string;
  /** Private KEY=value file for provider credentials (mode 0600). */
  readonly envFile: string;
  /** Dedicated persistent Chrome profile for the browser tool (owner logs in here once). */
  readonly chromeProfile: string;
  /** Isolated gjc state (sessions, auth, models.yml). Never the host's ~/.gjc. */
  readonly gjcHome: string;
  /** The gjc binary OpenInstinct owns, version-locked to the vendored SDK. */
  readonly gjcBinary: string;
  readonly stateDb: string;
  readonly logs: string;
  readonly daemonLog: string;
  readonly run: string;
  readonly controlSocket: string;
  readonly bin: string;
  readonly session: string;
  readonly children: string;
  readonly childrenJournal: string;
  readonly memory: string;
  readonly memoryReceipts: string;
}

export function dataPaths(home = process.env.HOME ?? homedir()): DataPaths {
  const root = join(home, ".openinstinct");
  const logs = join(root, "logs");
  const run = join(root, "run");
  const session = join(root, "session");
  const children = join(root, "children");
  const memory = join(root, "memory");

  return {
    home,
    root,
    config: join(root, "config.json"),
    envFile: join(root, "env"),
    chromeProfile: join(root, "chrome-profile"),
    gjcHome: join(root, "gjc"),
    gjcBinary: join(root, "bin", "gjc"),
    stateDb: join(root, "state.db"),
    logs,
    daemonLog: join(logs, "daemon.ndjson"),
    run,
    controlSocket: join(run, "control.sock"),
    bin: join(root, "bin"),
    session,
    children,
    childrenJournal: join(children, "journal"),
    memory,
    memoryReceipts: join(root, "memory-receipts.jsonl"),
  };
}
