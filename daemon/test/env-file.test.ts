import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnvFile } from "../src/env-file.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  delete process.env.OI_TEST_KEY_A;
  delete process.env.OI_TEST_KEY_B;
});

describe("env file", () => {
  test("loads private KEY=value lines and overrides pre-set variables", () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-env-"));
    directories.push(root);
    const path = join(root, "env");
    writeFileSync(path, '# comment\nexport OI_TEST_KEY_A="alpha"\nOI_TEST_KEY_B=beta\n');
    chmodSync(path, 0o600);
    process.env.OI_TEST_KEY_B = "preset";
    expect(loadEnvFile(path)).toEqual({ loaded: ["OI_TEST_KEY_A"], overridden: ["OI_TEST_KEY_B"] });
    expect(process.env.OI_TEST_KEY_A).toBe("alpha");
    expect(process.env.OI_TEST_KEY_B).toBe("beta");
  });

  test("refuses a group/world-readable secrets file", () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-env-"));
    directories.push(root);
    const path = join(root, "env");
    writeFileSync(path, "OI_TEST_KEY_A=x\n");
    chmodSync(path, 0o644);
    expect(() => loadEnvFile(path)).toThrow(/chmod 600/);
  });

  test("is a no-op when absent", () => {
    expect(loadEnvFile("/nonexistent/openinstinct/env")).toEqual({ loaded: [], overridden: [] });
  });
});
