import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const E164 = /^\+[1-9]\d{1,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AllowlistConfig {
  readonly allowlistHandle: string;
}

/**
 * Normalizes only handles whose country code is already explicit. Bare digits
 * are deliberately rejected rather than assuming a local dialing plan.
 */
export function normalizeHandle(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const phone = trimmed.replace(/[\s-]+/g, "");
  if (phone.startsWith("+")) {
    return E164.test(phone) ? phone : undefined;
  }
  if (/^\d+$/.test(phone)) {
    return undefined;
  }

  const email = trimmed.toLowerCase();
  return EMAIL.test(email) ? email : undefined;
}

export function isAllowedHandle(candidate: string | null | undefined, allowlistHandle: string): boolean {
  const configured = normalizeHandle(allowlistHandle);
  return configured !== undefined && normalizeHandle(candidate) === configured;
}

export function hashHandle(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function readAllowlistConfig(path: string): Promise<AllowlistConfig> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("config.json must contain an object");
  }

  const allowlistHandle = (parsed as Record<string, unknown>).allowlistHandle;
  const configured = typeof allowlistHandle === "string" ? normalizeHandle(allowlistHandle) : undefined;
  if (configured === undefined) {
    throw new Error("config.json must contain a valid allowlistHandle");
  }
  return { allowlistHandle: configured };
}
