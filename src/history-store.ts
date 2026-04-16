import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ConversationLog } from "./types.js";
import { ensureDir } from "./utils.js";

type ConversationFilterStatus = "success" | "error";
type ConversationFilterOutcome = "answer" | "refusal" | "circuit_open" | "error";

export type ConversationQuery = {
  limit?: number;
  status?: ConversationFilterStatus | null;
  outcome?: ConversationFilterOutcome | null;
  query?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  includeBodies?: boolean;
  preset?: "recent_failures" | null;
};

type ConversationRow = {
  id: string;
  timestamp: string;
  model: string;
  requested_model: string | null;
  session_key: string;
  anchor_source_path: string | null;
  anchor_ephemeral: number;
  compacted: number;
  stream: number;
  status: string;
  status_code: number | null;
  error_message: string | null;
  prompt_preview: string;
  response_preview: string | null;
  duration_ms: number;
  response_id: string;
  prompt_tokens: number | null;
  source_prompt_tokens: number | null;
  memory_tokens: number | null;
  memory_turns: number | null;
  completion_tokens: number | null;
  outcome: string;
  completion_stage: string;
  refusal_kind: string | null;
  prompt_fingerprint: string | null;
  request_payload: string | null;
  prompt_body: string | null;
  response_body: string | null;
};

function toBoolean(value: number): boolean {
  return value === 1;
}

function mapRow(row: ConversationRow): ConversationLog {
  return {
    id: row.id,
    timestamp: row.timestamp,
    model: row.model,
    requestedModel: row.requested_model,
    sessionKey: row.session_key,
    anchorSourcePath: row.anchor_source_path,
    anchorEphemeral: toBoolean(row.anchor_ephemeral),
    compacted: toBoolean(row.compacted),
    stream: toBoolean(row.stream),
    status: row.status as ConversationLog["status"],
    statusCode: row.status_code,
    errorMessage: row.error_message,
    promptPreview: row.prompt_preview,
    responsePreview: row.response_preview,
    durationMs: row.duration_ms,
    responseId: row.response_id,
    promptTokens: row.prompt_tokens,
    sourcePromptTokens: row.source_prompt_tokens,
    memoryTokens: row.memory_tokens,
    memoryTurns: row.memory_turns,
    completionTokens: row.completion_tokens,
    outcome: row.outcome as ConversationLog["outcome"],
    completionStage: row.completion_stage as ConversationLog["completionStage"],
    refusalKind: row.refusal_kind as ConversationLog["refusalKind"],
    promptFingerprint: row.prompt_fingerprint,
    requestPayload: row.request_payload,
    promptBody: row.prompt_body,
    responseBody: row.response_body,
  };
}

export class HistoryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    ensureDir(path.dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        model TEXT NOT NULL,
        requested_model TEXT,
        session_key TEXT NOT NULL,
        anchor_source_path TEXT,
        anchor_ephemeral INTEGER NOT NULL,
        compacted INTEGER NOT NULL,
        stream INTEGER NOT NULL,
        status TEXT NOT NULL,
        status_code INTEGER,
        error_message TEXT,
        prompt_preview TEXT NOT NULL,
        response_preview TEXT,
        duration_ms INTEGER NOT NULL,
        response_id TEXT NOT NULL,
        prompt_tokens INTEGER,
        source_prompt_tokens INTEGER,
        memory_tokens INTEGER,
        memory_turns INTEGER,
        completion_tokens INTEGER,
        outcome TEXT NOT NULL,
        completion_stage TEXT NOT NULL,
        refusal_kind TEXT,
        prompt_fingerprint TEXT,
        request_payload TEXT,
        prompt_body TEXT,
        response_body TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_conversations_prompt_fingerprint ON conversations(prompt_fingerprint);
      CREATE INDEX IF NOT EXISTS idx_conversations_outcome_timestamp ON conversations(outcome, timestamp DESC);
    `);
  }

  insertConversation(entry: ConversationLog): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO conversations (
        id,
        timestamp,
        model,
        requested_model,
        session_key,
        anchor_source_path,
        anchor_ephemeral,
        compacted,
        stream,
        status,
        status_code,
        error_message,
        prompt_preview,
        response_preview,
        duration_ms,
        response_id,
        prompt_tokens,
        source_prompt_tokens,
        memory_tokens,
        memory_turns,
        completion_tokens,
        outcome,
        completion_stage,
        refusal_kind,
        prompt_fingerprint,
        request_payload,
        prompt_body,
        response_body
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      entry.id,
      entry.timestamp,
      entry.model,
      entry.requestedModel,
      entry.sessionKey,
      entry.anchorSourcePath,
      entry.anchorEphemeral ? 1 : 0,
      entry.compacted ? 1 : 0,
      entry.stream ? 1 : 0,
      entry.status,
      entry.statusCode,
      entry.errorMessage,
      entry.promptPreview,
      entry.responsePreview,
      entry.durationMs,
      entry.responseId,
      entry.promptTokens,
      entry.sourcePromptTokens,
      entry.memoryTokens,
      entry.memoryTurns,
      entry.completionTokens,
      entry.outcome,
      entry.completionStage,
      entry.refusalKind,
      entry.promptFingerprint,
      entry.requestPayload,
      entry.promptBody,
      entry.responseBody,
    );
  }

  private buildQueryParts(query: ConversationQuery = {}): {
    whereSql: string;
    params: Array<string | number | null>;
    limit: number;
  } {
    const whereParts: string[] = [];
    const params: Array<string | number | null> = [];

    if (query.preset === "recent_failures") {
      whereParts.push("(outcome IN ('refusal', 'circuit_open', 'error') OR status = 'error')");
    }

    if (query.status) {
      whereParts.push("status = ?");
      params.push(query.status);
    }

    if (query.outcome) {
      whereParts.push("outcome = ?");
      params.push(query.outcome);
    }

    if (query.dateFrom?.trim()) {
      whereParts.push("timestamp >= ?");
      params.push(query.dateFrom.trim());
    }

    if (query.dateTo?.trim()) {
      whereParts.push("timestamp <= ?");
      params.push(query.dateTo.trim());
    }

    const normalizedQuery = query.query?.trim().toLowerCase() ?? "";
    if (normalizedQuery) {
      const likeValue = `%${normalizedQuery}%`;
      whereParts.push(`(
        lower(id) LIKE ?
        OR lower(model) LIKE ?
        OR lower(coalesce(requested_model, '')) LIKE ?
        OR lower(session_key) LIKE ?
        OR lower(prompt_preview) LIKE ?
        OR lower(coalesce(response_preview, '')) LIKE ?
        OR lower(coalesce(error_message, '')) LIKE ?
        OR lower(coalesce(prompt_fingerprint, '')) LIKE ?
        OR lower(coalesce(request_payload, '')) LIKE ?
        OR lower(coalesce(prompt_body, '')) LIKE ?
        OR lower(coalesce(response_body, '')) LIKE ?
      )`);
      params.push(
        likeValue,
        likeValue,
        likeValue,
        likeValue,
        likeValue,
        likeValue,
        likeValue,
        likeValue,
        likeValue,
        likeValue,
        likeValue,
      );
    }

    return {
      whereSql: whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "",
      params,
      limit: Math.max(1, Math.min(1000, query.limit ?? 100)),
    };
  }

  getConversations(query: ConversationQuery = {}): ConversationLog[] {
    const built = this.buildQueryParts(query);
    const bodySelection = query.includeBodies
      ? "request_payload, prompt_body, response_body"
      : "NULL AS request_payload, NULL AS prompt_body, NULL AS response_body";
    const rows = this.db.prepare(`
      SELECT
        id,
        timestamp,
        model,
        requested_model,
        session_key,
        anchor_source_path,
        anchor_ephemeral,
        compacted,
        stream,
        status,
        status_code,
        error_message,
        prompt_preview,
        response_preview,
        duration_ms,
        response_id,
        prompt_tokens,
        source_prompt_tokens,
        memory_tokens,
        memory_turns,
        completion_tokens,
        outcome,
        completion_stage,
        refusal_kind,
        prompt_fingerprint,
        ${bodySelection}
      FROM conversations
      ${built.whereSql}
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(...built.params, built.limit) as ConversationRow[];

    return rows.map(mapRow);
  }

  getConversationById(id: string): ConversationLog | undefined {
    const row = this.db.prepare(`
      SELECT
        id,
        timestamp,
        model,
        requested_model,
        session_key,
        anchor_source_path,
        anchor_ephemeral,
        compacted,
        stream,
        status,
        status_code,
        error_message,
        prompt_preview,
        response_preview,
        duration_ms,
        response_id,
        prompt_tokens,
        source_prompt_tokens,
        memory_tokens,
        memory_turns,
        completion_tokens,
        outcome,
        completion_stage,
        refusal_kind,
        prompt_fingerprint,
        request_payload,
        prompt_body,
        response_body
      FROM conversations
      WHERE id = ?
      LIMIT 1
    `).get(id) as ConversationRow | undefined;

    return row ? mapRow(row) : undefined;
  }

  getConversationCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM conversations").get() as { total: number };
    return row.total;
  }

  exportConversations(query: ConversationQuery = {}): ConversationLog[] {
    return this.getConversations({
      ...query,
      includeBodies: true,
      limit: query.limit ?? 500,
    });
  }
}
