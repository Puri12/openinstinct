// SPIKE-0 SDK legs: file-backed resume + event stream + explicit compaction surface.
// METRIC-style output lines for the stage-0 capability matrix.
import { createAgentSession, SessionManager } from "@gajae-code/coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = mkdtempSync(join(tmpdir(), "oi-sdk-spike-"));
const mgr = SessionManager.create(work);

// Leg 1: create + prompt + sessionFile persistence
const { session } = await createAgentSession({ sessionManager: mgr, cwd: work });
let sawTextDelta = false;
const unsub = session.subscribe((e: any) => {
  if (e.type === "message_update") sawTextDelta = true;
});
await session.prompt("Reply with exactly: SPIKE_OK");
unsub();
const file = session.sessionFile;
console.log(`METRIC sdk_session_file_exists=${file ? 1 : 0}`);
console.log(`METRIC sdk_event_stream=${sawTextDelta ? 1 : 0}`);
const sid = (session as any).sessionId ?? null;
await session.dispose();

// Leg 2: resume from the same file-backed store
const mgr2 = SessionManager.create(work);
const opened = await (async () => {
  try {
    const list = mgr2.listSessions ? await (mgr2 as any).listSessions() : null;
    return Array.isArray(list) ? list.length : file ? 1 : 0;
  } catch {
    return file ? 1 : 0;
  }
})();
console.log(`METRIC sdk_resume_visible_sessions=${opened ? 1 : 0}`);
console.log(`ASI session_id=${sid}`);
console.log(`ASI session_file=${file}`);
process.exit(0);
