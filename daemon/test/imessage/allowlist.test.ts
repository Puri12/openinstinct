import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isAllowedHandle, normalizeHandle, readAllowlistConfig } from "../../src/imessage/allowlist.ts";

describe("iMessage allowlist normalization", () => {
  test("normalizes explicit phone and email handles without guessing country codes", () => {
    expect(normalizeHandle(" +82 10-1234-5678 ")).toBe("+821012345678");
    expect(normalizeHandle("+82-10 1234 5678")).toBe("+821012345678");
    expect(normalizeHandle("Owner.Name+OI@Example.COM ")).toBe("owner.name+oi@example.com");

    expect(normalizeHandle("821012345678")).toBeUndefined();
    expect(normalizeHandle("010-1234-5678")).toBeUndefined();
    expect(normalizeHandle("+82 (10) 1234-5678")).toBeUndefined();
    expect(normalizeHandle("owner @example.com")).toBeUndefined();
    expect(normalizeHandle("")).toBeUndefined();
    expect(normalizeHandle("   ")).toBeUndefined();
  });

  test("permits only exact canonical matches", () => {
    const owner = "+821012345678";

    expect(isAllowedHandle("+82 10-1234-5678", owner)).toBe(true);
    expect(isAllowedHandle("821012345678", owner)).toBe(false);
    expect(isAllowedHandle("+821012345679", owner)).toBe(false);
    expect(isAllowedHandle("owner@example.com", owner)).toBe(false);
    expect(isAllowedHandle("+821012345678", "01012345678")).toBe(false);
  });

  test("loads only a valid configured allowlist handle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openinstinct-allowlist-"));
    const config = join(directory, "config.json");
    try {
      writeFileSync(config, JSON.stringify({ allowlistHandle: "+82 10-1234-5678" }));
      await expect(readAllowlistConfig(config)).resolves.toEqual({ allowlistHandle: "+821012345678" });

      writeFileSync(config, JSON.stringify({ allowlistHandle: "01012345678" }));
      await expect(readAllowlistConfig(config)).rejects.toThrow("valid allowlistHandle");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
