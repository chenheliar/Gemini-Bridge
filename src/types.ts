export interface CookieRecord {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expirationDate?: number;
  sameSite?: string;
  storeId?: string;
  hostOnly?: boolean;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
}

export interface RuntimeConfig {
  port: number;
  host: string;
  defaultModel: string;
  proxy: string | null;
  anchorUrl: string | null;
  cookieFilePath: string;
  cookieCheckIntervalMs: number;
  historyDbPath: string;
}

export interface SessionMemoryTurn {
  user: string;
  assistant: string;
  createdAt: string;
}

export interface SessionMemoryRecord {
  sessionKey: string;
  summary: string;
  recentTurns: SessionMemoryTurn[];
  totalTurns: number;
  anchorSourcePath: string | null;
  lastUpdatedAt: string;
}

export interface SessionMemorySnapshot {
  sessionKey: string;
  summary: string;
  recentTurns: SessionMemoryTurn[];
  totalTurns: number;
  anchorSourcePath: string | null;
  lastUpdatedAt: string | null;
  approximateTokens: number;
}

export interface AnchorConfig {
  url: string | null;
  sourcePath: string | null;
  conversationId: string | null;
  enabled: boolean;
  valid: boolean;
  error: string | null;
}

export interface CookieInspection {
  status: "missing" | "valid" | "expiring" | "expired";
  checkedAt: string;
  expiresAt: string | null;
  requiredMissing: string[];
  totalCookies: number;
  expiringSoon: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

export interface TrafficAggregate {
  requests: number;
  successCount: number;
  errorCount: number;
  streamCount: number;
  requestBytes: number;
  responseBytes: number;
  totalBytes: number;
  promptTokens: number;
  completionTokens: number;
  averageLatencyMs: number;
  requestsPerMinute: number;
  bytesPerMinute: number;
  lastRequestAt: string | null;
}

export interface TrafficModelStat extends TrafficAggregate {
  model: string;
}

export interface TrafficSnapshot {
  startedAt: string | null;
  recentWindowMinutes: number;
  inFlight: number;
  lifetime: TrafficAggregate;
  recentWindow: TrafficAggregate;
  topModels: TrafficModelStat[];
}

export interface ConversationLog {
  id: string;
  timestamp: string;
  model: string;
  requestedModel: string | null;
  sessionKey: string;
  anchorSourcePath: string | null;
  anchorEphemeral: boolean;
  compacted: boolean;
  stream: boolean;
  status: "success" | "error";
  statusCode: number | null;
  errorMessage: string | null;
  promptPreview: string;
  responsePreview: string | null;
  durationMs: number;
  responseId: string;
  promptTokens: number | null;
  sourcePromptTokens: number | null;
  memoryTokens: number | null;
  memoryTurns: number | null;
  completionTokens: number | null;
  outcome: "answer" | "refusal" | "circuit_open" | "error";
  completionStage: "initial" | "text_only_retry" | "anchored_chat_retry" | "none";
  refusalKind: "image_mode" | "generic_capability" | null;
  promptFingerprint: string | null;
  requestPayload: string | null;
  promptBody: string | null;
  responseBody: string | null;
}

export interface GeminiStreamChunk {
  delta: string;
  fullText: string;
  candidateId: string;
  done: boolean;
}
