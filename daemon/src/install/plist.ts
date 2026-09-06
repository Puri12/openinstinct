import { isAbsolute, join } from "node:path";

export interface InstalledPaths {
  readonly root: string;
  readonly binary: string;
  readonly entrypoint: string;
  readonly workingDirectory: string;
  readonly standardOut: string;
  readonly standardError: string;
}

export function installedPaths(home: string): InstalledPaths {
  if (!isAbsolute(home)) {
    throw new Error("install home must be an absolute path");
  }
  if (home.includes("Documents/Workspace")) {
    throw new Error("install home must not be a source-tree path");
  }

  const root = join(home, ".openinstinct");
  return {
    root,
    binary: join(root, "bin", "openinstinctd"),
    entrypoint: join(root, "lib", "daemon", "src", "main.ts"),
    workingDirectory: root,
    standardOut: join(root, "logs", "launchd.stdout.log"),
    standardError: join(root, "logs", "launchd.stderr.log"),
  };
}

/** Pure plist renderer; install.sh supplies the target user's absolute HOME. */
export function renderLaunchAgentPlist(home: string): string {
  const paths = installedPaths(home);
  const escaped = {
    home: escapeXml(home),
    binary: escapeXml(paths.binary),
    entrypoint: escapeXml(paths.entrypoint),
    workingDirectory: escapeXml(paths.workingDirectory),
    standardOut: escapeXml(paths.standardOut),
    standardError: escapeXml(paths.standardError),
    omoHome: escapeXml(`${paths.root}/omo`),
    path: escapeXml(`${paths.root}/bin:${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`),
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>co.openinstinct.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escaped.binary}</string>
    <string>${escaped.entrypoint}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escaped.workingDirectory}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escaped.home}</string>
    <key>PATH</key>
    <string>${escaped.path}</string>
    <key>SENPI_CODING_AGENT_DIR</key>
    <string>${escaped.omoHome}</string>
    <key>OMO_CODING_AGENT_DIR</key>
    <string>${escaped.omoHome}</string>
    <key>PI_CODING_AGENT_DIR</key>
    <string>${escaped.omoHome}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escaped.standardOut}</string>
  <key>StandardErrorPath</key>
  <string>${escaped.standardError}</string>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
