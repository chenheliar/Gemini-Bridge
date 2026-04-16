import fs from "node:fs";
import path from "node:path";

import { REQUIRED_COOKIE_NAMES } from "./constants.js";
import type { CookieInspection, CookieRecord } from "./types.js";
import { ensureDir, maskValue, writeJsonFile } from "./utils.js";

function fromObjectMap(input: Record<string, unknown>): CookieRecord[] {
  return Object.entries(input).map(([name, value]) => ({
    name,
    value: String(value ?? ""),
    domain: ".google.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction",
    session: false,
  }));
}

function normalizeCookieEntry(entry: unknown): CookieRecord {
  if (!entry || typeof entry !== "object") {
    throw new Error("Each cookie entry must be an object.");
  }

  const record = entry as Record<string, unknown>;
  const name = String(record.name ?? "").trim();
  const value = String(record.value ?? "");

  if (!name || !value) {
    throw new Error("Each cookie entry must include both name and value.");
  }

  return {
    name,
    value,
    domain: typeof record.domain === "string" ? record.domain : ".google.com",
    path: typeof record.path === "string" ? record.path : "/",
    expirationDate: typeof record.expirationDate === "number" ? record.expirationDate : undefined,
    sameSite: typeof record.sameSite === "string" ? record.sameSite : undefined,
    storeId: typeof record.storeId === "string" ? record.storeId : undefined,
    hostOnly: typeof record.hostOnly === "boolean" ? record.hostOnly : undefined,
    httpOnly: typeof record.httpOnly === "boolean" ? record.httpOnly : undefined,
    secure: typeof record.secure === "boolean" ? record.secure : true,
    session: typeof record.session === "boolean" ? record.session : undefined,
  };
}

export function normalizeCookieInput(input: unknown): CookieRecord[] {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;

  if (Array.isArray(parsed)) {
    return parsed.map(normalizeCookieEntry);
  }

  if (parsed && typeof parsed === "object") {
    return fromObjectMap(parsed as Record<string, unknown>);
  }

  throw new Error("Cookie data must be a JSON array or object.");
}

export function loadCookiesFile(filePath: string): CookieRecord[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return [];
  }

  return normalizeCookieInput(raw);
}

export function saveCookiesFile(filePath: string, cookies: CookieRecord[]): void {
  ensureDir(path.dirname(filePath));
  writeJsonFile(filePath, cookies);
}

export function cookiesToMap(cookies: CookieRecord[]): Record<string, string> {
  return Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value]));
}

export function inspectCookies(cookies: CookieRecord[]): CookieInspection {
  const now = Date.now();
  const requiredMissing = REQUIRED_COOKIE_NAMES.filter(
    (name) => !cookies.some((cookie) => cookie.name === name && cookie.value),
  );

  const criticalCookies = cookies.filter((cookie) =>
    REQUIRED_COOKIE_NAMES.includes(cookie.name as (typeof REQUIRED_COOKIE_NAMES)[number]),
  );

  const expirations = criticalCookies
    .map((cookie) => (typeof cookie.expirationDate === "number" ? cookie.expirationDate * 1000 : null))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const earliest = expirations.length > 0 ? Math.min(...expirations) : null;
  let status: CookieInspection["status"] = "valid";

  if (requiredMissing.length > 0 || cookies.length === 0) {
    status = "missing";
  } else if (earliest !== null && earliest <= now) {
    status = "expired";
  } else if (earliest !== null && earliest - now < 24 * 60 * 60 * 1000) {
    status = "expiring";
  }

  return {
    status,
    checkedAt: new Date(now).toISOString(),
    expiresAt: earliest ? new Date(earliest).toISOString() : null,
    requiredMissing,
    totalCookies: cookies.length,
    expiringSoon: status === "expiring",
  };
}

export function summarizeCookies(cookies: CookieRecord[]): Array<{ name: string; preview: string; expiresAt: string | null }> {
  return cookies.map((cookie) => ({
    name: cookie.name,
    preview: maskValue(cookie.value),
    expiresAt: typeof cookie.expirationDate === "number" ? new Date(cookie.expirationDate * 1000).toISOString() : null,
  }));
}

export const COOKIE_TEMPLATE: CookieRecord[] = [
  {
    name: "__Secure-1PSID",
    value: "paste-your-value",
    domain: ".google.com",
    path: "/",
    secure: true,
    httpOnly: true,
  },
  {
    name: "__Secure-1PSIDTS",
    value: "paste-your-value",
    domain: ".google.com",
    path: "/",
    secure: true,
    httpOnly: true,
  },
  {
    name: "__Secure-1PSIDCC",
    value: "optional",
    domain: ".google.com",
    path: "/",
    secure: true,
    httpOnly: true,
  },
];
