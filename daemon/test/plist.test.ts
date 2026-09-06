import { describe, expect, test } from "bun:test";

import { installedPaths, renderLaunchAgentPlist } from "../src/install/plist.ts";

describe("launchd plist materialization", () => {
  test("uses only installed absolute paths", () => {
    const home = "/Users/openinstinct-test";
    const paths = installedPaths(home);
    const plist = renderLaunchAgentPlist(home);

    expect(plist).not.toContain("~");
    expect(plist).not.toContain("Documents/Workspace");
    expect(plist).toContain(`<string>${paths.binary}</string>`);
    expect(plist).toContain(`<string>${paths.entrypoint}</string>`);
    expect(plist).toContain(`<string>${paths.workingDirectory}</string>`);
    expect(plist).toContain(`<string>${paths.standardOut}</string>`);
    expect(plist).toContain(`<string>${paths.standardError}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n  <dict>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>ProcessType</key>\n  <string>Interactive</string>");
    expect(plist).toContain("<key>SENPI_CODING_AGENT_DIR</key>");
    expect(plist).toContain("<key>OMO_CODING_AGENT_DIR</key>");
    expect(plist).toContain("<key>PI_CODING_AGENT_DIR</key>");
    expect(plist).toContain(`<string>${paths.root}/omo</string>`);
    // Exactly the three omo engine dir keys: nothing points the engine anywhere else.
    expect((plist.match(/_CODING_AGENT_DIR<\/key>/g) ?? []).length).toBe(3);
  });
});
