import path from "node:path";

import { APP_DATA_ROOT } from "./constants.js";
import type {
  SessionMemoryRecord,
  SessionMemorySnapshot,
  SessionMemoryTurn,
} from "./types.js";
import { clipText, ensureDir, readJsonFile, writeJsonFile } from "./utils.js";

const MEMORY_FILE = path.join(APP_DATA_ROOT, "data", "session-memory.json");
const MAX_RECENT_TURNS = 2;
const MAX_SUMMARY_CHARS = 900;
const MAX_USER_CHARS = 140;
const MAX_ASSISTANT_CHARS = 180;
const MAX_SESSION_KEY_CHARS = 120;

type MemoryFilePayload = {
  sessions?: Record<string, SessionMemoryRecord>;
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function summarizeTurn(turn: SessionMemoryTurn): string {
  return `U: ${turn.user}\nA: ${turn.assistant}`;
}

function trimSummary(summary: string): string {
  const lines = summary
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  while (lines.length > 0 && lines.join("\n").length > MAX_SUMMARY_CHARS) {
    lines.shift();
  }

  return lines.join("\n");
}

function appendToSummary(summary: string, turn: SessionMemoryTurn): string {
  const next = [summary.trim(), summarizeTurn(turn)].filter(Boolean).join("\n");
  return trimSummary(next);
}

function normalizeSessionKey(input: string | null | undefined): string {
  const trimmed = typeof input === "string" ? input.trim() : "";
  const fallback = trimmed || "default";
  const safe = fallback.replace(/[^\w.:/-]+/g, "-");
  return safe.slice(0, MAX_SESSION_KEY_CHARS) || "default";
}

function sanitizeTurn(user: string, assistant: string, createdAt: string): SessionMemoryTurn {
  return {
    user: clipText(user, MAX_USER_CHARS),
    assistant: clipText(assistant, MAX_ASSISTANT_CHARS),
    createdAt,
  };
}

function normalizeRecord(sessionKey: string, record?: Partial<SessionMemoryRecord> | null): SessionMemoryRecord {
  const safeKey = normalizeSessionKey(sessionKey);
  const recentTurns = Array.isArray(record?.recentTurns)
    ? record.recentTurns
        .filter((turn) => turn && typeof turn.user === "string" && typeof turn.assistant === "string")
        .slice(-MAX_RECENT_TURNS)
        .map((turn) => sanitizeTurn(turn.user, turn.assistant, typeof turn.createdAt === "string" ? turn.createdAt : new Date().toISOString()))
    : [];

  return {
    sessionKey: safeKey,
    summary: trimSummary(typeof record?.summary === "string" ? record.summary : ""),
    recentTurns,
    totalTurns: typeof record?.totalTurns === "number" && Number.isFinite(record.totalTurns) ? Math.max(0, record.totalTurns) : recentTurns.length,
    anchorSourcePath: typeof record?.anchorSourcePath === "string" ? record.anchorSourcePath : null,
    lastUpdatedAt: typeof record?.lastUpdatedAt === "string" ? record.lastUpdatedAt : recentTurns.at(-1)?.createdAt ?? new Date(0).toISOString(),
  };
}

export class SessionMemoryStore {
  private sessions: Record<string, SessionMemoryRecord>;

  constructor(private readonly filePath = MEMORY_FILE) {
    ensureDir(path.dirname(this.filePath));
    const payload = readJsonFile<MemoryFilePayload>(this.filePath, {});
    const entries = Object.entries(payload.sessions ?? {});
    this.sessions = Object.fromEntries(entries.map(([key, record]) => [normalizeSessionKey(key), normalizeRecord(key, record)]));
  }

  private persist(): void {
    writeJsonFile(this.filePath, { sessions: this.sessions });
  }

  private computeApproximateTokens(record: SessionMemoryRecord): number {
    const text = [record.summary, ...record.recentTurns.map((turn) => `${turn.user}\n${turn.assistant}`)].join("\n");
    return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
  }

  get(sessionKey: string | null | undefined): SessionMemorySnapshot {
    const safeKey = normalizeSessionKey(sessionKey);
    const record = this.sessions[safeKey];

    if (!record) {
      return {
        sessionKey: safeKey,
        summary: "",
        recentTurns: [],
        totalTurns: 0,
        anchorSourcePath: null,
        lastUpdatedAt: null,
        approximateTokens: 0,
      };
    }

    return {
      ...record,
      recentTurns: [...record.recentTurns],
      approximateTokens: this.computeApproximateTokens(record),
    };
  }

  getAll(): SessionMemorySnapshot[] {
    return Object.values(this.sessions)
      .map((record) => ({
        ...record,
        recentTurns: [...record.recentTurns],
        approximateTokens: this.computeApproximateTokens(record),
      }))
      .sort((left, right) => right.lastUpdatedAt.localeCompare(left.lastUpdatedAt));
  }

  upsertTurn(input: {
    sessionKey: string | null | undefined;
    user: string;
    assistant: string;
    anchorSourcePath?: string | null;
  }): SessionMemorySnapshot {
    const safeKey = normalizeSessionKey(input.sessionKey);
    const current = normalizeRecord(safeKey, this.sessions[safeKey]);
    const createdAt = new Date().toISOString();
    const nextTurn = sanitizeTurn(input.user, input.assistant, createdAt);
    const recentTurns = [...current.recentTurns, nextTurn];
    let summary = current.summary;

    while (recentTurns.length > MAX_RECENT_TURNS) {
      const oldest = recentTurns.shift();
      if (oldest) {
        summary = appendToSummary(summary, oldest);
      }
    }

    const nextRecord: SessionMemoryRecord = {
      sessionKey: safeKey,
      summary,
      recentTurns,
      totalTurns: current.totalTurns + 1,
      anchorSourcePath: input.anchorSourcePath ?? current.anchorSourcePath ?? null,
      lastUpdatedAt: createdAt,
    };

    this.sessions[safeKey] = nextRecord;
    this.persist();
    return this.get(safeKey);
  }

  seedFromTranscript(input: {
    sessionKey: string | null | undefined;
    turns: Array<{ user: string; assistant: string }>;
    anchorSourcePath?: string | null;
  }): SessionMemorySnapshot {
    const safeKey = normalizeSessionKey(input.sessionKey);
    const current = this.sessions[safeKey];
    if (current || input.turns.length === 0) {
      return this.get(safeKey);
    }

    let summary = "";
    const recentTurns: SessionMemoryTurn[] = [];
    const now = new Date().toISOString();

    input.turns.forEach((turn) => {
      const nextTurn = sanitizeTurn(turn.user, turn.assistant, now);
      recentTurns.push(nextTurn);
      if (recentTurns.length > MAX_RECENT_TURNS) {
        const oldest = recentTurns.shift();
        if (oldest) {
          summary = appendToSummary(summary, oldest);
        }
      }
    });

    this.sessions[safeKey] = {
      sessionKey: safeKey,
      summary,
      recentTurns,
      totalTurns: input.turns.length,
      anchorSourcePath: input.anchorSourcePath ?? null,
      lastUpdatedAt: now,
    };
    this.persist();
    return this.get(safeKey);
  }

  clear(sessionKey?: string | null): SessionMemorySnapshot[] {
    if (sessionKey && sessionKey.trim()) {
      const safeKey = normalizeSessionKey(sessionKey);
      delete this.sessions[safeKey];
    } else {
      this.sessions = {};
    }
    this.persist();
    return this.getAll();
  }
}
