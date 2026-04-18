import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

import {
  COOKIE_TEMPLATE,
  inspectCookies,
  loadCookiesFile,
  normalizeCookieInput,
  saveCookiesFile,
  summarizeCookies,
} from "./cookies.js";
import { parseAnchorUrl } from "./anchors.js";
import { loadConfig, saveConfig } from "./config-store.js";
import { DEFAULT_MODEL, GEMINI_MODELS } from "./constants.js";
import { AppError, AuthError } from "./errors.js";
import { GeminiWebClient } from "./gemini-client.js";
import { validateProxyConnection } from "./http-client.js";
import { HistoryStore } from "./history-store.js";
import type { ConversationQuery } from "./history-store.js";
import { StateStore } from "./state-store.js";
import { SessionMemoryStore } from "./session-memory.js";
import type {
  CookieInspection,
  CookieRecord,
  ConversationLog,
  LogEntry,
  RuntimeConfig,
  SessionMemorySnapshot,
} from "./types.js";

export class ServiceManager {
  readonly events = new EventEmitter();

  private readonly logs: LogEntry[] = [];
  private readonly maxLogLines = 1500;
  private readonly conversations: ConversationLog[] = [];
  private readonly maxConversations = 500;
  private readonly bootTime = Date.now();
  private cookieWatcher?: NodeJS.Timeout;

  private config: RuntimeConfig;
  private cookieInspection: CookieInspection;
  private client: GeminiWebClient | null = null;
  private readonly historyStore: HistoryStore;
  private readonly stateStore: StateStore;
  private readonly sessionMemory = new SessionMemoryStore();
  private running = false;
  private lastInitError: string | null = null;
  private requestCount = 0;
  private errorCount = 0;
  private lastRequestAt: string | null = null;

  constructor() {
    this.config = loadConfig();
    this.historyStore = new HistoryStore(this.config.historyDbPath);
    this.stateStore = new StateStore();
    this.migrateLegacyCookies();
    this.cookieInspection = this.inspectCurrentCookies();
    this.startCookieWatcher();
  }

  private migrateLegacyCookies(): void {
    if (this.stateStore.hasCookies() || !fs.existsSync(this.config.cookieFilePath)) {
      return;
    }

    const raw = fs.readFileSync(this.config.cookieFilePath, "utf8").trim();
    if (!raw) {
      return;
    }

    const cookies = normalizeCookieInput(raw);
    this.stateStore.setCookiesRaw(`${JSON.stringify(cookies, null, 2)}\n`);
    this.log("info", "Imported legacy cookies.json into sqlite storage.");
  }

  private loadStoredCookies(): CookieRecord[] {
    const raw = this.stateStore.getCookiesRaw();
    if (raw?.trim()) {
      return normalizeCookieInput(raw);
    }

    return loadCookiesFile(this.config.cookieFilePath);
  }

  async bootstrap(): Promise<void> {
    this.log("info", "Gemini Bridge started. Loading runtime configuration.");

    if (this.loadStoredCookies().length > 0) {
      try {
        await this.startService();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown startup error";
        this.lastInitError = message;
        this.log("warn", `Cookie file found, but auto-start failed: ${message}`);
      }
    } else {
      this.log(
        "info",
        "No cookies.json file was found. The service started in management mode. Paste cookies in the dashboard to continue.",
      );
    }
  }

  private startCookieWatcher(): void {
    this.cookieWatcher = setInterval(() => {
      const next = this.inspectCurrentCookies();
      if (next.status !== this.cookieInspection.status || next.expiresAt !== this.cookieInspection.expiresAt) {
        this.cookieInspection = next;

        if (next.status === "expired") {
          this.log("warn", "Critical cookies expired. Update __Secure-1PSID and __Secure-1PSIDTS.");
        } else if (next.status === "expiring") {
          this.log("warn", `Critical cookies are expiring soon. Earliest expiry: ${next.expiresAt ?? "unknown"}`);
        } else if (next.status === "valid") {
          this.log("info", "Critical cookie status is healthy again.");
        }
      }
    }, this.config.cookieCheckIntervalMs);

    this.cookieWatcher.unref();
  }

  private inspectCurrentCookies(): CookieInspection {
    const cookies = this.loadStoredCookies();
    return inspectCookies(cookies);
  }

  log(level: LogEntry["level"], message: string): void {
    const entry: LogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogLines) {
      this.logs.shift();
    }
    this.events.emit("log", entry);
  }

  getLogs(lines = 200): LogEntry[] {
    return this.logs.slice(-lines);
  }

  recordConversation(entry: ConversationLog): void {
    this.conversations.push(entry);
    if (this.conversations.length > this.maxConversations) {
      this.conversations.shift();
    }
    this.historyStore.insertConversation(entry);
    this.events.emit("conversation", entry);
  }

  getConversations(query: ConversationQuery = {}): ConversationLog[] {
    return this.historyStore.getConversations(query);
  }

  getConversationById(id: string): ConversationLog | undefined {
    return this.historyStore.getConversationById(id);
  }

  exportConversations(query: ConversationQuery = {}): ConversationLog[] {
    return this.historyStore.exportConversations(query);
  }

  getSessionMemory(sessionKey?: string | null): SessionMemorySnapshot | SessionMemorySnapshot[] {
    if (sessionKey && sessionKey.trim()) {
      return this.sessionMemory.get(sessionKey);
    }
    return this.sessionMemory.getAll();
  }

  seedSessionMemory(input: {
    sessionKey: string | null | undefined;
    turns: Array<{ user: string; assistant: string }>;
    anchorSourcePath?: string | null;
  }): SessionMemorySnapshot {
    return this.sessionMemory.seedFromTranscript(input);
  }

  updateSessionMemory(input: {
    sessionKey: string | null | undefined;
    user: string;
    assistant: string;
    anchorSourcePath?: string | null;
  }): SessionMemorySnapshot {
    return this.sessionMemory.upsertTurn(input);
  }

  clearSessionMemory(sessionKey?: string | null): SessionMemorySnapshot[] {
    return this.sessionMemory.clear(sessionKey);
  }

  getModels(): string[] {
    return GEMINI_MODELS.map((item) => item.name);
  }

  getConfig(): RuntimeConfig {
    return this.config;
  }

  getAnchor() {
    return parseAnchorUrl(this.config.anchorUrl);
  }

  getEffectiveProxy(): string | null {
    return this.config.proxy?.trim() || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
  }

  getStatus() {
    this.cookieInspection = this.inspectCurrentCookies();
    return {
      service: this.running ? "running" : "stopped",
      uptimeMs: Date.now() - this.bootTime,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      lastRequestAt: this.lastRequestAt,
      proxy: this.config.proxy,
      effectiveProxy: this.getEffectiveProxy(),
      defaultModel: this.config.defaultModel || DEFAULT_MODEL,
      anchor: this.getAnchor(),
      cookieInspection: this.cookieInspection,
      cookieFilePath: this.stateStore.getDbPath(),
      historyDbPath: this.config.historyDbPath,
      historyConversationCount: this.historyStore.getConversationCount(),
      lastInitError: this.lastInitError,
    };
  }

  getCookiesPayload() {
    const raw = this.stateStore.getCookiesRaw() ?? `${JSON.stringify(COOKIE_TEMPLATE, null, 2)}\n`;
    const cookies = normalizeCookieInput(raw);

    return {
      raw,
      summary: summarizeCookies(cookies),
      inspection: inspectCookies(cookies),
      filePath: this.stateStore.getDbPath(),
    };
  }

  async updateCookies(rawInput: unknown) {
    const cookies = normalizeCookieInput(rawInput);
    this.stateStore.setCookiesRaw(`${JSON.stringify(cookies, null, 2)}\n`);
    this.cookieInspection = inspectCookies(cookies);
    this.log("info", `Cookie data updated in sqlite. Loaded ${cookies.length} entries.`);

    if (this.running) {
      await this.restartService();
    }

    return this.getCookiesPayload();
  }

  async updateProxy(proxy: string | null) {
    const normalizedProxy = proxy && proxy.trim() ? proxy.trim() : null;
    if (normalizedProxy) {
      await validateProxyConnection(normalizedProxy);
    }

    this.config = saveConfig({
      ...this.config,
      proxy: normalizedProxy,
    });

    this.log(
      "info",
      this.config.proxy ? `Proxy updated to ${this.config.proxy}` : "Proxy disabled.",
    );

    if (this.running) {
      await this.restartService();
    }

    return {
      proxy: this.config.proxy,
      restarted: this.running,
    };
  }

  async updateAnchor(url: string | null) {
    const anchor = parseAnchorUrl(url);
    if (!anchor.valid) {
      throw new AppError(anchor.error || "Invalid anchor link", 400, "invalid_anchor_url");
    }

    this.config = saveConfig({
      ...this.config,
      anchorUrl: anchor.url,
    });

    this.log(
      "info",
      anchor.enabled && anchor.sourcePath
        ? `Conversation anchor updated to ${anchor.sourcePath}`
        : "Conversation anchor disabled.",
    );

    return this.getAnchor();
  }

  async updateDefaultModel(model: string) {
    const normalizedModel = model.trim();
    if (!this.getModels().includes(normalizedModel)) {
      throw new AppError(`Unknown model: ${normalizedModel}`, 400, "invalid_model");
    }

    this.config = saveConfig({
      ...this.config,
      defaultModel: normalizedModel,
    });

    this.log("info", `Default model updated to ${normalizedModel}.`);

    if (this.running) {
      await this.restartService();
    }

    return {
      defaultModel: this.config.defaultModel,
      restarted: this.running,
    };
  }

  private buildClient(cookies: CookieRecord[]): GeminiWebClient {
    return new GeminiWebClient({
      cookies,
      proxyUrl: this.getEffectiveProxy(),
      defaultModel: this.config.defaultModel,
      onLog: (level, message) => this.log(level, message),
    });
  }

  async startService() {
    if (this.running && this.client) {
      return this.getStatus();
    }

    const cookies = this.loadStoredCookies();
    const inspection = inspectCookies(cookies);
    this.cookieInspection = inspection;

    if (inspection.status === "missing") {
      throw new AuthError(
        `Missing required cookies: ${inspection.requiredMissing.join(", ") || "__Secure-1PSID, __Secure-1PSIDTS"}`,
      );
    }

    const effectiveProxy = this.getEffectiveProxy();
    if (effectiveProxy) {
      this.log("info", `Checking proxy connectivity: ${effectiveProxy}`);
      await validateProxyConnection(effectiveProxy);
    }

    const client = this.buildClient(cookies);
    const anchor = this.getAnchor();
    try {
      await client.init(false, anchor.valid ? anchor.sourcePath : null);
      this.client = client;
      this.running = true;
      this.lastInitError = null;
      this.log("info", "Gemini service started.");
      return this.getStatus();
    } catch (error) {
      this.client = null;
      this.running = false;
      this.lastInitError = error instanceof Error ? error.message : "Initialization failed";
      this.log("error", `Gemini service failed to start: ${this.lastInitError}`);
      throw error;
    }
  }

  async stopService() {
    if (this.client) {
      await this.client.close();
    }
    this.client = null;
    this.running = false;
    this.log("info", "Gemini service stopped.");
    return this.getStatus();
  }

  async restartService() {
    await this.stopService();
    return this.startService();
  }

  async ensureClient(): Promise<GeminiWebClient> {
    if (!this.client || !this.running) {
      await this.startService();
    }
    if (!this.client) {
      throw new AppError("Gemini service is unavailable", 503, "service_unavailable");
    }
    return this.client;
  }

  markRequest(): void {
    this.requestCount += 1;
    this.lastRequestAt = new Date().toISOString();
  }

  markError(): void {
    this.errorCount += 1;
  }
}
