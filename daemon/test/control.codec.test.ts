import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { decodeFrame, encodeFrame } from "../src/control/schema.ts";

const fixturesDirectory = fileURLToPath(new URL("./fixtures/control/", import.meta.url));

describe("control schema codecs", () => {
  for (const fixture of readdirSync(fixturesDirectory).filter((file) => file.endsWith(".json")).sort()) {
    test(`round-trips ${fixture}`, () => {
      const source = JSON.parse(readFileSync(`${fixturesDirectory}${fixture}`, "utf8"));
      const encoded = encodeFrame(decodeFrame(source));
      expect(JSON.parse(encoded)).toEqual(source);
    });
  }

  test("rejects request fields outside the closed schema", () => {
    expect(() => decodeFrame({
      type: "request",
      id: "status-1",
      verb: "status.get",
      payload: {},
      extra: true,
    })).toThrow("unknown field");
  });
});
