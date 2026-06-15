import { randomUUID } from "node:crypto";

import { InvalidRequestError } from "./errors.js";

export type ChatToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
};

export type ToolChoice = "auto" | "none" | "required" | {
  type?: string;
  function?: {
    name?: string;
  };
};

export type ParsedToolDecision =
  | {
      type: "message";
      content: string;
    }
	  | {
	      type: "tool_calls";
	      toolCalls: Array<{
	        id: string;
	        type: "function";
	        function: {
	          name: string;
	          arguments: string;
	        };
	      }>;
	    };

export type OpenAiToolCall = Extract<ParsedToolDecision, { type: "tool_calls" }>["toolCalls"][number];

export type ResponseFunctionCall = {
  id: string;
  callId: string;
  name: string;
  argumentsText: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeChatTools(value: unknown): ChatToolDefinition[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new InvalidRequestError("tools must be an array.", "invalid_tools");
  }

  return value
    .map((tool, index): ChatToolDefinition | null => {
      if (!isRecord(tool)) {
        throw new InvalidRequestError(`tools[${index}] must be an object.`, "invalid_tool");
      }
      if (tool.type !== "function") {
        return null;
      }
      if (!isRecord(tool.function)) {
        throw new InvalidRequestError(`tools[${index}].function must be an object.`, "invalid_tool");
      }

      const name = normalizeToolName(tool.function.name);
      if (!name) {
        throw new InvalidRequestError(`tools[${index}].function.name is required.`, "invalid_tool");
      }

      return {
        type: "function",
        function: {
          name,
          description: typeof tool.function.description === "string" ? tool.function.description : undefined,
          parameters: tool.function.parameters,
        },
      };
    })
    .filter((tool): tool is ChatToolDefinition => Boolean(tool));
}

export function shouldUseToolPlanner(tools: ChatToolDefinition[], toolChoice: unknown): boolean {
  if (tools.length === 0) {
    return false;
  }
  return toolChoice !== "none";
}

function getForcedToolName(toolChoice: unknown): string | null {
  if (!isRecord(toolChoice)) {
    return null;
  }
  if (toolChoice.type && toolChoice.type !== "function") {
    return null;
  }
  return isRecord(toolChoice.function) ? normalizeToolName(toolChoice.function.name) || null : null;
}

export function buildToolPlanningPrompt(params: {
  promptText: string;
  tools: ChatToolDefinition[];
  toolChoice?: unknown;
}): string {
  const forcedToolName = getForcedToolName(params.toolChoice);
  const toolNames = new Set(params.tools.map((tool) => tool.function.name));
  if (forcedToolName && !toolNames.has(forcedToolName)) {
    throw new InvalidRequestError(`tool_choice requested unknown tool: ${forcedToolName}`, "invalid_tool_choice");
  }

  const toolSpecs = params.tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
  }));
  const choiceInstruction = forcedToolName
    ? `You must call exactly this tool: ${forcedToolName}.`
    : params.toolChoice === "required"
      ? "You must call one of the available tools."
      : "Call a tool when it is needed to satisfy the latest user request. Otherwise answer normally.";

  return [
    "You are planning a response for an OpenAI-compatible client that supports function tools.",
    "Decide whether to answer directly or call exactly one tool.",
    choiceInstruction,
    "Return only one valid JSON object. Do not wrap it in markdown.",
    "For a direct answer, use this shape:",
    "{\"type\":\"message\",\"content\":\"answer text\"}",
    "For a tool call, use this shape:",
    "{\"type\":\"tool_call\",\"name\":\"tool_name\",\"arguments\":{}}",
    "The arguments object must match the selected tool schema as closely as possible.",
    "Available tools:",
    JSON.stringify(toolSpecs, null, 2),
    "Conversation prompt:",
    params.promptText,
  ].join("\n");
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim().startsWith("{")) {
    return fenced[1].trim();
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return null;
}

export function parseToolDecision(text: string, tools: ChatToolDefinition[]): ParsedToolDecision {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return { type: "message", content: text };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { type: "message", content: text };
  }
  if (!isRecord(parsed)) {
    return { type: "message", content: text };
  }

  if (parsed.type === "message") {
    return {
      type: "message",
      content: typeof parsed.content === "string" ? parsed.content : text,
    };
  }

  if (parsed.type !== "tool_call") {
    return { type: "message", content: text };
  }

  const name = normalizeToolName(parsed.name);
  if (!tools.some((tool) => tool.function.name === name)) {
    return { type: "message", content: text };
  }

  const args = isRecord(parsed.arguments) ? parsed.arguments : {};
  return {
    type: "tool_calls",
    toolCalls: [
      {
        id: `call_${randomUUID().replace(/-/g, "")}`,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(args),
        },
      },
    ],
  };
}

export function toResponseFunctionCall(toolCall: OpenAiToolCall): ResponseFunctionCall {
  return {
    id: `fc_${randomUUID().replace(/-/g, "")}`,
    callId: toolCall.id,
    name: toolCall.function.name,
    argumentsText: toolCall.function.arguments,
  };
}
