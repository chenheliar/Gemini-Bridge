import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { APP_DATA_ROOT } from "./constants.js";
import type { TrafficAggregate, TrafficModelStat, TrafficSnapshot } from "./types.js";
import { ensureDir } from "./utils.js";

const COOKIE_STATE_KEY = "cookies_raw";

type TrafficEventInput = {
  timestamp: string;
  model: string;
  success: boolean;
  stream: boolean;
  requestBytes: number;
  responseBytes: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
};

type TrafficAggregateRow = {
  requests: number;
  success_count: number | null;
  error_count: number | null;
  stream_count: number | null;
  request_bytes: number | null;
  response_bytes: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_duration_ms: number | null;
  last_request_at: string | null;
  started_at: string | null;
};

type TrafficModelRow = TrafficAggregateRow & {
  model: string;
};

function finalizeTrafficAggregate(row: TrafficAggregateRow | undefined, elapsedMs: number): TrafficAggregate {
  const requestBytes = row?.request_bytes ?? 0;
  const responseBytes = row?.response_bytes ?? 0;
  const totalBytes = requestBytes + responseBytes;
  const requests = row?.requests ?? 0;
  const minutes = elapsedMs > 0 ? elapsedMs / 60_000 : 0;

  return {
    requests,
    successCount: row?.success_count ?? 0,
    errorCount: row?.error_count ?? 0,
    streamCount: row?.stream_count ?? 0,
    requestBytes,
    responseBytes,
    totalBytes,
    promptTokens: row?.prompt_tokens ?? 0,
    completionTokens: row?.completion_tokens ?? 0,
    averageLatencyMs: requests > 0 ? Math.round((row?.total_duration_ms ?? 0) / requests) : 0,
    requestsPerMinute: minutes > 0 ? Number((requests / minutes).toFixed(2)) : requests,
    bytesPerMinute: minutes > 0 ? Math.round(totalBytes / minutes) : totalBytes,
    lastRequestAt: row?.last_request_at ?? null,
  };
}

function resolveElapsedMs(startedAt: string | null, nowMs: number, fallbackWindowMs?: number): number {
  if (!startedAt) {
    return 0;
  }

  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) {
    return 0;
  }

  const elapsedMs = Math.max(1, nowMs - startedAtMs);
  return typeof fallbackWindowMs === "number" ? Math.min(fallbackWindowMs, elapsedMs) : elapsedMs;
}

export class StateStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;

  constructor(dbPath = path.join(APP_DATA_ROOT, "data", "state.db")) {
    this.dbPath = dbPath;
    ensureDir(path.dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value_text TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS traffic_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        model TEXT NOT NULL,
        success INTEGER NOT NULL,
        stream INTEGER NOT NULL,
        request_bytes INTEGER NOT NULL,
        response_bytes INTEGER NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_traffic_events_timestamp ON traffic_events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_traffic_events_model_timestamp ON traffic_events(model, timestamp DESC);
    `);
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getText(key: string): string | null {
    const row = this.db
      .prepare("SELECT value_text FROM app_state WHERE key = ? LIMIT 1")
      .get(key) as { value_text: string } | undefined;

    return row?.value_text ?? null;
  }

  setText(key: string, value: string): void {
    this.db
      .prepare(`
        INSERT INTO app_state (key, value_text, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_text = excluded.value_text,
          updated_at = excluded.updated_at
      `)
      .run(key, value, new Date().toISOString());
  }

  hasCookies(): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM app_state WHERE key = ? LIMIT 1")
      .get(COOKIE_STATE_KEY) as { found: number } | undefined;

    return row?.found === 1;
  }

  getCookiesRaw(): string | null {
    return this.getText(COOKIE_STATE_KEY);
  }

  setCookiesRaw(raw: string): void {
    this.setText(COOKIE_STATE_KEY, raw);
  }

  insertTrafficEvent(event: TrafficEventInput): void {
    this.db
      .prepare(`
        INSERT INTO traffic_events (
          timestamp,
          model,
          success,
          stream,
          request_bytes,
          response_bytes,
          prompt_tokens,
          completion_tokens,
          duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.timestamp,
        event.model,
        event.success ? 1 : 0,
        event.stream ? 1 : 0,
        event.requestBytes,
        event.responseBytes,
        event.promptTokens,
        event.completionTokens,
        event.durationMs,
      );
  }

  getTrafficSnapshot(input: { recentWindowMs: number; inFlight: number; now?: number }): TrafficSnapshot {
    const nowMs = input.now ?? Date.now();
    const recentSince = new Date(nowMs - input.recentWindowMs).toISOString();

    const lifetimeRow = this.db.prepare(`
      SELECT
        COUNT(*) AS requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS stream_count,
        SUM(request_bytes) AS request_bytes,
        SUM(response_bytes) AS response_bytes,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(duration_ms) AS total_duration_ms,
        MAX(timestamp) AS last_request_at,
        MIN(timestamp) AS started_at
      FROM traffic_events
    `).get() as TrafficAggregateRow | undefined;

    const recentRow = this.db.prepare(`
      SELECT
        COUNT(*) AS requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS stream_count,
        SUM(request_bytes) AS request_bytes,
        SUM(response_bytes) AS response_bytes,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(duration_ms) AS total_duration_ms,
        MAX(timestamp) AS last_request_at,
        MIN(timestamp) AS started_at
      FROM traffic_events
      WHERE timestamp >= ?
    `).get(recentSince) as TrafficAggregateRow | undefined;

    const topModelRows = this.db.prepare(`
      SELECT
        model,
        COUNT(*) AS requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS stream_count,
        SUM(request_bytes) AS request_bytes,
        SUM(response_bytes) AS response_bytes,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(duration_ms) AS total_duration_ms,
        MAX(timestamp) AS last_request_at,
        MIN(timestamp) AS started_at
      FROM traffic_events
      GROUP BY model
      ORDER BY requests DESC, total_duration_ms DESC
      LIMIT 5
    `).all() as TrafficModelRow[];

    const topModels: TrafficModelStat[] = topModelRows.map((row) => ({
      model: row.model,
      ...finalizeTrafficAggregate(row, resolveElapsedMs(row.started_at, nowMs)),
    }));

    return {
      startedAt: lifetimeRow?.started_at ?? null,
      recentWindowMinutes: input.recentWindowMs / 60_000,
      inFlight: input.inFlight,
      lifetime: finalizeTrafficAggregate(lifetimeRow, resolveElapsedMs(lifetimeRow?.started_at ?? null, nowMs)),
      recentWindow: finalizeTrafficAggregate(
        recentRow,
        resolveElapsedMs(recentRow?.started_at ?? null, nowMs, input.recentWindowMs),
      ),
      topModels,
    };
  }
}
