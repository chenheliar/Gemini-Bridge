import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const LENGTH_MARKER_PATTERN = /(\d+)\n/y;
const DEFAULT_ARTIFACT_ROOT = path.resolve(process.cwd(), "artifacts");

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseArgs(argv) {
  const args = {
    artifact: null,
    out: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--artifact" && argv[index + 1]) {
      args.artifact = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--out" && argv[index + 1]) {
      args.out = argv[index + 1];
      index += 1;
    }
  }

  return args;
}

function resolveArtifactDir(input) {
  if (input) {
    return path.resolve(process.cwd(), input);
  }

  const entries = fs.readdirSync(DEFAULT_ARTIFACT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (entries.length === 0) {
    throw new Error("No artifact runs found.");
  }

  return path.join(DEFAULT_ARTIFACT_ROOT, entries.at(-1));
}

function extractRpcId(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("rpcids");
  } catch {
    return null;
  }
}

function extractSourcePath(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("source-path");
  } catch {
    return null;
  }
}

function getCharCountForUtf16Units(input, startIndex, utf16Units) {
  let count = 0;
  let units = 0;

  while (units < utf16Units && startIndex + count < input.length) {
    const codePoint = input.codePointAt(startIndex + count);
    if (codePoint === undefined) {
      break;
    }
    const unitCount = codePoint > 0xffff ? 2 : 1;
    if (units + unitCount > utf16Units) {
      break;
    }
    units += unitCount;
    count += 1;
  }

  return { charCount: count, unitsFound: units };
}

function parseResponseByFrame(content) {
  let consumed = 0;
  const frames = [];

  while (consumed < content.length) {
    while (consumed < content.length && /\s/.test(content[consumed] ?? "")) {
      consumed += 1;
    }

    if (consumed >= content.length) {
      break;
    }

    LENGTH_MARKER_PATTERN.lastIndex = consumed;
    const match = LENGTH_MARKER_PATTERN.exec(content);
    if (!match) {
      break;
    }

    const declaredLength = Number.parseInt(match[1] ?? "0", 10);
    const length = Math.max(0, declaredLength - 1);
    const startContent = match.index + (match[1]?.length ?? 0);
    const { charCount, unitsFound } = getCharCountForUtf16Units(content, startContent, length);
    if (unitsFound < length) {
      break;
    }

    const endPosition = startContent + charCount;
    const chunk = content.slice(startContent, endPosition).trim();
    consumed = endPosition;

    if (!chunk) {
      continue;
    }

    try {
      const parsed = JSON.parse(chunk);
      if (Array.isArray(parsed)) {
        frames.push(...parsed);
      } else {
        frames.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return frames;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
    || (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

function parseHeaderValue(value) {
  if (typeof value !== "string") {
    return value ?? null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeRequestPostData(postData) {
  if (!postData || !postData.includes("f.req=")) {
    return null;
  }

  const params = new URLSearchParams(postData);
  const raw = params.get("f.req");
  if (!raw) {
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }

  return {
    raw,
    parsed,
  };
}

function decodeBatchedResponse(body) {
  if (typeof body !== "string" || !body.trim()) {
    return [];
  }

  const normalized = body.startsWith(")]}'")
    ? body.slice(4).trimStart()
    : body;

  const frames = parseResponseByFrame(normalized);
  return frames.map((frame) => {
    if (Array.isArray(frame) && frame[0] === "wrb.fr") {
      return {
        type: "wrb.fr",
        rpcid: frame[1] ?? null,
        payload: parseMaybeJson(frame[2] ?? null),
        raw: frame,
      };
    }
    if (Array.isArray(frame) && frame[0] === "e") {
      return {
        type: "error",
        raw: frame,
      };
    }
    return {
      type: "frame",
      raw: frame,
    };
  });
}

function clip(value, maxLength = 220) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function getFirstRpcCall(requestPayload) {
  if (!Array.isArray(requestPayload)) {
    return null;
  }

  const outer = requestPayload[0];
  if (!Array.isArray(outer)) {
    return null;
  }

  const first = outer[0];
  if (!Array.isArray(first)) {
    return null;
  }

  const args = parseMaybeJson(first[1] ?? null);
  return {
    rpcid: first[0] ?? null,
    args,
    transport: first[3] ?? null,
  };
}

function extractL5adheKeys(args) {
  if (!Array.isArray(args)) {
    return [];
  }

  const candidate = args[1];
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate
    .flatMap((item) => (Array.isArray(item) ? item : []))
    .filter((value) => typeof value === "string" && value.trim());
}

function simplifyRpcArgs(rpcid, args) {
  if (rpcid === "L5adhe") {
    const keys = extractL5adheKeys(args);
    return {
      kind: "settings_write",
      keys,
    };
  }

  if (rpcid === "PCck7e") {
    return {
      kind: "post_generate_ack",
      ids: Array.isArray(args) ? args.filter((item) => typeof item === "string") : [],
    };
  }

  if (rpcid === "cYRIkd") {
    return {
      kind: "locale_init",
      locale: Array.isArray(args) ? args[0] ?? null : null,
    };
  }

  if (rpcid === "aPya6c") {
    return {
      kind: "conversation_refresh",
    };
  }

  if (rpcid === "ku4Jyf") {
    return {
      kind: "unknown",
      args,
    };
  }

  return args;
}

function extractModeIdFromHeaders(headers) {
  const parsed = parseHeaderValue(headers["x-goog-ext-525001261-jspb"]);
  if (!Array.isArray(parsed)) {
    return null;
  }
  return typeof parsed[4] === "string" && parsed[4] ? parsed[4] : null;
}

function extractRequestUuidFromHeaders(headers) {
  const parsed = parseHeaderValue(headers["x-goog-ext-525005358-jspb"]);
  if (!Array.isArray(parsed)) {
    return null;
  }
  return typeof parsed[0] === "string" && parsed[0] ? parsed[0] : null;
}

function extractStreamDetails(row) {
  if (!row?.url?.includes("StreamGenerate")) {
    return null;
  }

  const payload = row.requestPayload;
  const innerRaw = Array.isArray(payload) ? payload[1] ?? null : null;
  const inner = parseMaybeJson(innerRaw);

  return {
    tPlusMs: row.tPlusMs,
    url: row.url,
    status: row.responseStatus,
    prompt: Array.isArray(inner?.[0]) ? inner[0][0] ?? null : null,
    locale: Array.isArray(inner?.[1]) ? inner[1][0] ?? null : null,
    modeId: extractModeIdFromHeaders(row.requestHeaders ?? {}),
    requestUuid: extractRequestUuidFromHeaders(row.requestHeaders ?? {}),
    opaqueContextToken: Array.isArray(inner) ? inner[3] ?? null : null,
    opaqueRequestFingerprint: Array.isArray(inner) ? inner[4] ?? null : null,
  };
}

function compactRow(row) {
  if (row.url.includes("StreamGenerate")) {
    return {
      tPlusMs: row.tPlusMs,
      type: "StreamGenerate",
      status: row.responseStatus,
      sourcePath: row.sourcePath,
      details: extractStreamDetails(row),
    };
  }

  const firstCall = getFirstRpcCall(row.requestPayload);
  return {
    tPlusMs: row.tPlusMs,
    type: "batchexecute",
    rpcid: row.rpcid,
    sourcePath: row.sourcePath,
    status: row.responseStatus,
    args: simplifyRpcArgs(firstCall?.rpcid ?? row.rpcid, firstCall?.args ?? null),
  };
}

function countRpcids(rows) {
  const counts = new Map();

  for (const row of rows) {
    const key = row.url.includes("StreamGenerate") ? "StreamGenerate" : (row.rpcid ?? "unknown");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return String(left[0]).localeCompare(String(right[0]));
    }),
  );
}

function buildSourcePathTransitions(rows) {
  const transitions = [];
  let previous = null;

  for (const row of rows) {
    const current = row.sourcePath ?? "(none)";
    if (current === previous) {
      continue;
    }

    transitions.push({
      tPlusMs: row.tPlusMs,
      from: previous,
      to: current,
      via: row.url.includes("StreamGenerate") ? "StreamGenerate" : row.rpcid,
      url: row.url,
    });
    previous = current;
  }

  return transitions;
}

function buildTimeline(events) {
  const relevant = events.filter((event) => {
    const url = String(event.url ?? "");
    return (
      url.includes("/_/BardChatUi/data/batchexecute")
      || url.includes("StreamGenerate")
      || event.type === "page_state"
    );
  });

  const requestMap = new Map();
  const responseBodyMap = new Map();
  const responseMap = new Map();

  for (const event of relevant) {
    if (event.type === "request") {
      requestMap.set(event.requestId, event);
    }
    if (event.type === "response") {
      responseMap.set(event.requestId, event);
    }
    if (event.type === "response_body") {
      responseBodyMap.set(event.requestId, event);
    }
  }

  const rows = [];
  const requests = relevant.filter((event) => event.type === "request");
  const baseTs = requests[0]?.ts ?? Date.now();

  for (const request of requests) {
    const response = responseMap.get(request.requestId) ?? null;
    const responseBody = responseBodyMap.get(request.requestId) ?? null;
    const rpcid = extractRpcId(request.url);
    const decodedRequest = decodeRequestPostData(request.postData);
    const decodedFrames = responseBody ? decodeBatchedResponse(responseBody.body) : [];

    rows.push({
      tPlusMs: request.ts - baseTs,
      requestId: request.requestId,
      rpcid,
      sourcePath: extractSourcePath(request.url),
      url: request.url,
      requestHeaders: request.headers ?? {},
      requestPayload: decodedRequest?.parsed ?? null,
      responseStatus: response?.status ?? null,
      responseFrames: decodedFrames,
    });
  }

  return rows;
}

function summarizeTimeline(rows) {
  return rows.map((row) => ({
    tPlusMs: row.tPlusMs,
    rpcid: row.rpcid,
    sourcePath: row.sourcePath,
    status: row.responseStatus,
    url: row.url,
    requestPreview: clip(row.requestPayload),
    responsePreview: clip(row.responseFrames),
  }));
}

function findSendChain(rows) {
  const streamIndex = rows.findIndex((row) => row.url.includes("StreamGenerate"));
  if (streamIndex < 0) {
    return null;
  }

  const start = Math.max(0, streamIndex - 6);
  const end = Math.min(rows.length, streamIndex + 4);
  return rows.slice(start, end);
}

function analyzeSend(rows) {
  const streamIndex = rows.findIndex((row) => row.url.includes("StreamGenerate"));
  if (streamIndex < 0) {
    return null;
  }

  const streamRow = rows[streamIndex];
  const beforeWindowMs = 2_500;
  const afterWindowMs = 15_000;
  const preRowsInWindow = rows.filter((row) => row.tPlusMs >= streamRow.tPlusMs - beforeWindowMs && row.tPlusMs < streamRow.tPlusMs);
  const preRows = preRowsInWindow.length > 0
    ? preRowsInWindow
    : rows.slice(Math.max(0, streamIndex - 8), streamIndex);
  const postRows = rows.filter((row) => row.tPlusMs > streamRow.tPlusMs && row.tPlusMs <= streamRow.tPlusMs + afterWindowMs);
  const sourcePathTransitions = buildSourcePathTransitions(rows);
  const postConversationBoundRow = postRows.find((row) => typeof row.sourcePath === "string" && /^\/app\/[^/]+$/.test(row.sourcePath));

  return {
    windowMs: {
      before: beforeWindowMs,
      after: afterWindowMs,
    },
    preRowsMode: preRowsInWindow.length > 0 ? "time_window" : "fallback_last_requests",
    stream: extractStreamDetails(streamRow),
    preRows: preRows.map(compactRow),
    postRows: postRows.map(compactRow),
    preRpcCounts: countRpcids(preRows),
    postRpcCounts: countRpcids(postRows),
    sourcePathTransitions,
    likelyBinding: {
      firstPostGenerateAck: postRows.find((row) => row.rpcid === "PCck7e")
        ? compactRow(postRows.find((row) => row.rpcid === "PCck7e"))
        : null,
      firstConversationRefresh: postRows.find((row) => row.rpcid === "aPya6c")
        ? compactRow(postRows.find((row) => row.rpcid === "aPya6c"))
        : null,
      firstConversationBoundRow: postConversationBoundRow ? compactRow(postConversationBoundRow) : null,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactDir = resolveArtifactDir(args.artifact);
  const eventsPath = path.join(artifactDir, "events.jsonl");
  const outPath = args.out
    ? path.resolve(process.cwd(), args.out)
    : path.join(artifactDir, "analysis.json");

  const events = readJsonLines(eventsPath);
  const pageState = events.find((event) => event.type === "page_state") ?? null;
  const timeline = buildTimeline(events);
  const analysis = {
    artifactDir,
    pageState,
    requestCount: timeline.length,
    summaryTimeline: summarizeTimeline(timeline),
    sendChain: findSendChain(timeline),
    sendAnalysis: analyzeSend(timeline),
    sourcePathTransitions: buildSourcePathTransitions(timeline),
  };

  fs.writeFileSync(outPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    artifactDir,
    outPath,
    requestCount: timeline.length,
    sendChainLength: analysis.sendChain?.length ?? 0,
  }, null, 2));
}

main();
