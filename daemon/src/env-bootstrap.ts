import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "./env-file.ts";
import { dataPaths } from "./paths.ts";

/** Evaluated before any omo engine module; see main.ts. */
const paths = dataPaths();
export const ENV_FILE = loadEnvFile(paths.envFile);
// The omo engine and every child read state from this directory. Isolating it
// from the host's ~/.omo/agent means a host engine upgrade can never migrate
// the session/auth schema out from under the version-locked vendored engine.
process.env.SENPI_CODING_AGENT_DIR ??= paths.omoHome;
process.env.OMO_CODING_AGENT_DIR ??= paths.omoHome;
process.env.PI_CODING_AGENT_DIR ??= paths.omoHome;

{
  mkdirSync(paths.omoHome, { recursive: true, mode: 0o700 });
  const settings = join(paths.omoHome, "settings.json");
  if (!existsSync(settings)) {
    writeFileSync(
      settings,
      JSON.stringify({
        steeringMode: "all",
        followUpMode: "all",
        compaction: { enabled: false },
        quietStartup: true,
      }),
      { mode: 0o600 },
    );
  }
  const models = join(paths.omoHome, "models.json");
  if (!existsSync(models)) {
    writeFileSync(models, JSON.stringify({ providers: {} }), { mode: 0o600 });
  }
  const auth = join(paths.omoHome, "auth.json");
  if (!existsSync(auth)) {
    writeFileSync(auth, JSON.stringify({}), { mode: 0o600 });
  }
}
