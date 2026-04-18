import { AppError } from "./errors.js";
import type { AnchorConfig } from "./types.js";

const GEMINI_APP_URL_RE = /^https:\/\/gemini\.google\.com\/app\/([a-z0-9]+)(?:[/?#].*)?$/i;
const GEMINI_APP_PATH_RE = /^\/app\/([a-z0-9]+)$/i;

export function normalizeAnchorUrl(input: string | null | undefined): string | null {
  const trimmed = typeof input === "string" ? input.trim() : "";
  return trimmed ? trimmed : null;
}

export function parseAnchorUrl(url: string | null | undefined): AnchorConfig {
  const normalized = normalizeAnchorUrl(url);
  if (!normalized) {
    return {
      url: null,
      sourcePath: null,
      conversationId: null,
      enabled: false,
      valid: true,
      error: null,
    };
  }

  const match = normalized.match(GEMINI_APP_URL_RE);
  if (!match) {
    return {
      url: normalized,
      sourcePath: null,
      conversationId: null,
      enabled: true,
      valid: false,
      error: "Anchor link must look like https://gemini.google.com/app/<conversation-id>",
    };
  }

  const conversationId = match[1] ?? null;
  return {
    url: normalized,
    sourcePath: conversationId ? `/app/${conversationId}` : null,
    conversationId,
    enabled: true,
    valid: !!conversationId,
    error: conversationId ? null : "Missing Gemini conversation id in anchor link",
  };
}

export function assertAnchorSourcePath(sourcePath: string): string {
  if (!GEMINI_APP_PATH_RE.test(sourcePath)) {
    throw new AppError("Invalid anchor source path", 400, "invalid_anchor_source_path");
  }
  return sourcePath;
}
