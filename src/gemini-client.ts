import { randomUUID } from "node:crypto";

import {
  ARTIFACTS_RE,
  CARD_CONTENT_RE,
  DEFAULT_GEMINI_HEADERS,
  DEFAULT_METADATA,
  ENDPOINTS,
  ERROR_CODES,
  GEMINI_MODEL_MAP,
  STREAMING_FLAG_INDEX,
  TEMPORARY_CHAT_FLAG_INDEX,
} from "./constants.js";
import { AuthError, GeminiApiError, ModelInvalidError, TemporarilyBlockedError, UsageLimitExceededError } from "./errors.js";
import { BrowserHttpClient } from "./http-client.js";
import { getDeltaByFpLen, parseResponseByFrame } from "./parser.js";
import type { CookieRecord, GeminiStreamChunk } from "./types.js";
import { cookiesToMap } from "./cookies.js";
import { createReqId, getNestedValue } from "./utils.js";

interface GeminiWebClientOptions {
  cookies: CookieRecord[];
  proxyUrl?: string | null;
  defaultModel: string;
  onLog?: (level: "info" | "warn" | "error" | "debug", message: string) => void;
}

export class GeminiWebClient {
  private http: BrowserHttpClient;
  private readonly cookies: CookieRecord[];
  private readonly proxyUrl: string | null;
  private readonly defaultModel: string;
  private readonly onLog?: (level: "info" | "warn" | "error" | "debug", message: string) => void;

  private accessToken: string | null = null;
  private buildLabel: string | null = null;
  private sessionId: string | null = null;
  private language = "en";
  private initialized = false;
  private initializedPath: string | null = null;

  constructor(options: GeminiWebClientOptions) {
    this.cookies = options.cookies;
    this.proxyUrl = options.proxyUrl ?? null;
    this.defaultModel = options.defaultModel;
    this.onLog = options.onLog;
    this.http = new BrowserHttpClient({
      proxyUrl: this.proxyUrl,
      initialCookies: cookiesToMap(this.cookies),
      timeoutMs: 600_000,
    });
  }

  private log(level: "info" | "warn" | "error" | "debug", message: string): void {
    this.onLog?.(level, message);
  }

  private extractField(html: string, fieldName: string): string | null {
    const regex = new RegExp(`\"${fieldName}\":\\s*\"(.*?)\"`);
    return html.match(regex)?.[1] ?? null;
  }

  private applySessionFields(html: string): void {
    this.accessToken = this.extractField(html, "SNlM0e");
    this.buildLabel = this.extractField(html, "cfb2h");
    this.sessionId = this.extractField(html, "FdrFJe");
    this.language = this.extractField(html, "TuX5cc") ?? this.language;
  }

  private hasSessionBootstrapData(): boolean {
    return Boolean(this.accessToken || this.buildLabel || this.sessionId);
  }

  async init(force = false, sourcePath?: string | null): Promise<void> {
    const initPath = sourcePath?.trim() || null;
    if (this.initialized && !force && this.initializedPath === initPath) {
      return;
    }

    this.log("info", "Initializing Gemini Web session...");
    await this.http.getText(ENDPOINTS.GOOGLE);
    const entryUrl = initPath ? `https://gemini.google.com${initPath}` : ENDPOINTS.INIT;
    const html = await this.http.getText(entryUrl, DEFAULT_GEMINI_HEADERS);
    this.applySessionFields(html);

    if (!this.accessToken && !initPath) {
      throw new AuthError("Could not extract SNlM0e from the Gemini page. This usually means the cookies are invalid or the request was blocked.");
    }

    if (!this.accessToken && initPath) {
      this.log(
        "warn",
        `SNlM0e was not present on ${initPath}. Falling back to the Gemini home page to recover session tokens.`,
      );

      const fallbackHtml = await this.http.getText(ENDPOINTS.INIT, DEFAULT_GEMINI_HEADERS);
      this.applySessionFields(fallbackHtml);
    }

    if (!this.hasSessionBootstrapData()) {
      throw new AuthError("Could not extract Gemini session bootstrap data. This usually means the cookies are invalid or the request was blocked.");
    }

    if (!this.accessToken) {
      this.log(
        "warn",
        "SNlM0e is unavailable in the current Gemini page payload. Continuing with session bootstrap fields only.",
      );
    }

    this.initialized = true;
    this.initializedPath = initPath;
    this.log("info", "Gemini Web session initialized.");
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.initializedPath = null;
  }

  private resolveModel(modelName?: string) {
    const resolved = GEMINI_MODEL_MAP.get(modelName ?? "") ?? GEMINI_MODEL_MAP.get(this.defaultModel);
    if (!resolved) {
      throw new ModelInvalidError(`Unknown model: ${modelName ?? this.defaultModel}`);
    }
    return resolved;
  }

  private extractCandidateText(candidateData: unknown): string {
    let text = getNestedValue(candidateData, [1, 0], "");
    if (typeof text !== "string") {
      text = "";
    }

    if (CARD_CONTENT_RE.test(text)) {
      const fallback = getNestedValue(candidateData, [22, 0], "");
      if (typeof fallback === "string" && fallback) {
        text = fallback;
      }
    }

    return text.replace(ARTIFACTS_RE, "");
  }

  private mapError(errorCode: number, modelName: string): never {
    switch (errorCode) {
      case ERROR_CODES.USAGE_LIMIT_EXCEEDED:
        throw new UsageLimitExceededError(`Model ${modelName} hit the usage limit. Please try again later or switch models.`);
      case ERROR_CODES.MODEL_INCONSISTENT:
      case ERROR_CODES.MODEL_HEADER_INVALID:
        throw new ModelInvalidError(`Model ${modelName} is unavailable, or the upstream request format has changed.`);
      case ERROR_CODES.IP_TEMPORARILY_BLOCKED:
        throw new TemporarilyBlockedError("The current IP may be temporarily restricted by Google. Please switch networks or use a proxy.");
      default:
        throw new GeminiApiError(`Gemini returned error code ${errorCode}`);
    }
  }

  private processFrames(
    frames: unknown[],
    modelName: string,
    lastText: string,
  ): { chunks: GeminiStreamChunk[]; lastText: string; sawChunk: boolean; sawDone: boolean } {
    let nextLastText = lastText;
    let sawChunk = false;
    let sawDone = false;
    const chunks: GeminiStreamChunk[] = [];

    for (const part of frames) {
      const errorCode = getNestedValue(part, [5, 2, 0, 1, 0], 0);
      if (typeof errorCode === "number" && errorCode > 0) {
        this.mapError(errorCode, modelName);
      }

      const innerJson = getNestedValue(part, [2], "");
      if (typeof innerJson !== "string" || !innerJson) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(innerJson);
      } catch {
        continue;
      }

      const candidates = getNestedValue(parsed, [4], [] as unknown[]);
      if (!Array.isArray(candidates) || candidates.length === 0) {
        continue;
      }

      const firstCandidate = candidates[0];
      const fullText = this.extractCandidateText(firstCandidate);
      const indicator = getNestedValue(firstCandidate, [8, 0], null);
      const done = indicator === 2 || indicator === null;
      sawDone ||= done;
      const deltaResult = getDeltaByFpLen(fullText, nextLastText, done);
      nextLastText = deltaResult.fullText;

      if (deltaResult.delta || done) {
        sawChunk = true;
        chunks.push({
          delta: deltaResult.delta,
          fullText: deltaResult.fullText,
          candidateId: String(getNestedValue(firstCandidate, [0], "") ?? ""),
          done,
        });
      }
    }

    return {
      chunks,
      lastText: nextLastText,
      sawChunk,
      sawDone,
    };
  }

  async *streamText(optionsPrompt: string, options?: {
    modelName?: string;
    temporary?: boolean;
    sourcePath?: string | null;
    maxAttempts?: number;
    reinitializeOnRetry?: boolean;
  }): AsyncGenerator<GeminiStreamChunk> {
    const model = this.resolveModel(options?.modelName);
    const prompt = optionsPrompt;
    const maxAttempts = Math.max(1, Math.min(3, options?.maxAttempts ?? 3));
    const reinitializeOnRetry = options?.reinitializeOnRetry ?? true;
    let bestPartialText = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.init(attempt > 1 && reinitializeOnRetry, options?.sourcePath);

      const innerReqList: unknown[] = new Array(69).fill(null);
      innerReqList[0] = [prompt, 0, null, null, null, null, 0];
      innerReqList[1] = [this.language];
      innerReqList[2] = DEFAULT_METADATA;
      innerReqList[6] = [1];
      innerReqList[STREAMING_FLAG_INDEX] = 1;
      innerReqList[10] = 1;
      innerReqList[11] = 0;
      innerReqList[17] = [[0]];
      innerReqList[18] = 0;
      innerReqList[27] = 1;
      innerReqList[30] = [4];
      innerReqList[41] = [1];
      innerReqList[53] = 0;
      innerReqList[61] = [];
      innerReqList[68] = 2;
      if (options?.temporary) {
        innerReqList[TEMPORARY_CHAT_FLAG_INDEX] = 1;
      }

      const requestUuid = randomUUID().toUpperCase();
      innerReqList[59] = requestUuid;

      const params: Record<string, string> = {
        hl: this.language,
        _reqid: createReqId(),
        rt: "c",
      };
      if (options?.sourcePath?.trim()) {
        params["source-path"] = options.sourcePath.trim();
      }
      if (this.buildLabel) {
        params.bl = this.buildLabel;
      }
      if (this.sessionId) {
        params["f.sid"] = this.sessionId;
      }

      const body = new URLSearchParams();
      body.set("at", this.accessToken ?? "");
      body.set("f.req", JSON.stringify([null, JSON.stringify(innerReqList)]));

      const response = await this.http.postStream(
        ENDPOINTS.GENERATE,
        body.toString(),
        {
          ...DEFAULT_GEMINI_HEADERS,
          ...model.header,
          "x-goog-ext-525005358-jspb": `[\"${requestUuid}\",1]`,
        },
        params,
      );

      if (response.status !== 200) {
        throw new GeminiApiError(`Gemini StreamGenerate request failed with status ${response.status}`);
      }

      let buffer = "";
      let lastText = "";
      let sawChunk = false;
      let sawDone = false;
      let rawResponse = "";

      // Use TextDecoder for proper incremental UTF-8 decoding.
      // Unlike chunk.toString("utf8") which produces replacement characters (U+FFFD)
      // when multi-byte UTF-8 sequences are split across TCP chunks, TextDecoder
      // correctly buffers incomplete sequences and decodes them once all bytes arrive.
      const decoder = new TextDecoder("utf8", { fatal: false });

      for await (const chunk of response.data as AsyncIterable<Buffer>) {
        const decoded = decoder.decode(chunk, { stream: true });
        rawResponse += decoded;
        buffer += decoded;
        if (buffer.startsWith(")]}'")) {
          buffer = buffer.slice(4).trimStart();
        }

        const { frames, remaining } = parseResponseByFrame(buffer);
        buffer = remaining;

        const processed = this.processFrames(frames, model.name, lastText);
        lastText = processed.lastText;
        sawChunk ||= processed.sawChunk;
        sawDone ||= processed.sawDone;
        for (const parsedChunk of processed.chunks) {
          yield parsedChunk;
        }
      }

      const finalDecoded = decoder.decode();
      rawResponse += finalDecoded;
      buffer += finalDecoded;
      const { frames, remaining } = parseResponseByFrame(buffer);
      buffer = remaining;

      const processed = this.processFrames(frames, model.name, lastText);
      lastText = processed.lastText;
      sawChunk ||= processed.sawChunk;
      sawDone ||= processed.sawDone;
      for (const parsedChunk of processed.chunks) {
        yield parsedChunk;
      }

      if (sawChunk && sawDone) {
        return;
      }

      const normalizedRaw = rawResponse.startsWith(")]}'")
        ? rawResponse.slice(4).trimStart()
        : rawResponse;
      const fullReplay = this.processFrames(parseResponseByFrame(normalizedRaw).frames, model.name, "");
      if (fullReplay.sawChunk && fullReplay.sawDone) {
        this.log("warn", "Recovered Gemini response by replaying the full upstream payload after stream parsing produced no text.");
        for (const parsedChunk of fullReplay.chunks) {
          yield parsedChunk;
        }
        return;
      }

      const recoveredPartial = [fullReplay.lastText, lastText]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .sort((left, right) => right.length - left.length)[0] ?? "";
      if (recoveredPartial.length > bestPartialText.length) {
        bestPartialText = recoveredPartial;
      }

      if (attempt < maxAttempts) {
        this.log(
          "warn",
          reinitializeOnRetry
            ? "Gemini stream ended without a completed answer. Reinitializing the session and retrying."
            : "Gemini stream ended without a completed answer. Retrying once without reinitializing the session.",
        );
        continue;
      }
    }

    if (bestPartialText.trim()) {
      this.log(
        "warn",
        `Gemini stream never emitted a completed frame, but recovered ${bestPartialText.length} characters of partial text. Returning the recovered content instead of failing the request.`,
      );
      yield {
        delta: bestPartialText,
        fullText: bestPartialText,
        candidateId: "partial_recovered",
        done: true,
      };
      return;
    }

    throw new GeminiApiError("Gemini returned no completed text. The upstream request may have been interrupted, or the cookies may be invalid.", 502, "incomplete_stream");
  }

  async generateText(prompt: string, options?: {
    modelName?: string;
    temporary?: boolean;
    sourcePath?: string | null;
    maxAttempts?: number;
    reinitializeOnRetry?: boolean;
  }): Promise<string> {
    let finalText = "";
    for await (const chunk of this.streamText(prompt, options)) {
      finalText = chunk.fullText || `${finalText}${chunk.delta}`;
    }
    return finalText;
  }
}
