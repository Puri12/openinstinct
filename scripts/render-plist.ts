import { renderLaunchAgentPlist } from "../daemon/src/install/plist.ts";

const [home, output] = Bun.argv.slice(2);
if (!home || !output) {
  throw new Error("usage: bun scripts/render-plist.ts <absolute-home> <output-path>");
}

await Bun.write(output, renderLaunchAgentPlist(home));
