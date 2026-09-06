import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const vendorRoot = fileURLToPath(new URL("../../src/memory/vendor/", import.meta.url));
const provenance = fileURLToPath(new URL("../../src/memory/PROVENANCE.md", import.meta.url));

const EXPECTED_HASHES: Readonly<Record<string, string>> = {
  "registry.ts": "ff9aae71c1c6ebb5a0f629965324ab0b8c2b0c4f901d2a11489626d1f633a66d",
  "doctrine.ts": "f882d1ca10060adde052799a536c7e0f026fd90843cb28e28e1c241124ef1e3f",
  "validator.ts": "cccb51753faa6c340c1ef5a0fde32d110512990deed4eeb6e5908ec877483e4b",
  "retrieve.ts": "750e78e99ad252117dfe348ac29877aafdd1195b62b277a3431600d1a1bb33bb",
  "autolink.ts": "163873ec891e48d97308446ff910df0360de64dd1f2f99e855f1aa92faf3909a",
};

describe("memory vendor provenance", () => {
  test("keeps every listed pure port byte-identical to pinned gajae-way source", () => {
    const source = readFileSync(provenance, "utf8");
    expect(source).toContain("8eafbefd9b71fa8f101ef3122f87265456ca7709");
    for (const [file, expected] of Object.entries(EXPECTED_HASHES)) {
      const actual = new Bun.CryptoHasher("sha256").update(readFileSync(join(vendorRoot, file))).digest("hex");
      expect(actual).toBe(expected);
      expect(source).toContain(expected);
    }
  });
});
