import fs from "node:fs";
import path from "node:path";

export function ensureDir(targetPath: string): void {
  fs.mkdirSync(targetPath, { recursive: true });
}

export function writeJsonFile(targetPath: string, value: unknown): void {
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJsonFile<T>(targetPath: string, fallback: T): T {
  if (!fs.existsSync(targetPath)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(targetPath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function maskValue(value: string, head = 8, tail = 6): string {
  if (!value) {
    return "";
  }
  if (value.length <= head + tail) {
    return value;
  }
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function getNestedValue<T = unknown>(data: unknown, path: Array<number | string>, defaultValue: T): T {
  let current: unknown = data;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(current) || key < 0 || key >= current.length) {
        return defaultValue;
      }
      current = current[key];
      continue;
    }

    if (!current || typeof current !== "object" || !(key in current)) {
      return defaultValue;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return (current as T) ?? defaultValue;
}

export function createReqId(): string {
  return String(100000 + Math.floor(Math.random() * 900000));
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function clipText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }

  if (maxChars < 32) {
    return normalized.slice(0, maxChars);
  }

  const head = Math.ceil(maxChars * 0.72);
  const tail = Math.max(8, maxChars - head - 3);
  return `${normalized.slice(0, head)}...${normalized.slice(-tail)}`;
}
