export const APP_ROOT = process.env.GEMINI_NODE_BRIDGE_APP_ROOT?.trim() || process.cwd();
export const APP_DATA_ROOT = process.env.GEMINI_NODE_BRIDGE_DATA_ROOT?.trim() || APP_ROOT;

export const MODEL_HEADER_KEY = "x-goog-ext-525001261-jspb";
export const STREAMING_FLAG_INDEX = 7;
export const GEM_FLAG_INDEX = 19;
export const TEMPORARY_CHAT_FLAG_INDEX = 45;

export const DEFAULT_METADATA = ["", "", "", null, null, null, null, null, null, ""];
export const REQUIRED_COOKIE_NAMES = ["__Secure-1PSID", "__Secure-1PSIDTS"] as const;

export const ENDPOINTS = {
  GOOGLE: "https://www.google.com",
  INIT: "https://gemini.google.com/app",
  GENERATE:
    "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
  BATCH_EXEC: "https://gemini.google.com/_/BardChatUi/data/batchexecute",
} as const;

export const ERROR_CODES = {
  TEMPORARY_ERROR_1013: 1013,
  USAGE_LIMIT_EXCEEDED: 1037,
  MODEL_INCONSISTENT: 1050,
  MODEL_HEADER_INVALID: 1052,
  IP_TEMPORARILY_BLOCKED: 1060,
} as const;

export const CARD_CONTENT_RE = /^http:\/\/googleusercontent\.com\/card_content\/\d+/;
export const ARTIFACTS_RE = /http:\/\/googleusercontent\.com\/\w+\/\d+\n*/g;

export const DEFAULT_BROWSER_HEADERS = {
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
  Origin: "https://gemini.google.com",
  Referer: "https://gemini.google.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "X-Same-Domain": "1",
} as const;

export const DEFAULT_GEMINI_HEADERS = {
  ...DEFAULT_BROWSER_HEADERS,
  "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
} as const;

export interface GeminiModelDefinition {
  name: string;
  header: Record<string, string>;
  advancedOnly: boolean;
}

function buildModelHeader(modelId: string, capacityTail: string | number): Record<string, string> {
  return {
    [MODEL_HEADER_KEY]: `[1,null,null,null,\"${modelId}\",null,null,0,[4],null,null,${capacityTail}]`,
    "x-goog-ext-73010989-jspb": "[0]",
    "x-goog-ext-73010990-jspb": "[0]",
  };
}

export const GEMINI_MODELS: GeminiModelDefinition[] = [
  { name: "gemini-3-pro", header: buildModelHeader("9d8ca3786ebdfbea", 1), advancedOnly: false },
  { name: "gemini-3-flash", header: buildModelHeader("fbb127bbb056c959", 1), advancedOnly: false },
  { name: "gemini-3-flash-thinking", header: buildModelHeader("5bf011840784117a", 1), advancedOnly: false },
  { name: "gemini-3-pro-plus", header: buildModelHeader("e6fa609c3fa255c0", 4), advancedOnly: true },
  { name: "gemini-3-flash-plus", header: buildModelHeader("56fdd199312815e2", 4), advancedOnly: true },
  { name: "gemini-3-flash-thinking-plus", header: buildModelHeader("e051ce1aa80aa576", 4), advancedOnly: true },
  { name: "gemini-3-pro-advanced", header: buildModelHeader("e6fa609c3fa255c0", 2), advancedOnly: true },
  { name: "gemini-3-flash-advanced", header: buildModelHeader("56fdd199312815e2", 2), advancedOnly: true },
  { name: "gemini-3-flash-thinking-advanced", header: buildModelHeader("e051ce1aa80aa576", 2), advancedOnly: true },
];

export const DEFAULT_MODEL = "gemini-3-flash";
export const GEMINI_MODEL_MAP = new Map(GEMINI_MODELS.map((model) => [model.name, model]));
