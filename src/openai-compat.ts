import { z } from "zod";

import { DEFAULT_MODEL } from "./constants.js";
import { InvalidRequestError } from "./errors.js";
import { clipText } from "./utils.js";
import type { SessionMemorySnapshot } from "./types.js";

const supportedMessageRoles = new Set(["system", "developer", "user", "assistant", "tool"]);

export const chatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(z.any()).min(1),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  user: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
}).passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

export type NormalizedMessage = {
  role: string;
  content: string;
  name?: string;
};

type GeminiPromptBuildOptions = {
  anchored?: boolean;
  memory?: SessionMemorySnapshot | null;
};

type GeminiPromptBuildResult = {
  promptText: string;
  sourcePromptText: string;
  compacted: boolean;
};

export type ParsedConversation = {
  instructions: string[];
  transcript: NormalizedMessage[];
};

const ANCHORED_PROMPT_SOFT_CAP_TOKENS = 2100;
const ANCHORED_MEMORY_HARD_CAP_TOKENS = 320;

export function approxTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export function normalizeMessageContent(content: unknown): string {
  if (content == null) {
    return "";
  }

  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    throw new InvalidRequestError("Only text message content is supported.", "unsupported_content");
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        throw new InvalidRequestError("Each message part must be an object.", "invalid_message_part");
      }
      const record = item as Record<string, unknown>;
      const partType = String(record.type ?? "");
      if (partType === "text" || partType === "input_text") {
        return String(record.text ?? record.input_text ?? "").trim();
      }
      throw new InvalidRequestError("This bridge currently supports text parts only.", "unsupported_message_part");
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function roleLabel(role: string, name?: string): string {
  if (role === "system") return "System";
  if (role === "developer") return "Developer";
  if (role === "assistant") return "Assistant";
  if (role === "tool") return name ? `Tool (${name})` : "Tool";
  return "User";
}

export function parseMessages(messages: Array<Record<string, unknown>>): ParsedConversation {
  const instructions: string[] = [];
  const transcript: NormalizedMessage[] = [];

  messages.forEach((message, index) => {
    if (!message || typeof message !== "object") {
      throw new InvalidRequestError(`messages[${index}] must be an object.`);
    }
    const role = String(message.role ?? "").trim();
    if (!supportedMessageRoles.has(role)) {
      throw new InvalidRequestError(`Unsupported message role: ${role || "unknown"}`);
    }

    const content = normalizeMessageContent(message.content);
    if (!content) {
      return;
    }

    if (role === "system" || role === "developer") {
      instructions.push(content);
      return;
    }

    transcript.push({
      role,
      content,
      name: typeof message.name === "string" ? message.name : undefined,
    });
  });

  if (transcript.length === 0) {
    throw new InvalidRequestError("At least one non-system text message is required.");
  }

  return { instructions, transcript };
}

function renderFullConversationPrompt(instructions: string[], transcript: NormalizedMessage[]): string {
  const promptParts = [
    "You are answering through an OpenAI-compatible chat bridge backed by Gemini Web.",
    "Reply as the assistant to the latest user request.",
    "Do not mention the bridge or the prompt formatting.",
  ];

  if (instructions.length > 0) {
    promptParts.push("System instructions:");
    instructions.forEach((instruction) => promptParts.push(`- ${instruction}`));
  }

  promptParts.push("Conversation:");
  transcript.forEach((message) => {
    promptParts.push(`${roleLabel(message.role, message.name)}: ${message.content}`);
  });
  promptParts.push("Assistant:");

  return promptParts.join("\n").trim();
}

function getLatestTurn(transcript: NormalizedMessage[]): NormalizedMessage[] {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "user") {
      return transcript.slice(index);
    }
  }

  return transcript.slice(-1);
}

function tryAppendWithinBudget(parts: string[], line: string, remainingTokens: number): number {
  if (!line.trim()) {
    return remainingTokens;
  }

  const cost = approxTokens(line);
  if (cost > remainingTokens) {
    return remainingTokens;
  }

  parts.push(line);
  return remainingTokens - cost;
}

function tryAppendClippedWithinBudget(
  parts: string[],
  label: string,
  value: string,
  remainingTokens: number,
  maxChars: number,
): number {
  if (!value.trim() || remainingTokens <= 0) {
    return remainingTokens;
  }

  const maxAffordableChars = Math.max(48, remainingTokens * 4 - label.length - 8);
  const clipped = clipText(value, Math.min(maxChars, maxAffordableChars));
  return tryAppendWithinBudget(parts, `${label}${clipped}`, remainingTokens);
}

function renderContinuityBlock(memory: SessionMemorySnapshot | null | undefined, tokenBudget: number): string[] {
  if (!memory || tokenBudget <= 0 || (!memory.summary && memory.recentTurns.length === 0)) {
    return [];
  }

  const promptParts: string[] = [];
  let remainingTokens = tokenBudget;

  remainingTokens = tryAppendWithinBudget(promptParts, "Gateway continuity state:", remainingTokens);
  if (memory.summary) {
    remainingTokens = tryAppendClippedWithinBudget(promptParts, "State: ", memory.summary, remainingTokens, 520);
  }

  if (memory.recentTurns.length > 0) {
    memory.recentTurns.slice(-2).forEach((turn, index) => {
      remainingTokens = tryAppendClippedWithinBudget(
        promptParts,
        `U${index + 1}: `,
        turn.user,
        remainingTokens,
        96,
      );
      remainingTokens = tryAppendClippedWithinBudget(
        promptParts,
        `A${index + 1}: `,
        turn.assistant,
        remainingTokens,
        132,
      );
    });
  }

  return promptParts;
}

function renderAnchoredPrompt(
  instructions: string[],
  transcript: NormalizedMessage[],
  memory?: SessionMemorySnapshot | null,
): string {
  const latestTurn = getLatestTurn(transcript);
  const hasContinuity = Boolean(memory && (memory.summary || memory.recentTurns.length > 0));
  const prefixParts = [
    "Answer only the latest user request in plain text.",
    "Do not switch into image generation, image editing, or media creation mode.",
    "Do not reply with image-policy boilerplate unless the user explicitly asked for an image.",
  ];

  if (hasContinuity) {
    prefixParts.push("Continuity notes:");
  }

  if (instructions.length > 0) {
    prefixParts.push("System instructions:");
    instructions.forEach((instruction) => prefixParts.push(`- ${instruction}`));
  }

  const suffixParts = ["Latest turn:"];
  latestTurn.forEach((message) => {
    suffixParts.push(`${roleLabel(message.role, message.name)}: ${message.content}`);
  });
  suffixParts.push("Assistant:");

  const basePromptText = [...prefixParts, ...suffixParts].join("\n").trim();
  const basePromptTokens = approxTokens(basePromptText);
  const memoryTokenBudget = Math.max(
    0,
    Math.min(ANCHORED_MEMORY_HARD_CAP_TOKENS, ANCHORED_PROMPT_SOFT_CAP_TOKENS - basePromptTokens),
  );
  const promptParts = [
    ...prefixParts,
    ...renderContinuityBlock(memory, memoryTokenBudget),
    ...suffixParts,
  ];

  return promptParts.join("\n").trim();
}

export function buildGeminiPrompt(
  messages: Array<Record<string, unknown>>,
  options: GeminiPromptBuildOptions = {},
): GeminiPromptBuildResult {
  const { instructions, transcript } = parseMessages(messages);
  const sourcePromptText = renderFullConversationPrompt(instructions, transcript);
  const promptText = options.anchored
    ? renderAnchoredPrompt(instructions, transcript, options.memory)
    : sourcePromptText;

  return {
    promptText,
    sourcePromptText,
    compacted: Boolean(options.anchored && promptText !== sourcePromptText),
  };
}

export function renderMessagesForGemini(messages: Array<Record<string, unknown>>): string {
  return buildGeminiPrompt(messages).promptText;
}

export function extractLatestUserMessage(messages: Array<Record<string, unknown>>): string {
  const { transcript } = parseMessages(messages);
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === "user") {
      return transcript[index].content;
    }
  }
  return transcript.at(-1)?.content ?? "";
}

export function buildTurnSeedFromTranscript(messages: Array<Record<string, unknown>>): Array<{ user: string; assistant: string }> {
  const { transcript } = parseMessages(messages);
  const turns: Array<{ user: string; assistant: string }> = [];
  let pendingUser = "";

  transcript.forEach((message) => {
    if (message.role === "user") {
      pendingUser = message.content;
      return;
    }

    if (message.role === "assistant" && pendingUser) {
      turns.push({ user: pendingUser, assistant: message.content });
      pendingUser = "";
    }
  });

  return turns;
}

export function resolveRequestedModel(requestedModel: string | undefined, availableModels: Set<string>): string {
  const candidate = (requestedModel ?? "").trim();
  if (candidate && availableModels.has(candidate)) {
    return candidate;
  }
  if (candidate.startsWith("gpt-") || candidate.startsWith("o")) {
    return DEFAULT_MODEL;
  }
  if (candidate) {
    throw new InvalidRequestError(`Unsupported model: ${candidate}`, "unsupported_model");
  }
  return DEFAULT_MODEL;
}

export function buildChatCompletionPayload(params: {
  responseId: string;
  modelName: string;
  content: string;
  promptText: string;
  created?: number;
}) {
  const created = params.created ?? Math.floor(Date.now() / 1000);
  const promptTokens = approxTokens(params.promptText);
  const completionTokens = approxTokens(params.content);

  return {
    id: params.responseId,
    object: "chat.completion",
    created,
    model: params.modelName,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: params.content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export function buildChatCompletionChunk(params: {
  responseId: string;
  modelName: string;
  delta: Record<string, unknown>;
  created?: number;
  finishReason?: string | null;
}) {
  return {
    id: params.responseId,
    object: "chat.completion.chunk",
    created: params.created ?? Math.floor(Date.now() / 1000),
    model: params.modelName,
    choices: [
      {
        index: 0,
        delta: params.delta,
        finish_reason: params.finishReason ?? null,
      },
    ],
  };
}

export function buildOpenAiError(message: string, type = "invalid_request_error", code?: string) {
  return {
    error: {
      message,
      type,
      code,
    },
  };
}
