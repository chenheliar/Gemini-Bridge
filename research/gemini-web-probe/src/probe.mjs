import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const ROOT_DIR = path.resolve(PROJECT_DIR, "..", "..");
const ARTIFACTS_DIR = path.join(PROJECT_DIR, "artifacts");
const TMP_DIR = path.join(PROJECT_DIR, ".tmp");
const PROFILE_DIR = path.join(TMP_DIR, "profile");
const ROOT_CONFIG_PATH = path.join(ROOT_DIR, "data", "config.json");
const ROOT_COOKIES_PATH = path.join(ROOT_DIR, "cookies.json");
const DEFAULT_PROMPT = "Reply with exactly: probe-ok";
const MAX_CAPTURED_POST_DATA_CHARS = 30000;
const MAX_CAPTURED_RESPONSE_BODY_CHARS = 30000;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function parseArgs(argv) {
  const args = {
    send: false,
    prompt: DEFAULT_PROMPT,
    headless: false,
    timeoutMs: 60_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--send") {
      args.send = true;
      continue;
    }
    if (value === "--headless") {
      args.headless = true;
      continue;
    }
    if (value === "--prompt" && argv[index + 1]) {
      args.prompt = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--timeout-ms" && argv[index + 1]) {
      args.timeoutMs = Number(argv[index + 1]) || args.timeoutMs;
      index += 1;
    }
  }

  return args;
}

function loadRuntime() {
  const config = readJson(ROOT_CONFIG_PATH, {});
  const cookies = readJson(ROOT_COOKIES_PATH, []);
  const anchorUrl = typeof config.anchorUrl === "string" && config.anchorUrl.trim()
    ? config.anchorUrl.trim()
    : "https://gemini.google.com/app";
  const proxy = typeof config.proxy === "string" && config.proxy.trim() ? config.proxy.trim() : null;
  return { config, cookies, anchorUrl, proxy };
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Chrome executable not found. Set CHROME_PATH to continue.");
}

function normalizeCookie(cookie) {
  const domain = typeof cookie.domain === "string" && cookie.domain ? cookie.domain : ".google.com";
  const cleanDomain = domain.startsWith(".") ? domain.slice(1) : domain;
  const normalized = {
    name: String(cookie.name ?? ""),
    value: String(cookie.value ?? ""),
    domain,
    path: typeof cookie.path === "string" && cookie.path ? cookie.path : "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: "None",
  };

  if (typeof cookie.expirationDate === "number" && Number.isFinite(cookie.expirationDate)) {
    normalized.expires = cookie.expirationDate;
  }

  normalized.url = `https://${cleanDomain}${normalized.path}`;
  return normalized;
}

function summarizeHeaders(headers) {
  const keep = [
    "content-type",
    "x-goog-ext-525001261-jspb",
    "x-goog-ext-525005358-jspb",
    "x-same-domain",
    "referer",
    "origin",
  ];
  const summary = {};
  for (const key of keep) {
    if (headers[key]) {
      summary[key] = headers[key];
    }
  }
  return summary;
}

function buildArtifactPaths() {
  ensureDir(ARTIFACTS_DIR);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(ARTIFACTS_DIR, runId);
  ensureDir(runDir);
  return {
    runId,
    runDir,
    eventsPath: path.join(runDir, "events.jsonl"),
    summaryPath: path.join(runDir, "summary.json"),
    htmlPath: path.join(runDir, "page.html"),
    screenshotPath: path.join(runDir, "screenshot.png"),
  };
}

async function attachNetworkProbe(page, events) {
  const client = await page.target().createCDPSession();
  await client.send("Network.enable");
  const requestMeta = new Map();

  client.on("Network.requestWillBeSent", (event) => {
    requestMeta.set(event.requestId, {
      url: event.request?.url ?? "",
      method: event.request?.method ?? "",
    });
    events.push({
      type: "request",
      ts: Date.now(),
      requestId: event.requestId,
      method: event.request.method,
      url: event.request?.url ?? "",
      hasPostData: Boolean(event.request.hasPostData),
      postData: event.request.postData ? event.request.postData.slice(0, MAX_CAPTURED_POST_DATA_CHARS) : null,
      headers: summarizeHeaders(Object.fromEntries(
        Object.entries(event.request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
      )),
    });
  });

  client.on("Network.responseReceived", (event) => {
    events.push({
      type: "response",
      ts: Date.now(),
      requestId: event.requestId,
      url: event.response?.url ?? "",
      status: event.response.status,
      mimeType: event.response.mimeType,
      remoteIpAddress: event.response.remoteIPAddress ?? null,
      protocol: event.response.protocol ?? null,
    });
  });

  client.on("Network.loadingFailed", (event) => {
    events.push({
      type: "failed",
      ts: Date.now(),
      requestId: event.requestId,
      errorText: event.errorText,
      canceled: Boolean(event.canceled),
    });
  });

  client.on("Network.loadingFinished", async (event) => {
    const meta = requestMeta.get(event.requestId);
    if (!meta) {
      return;
    }

    const url = meta.url;
    if (
      !url.includes("/_/BardChatUi/data/batchexecute")
      && !url.includes("/_/BardChatUi/jserror")
      && !url.includes("chooseServer")
    ) {
      return;
    }

    try {
      const body = await client.send("Network.getResponseBody", { requestId: event.requestId });
      events.push({
        type: "response_body",
        ts: Date.now(),
        requestId: event.requestId,
        url,
        base64Encoded: Boolean(body.base64Encoded),
        body: String(body.body ?? "").slice(0, MAX_CAPTURED_RESPONSE_BODY_CHARS),
      });
    } catch (error) {
      events.push({
        type: "response_body_error",
        ts: Date.now(),
        requestId: event.requestId,
        url,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return client;
}

async function findDeepHandle(page, selectors) {
  for (const selector of selectors) {
    const jsHandle = await page.evaluateHandle((innerSelector) => {
      const queue = [document];
      const seen = new Set();
      while (queue.length > 0) {
        const root = queue.shift();
        if (!root || seen.has(root)) {
          continue;
        }
        seen.add(root);

        if (root.querySelector) {
          const match = root.querySelector(innerSelector);
          if (match) {
            return match;
          }
        }

        const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
        for (const element of all) {
          if (element.shadowRoot) {
            queue.push(element.shadowRoot);
          }
        }
      }
      return null;
    }, selector);

    const element = jsHandle.asElement();
    if (element) {
      return { selector, handle: element };
    }
    await jsHandle.dispose();
  }

  return null;
}

async function findComposer(page) {
  const selectors = [
    "textarea",
    '[contenteditable="true"][role="textbox"]',
    '[role="textbox"][contenteditable="true"]',
    'rich-textarea textarea',
  ];

  return findDeepHandle(page, selectors);
}

async function capturePageState(page) {
  return page.evaluate(() => {
    const selectorHits = {};
    const selectors = [
      "textarea",
      '[role="textbox"]',
      '[contenteditable="true"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      'a[aria-label="登录"]',
      'chat-app',
    ];

    const visitRoots = [];
    const queue = [document];
    while (queue.length > 0) {
      const root = queue.shift();
      if (!root || visitRoots.includes(root)) {
        continue;
      }
      visitRoots.push(root);

      if (root.querySelectorAll) {
        for (const selector of selectors) {
          selectorHits[selector] = (selectorHits[selector] ?? 0) + root.querySelectorAll(selector).length;
        }
      }

      const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const element of all) {
        if (element.shadowRoot) {
          queue.push(element.shadowRoot);
        }
      }
    }

    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText ?? "").trim().slice(0, 2000),
      selectorHits,
      customElements: Array.from(document.querySelectorAll("*"))
        .map((node) => node.tagName.toLowerCase())
        .filter((name) => name.includes("-"))
        .slice(0, 80),
    };
  });
}

async function trySendPrompt(page, prompt) {
  const composer = await findComposer(page);
  if (!composer) {
    return {
      ok: false,
      reason: "composer_not_found",
    };
  }

  await composer.handle.click({ clickCount: 1 });
  try {
    await composer.handle.evaluate((node) => {
      if ("value" in node) {
        node.value = "";
        node.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (node.isContentEditable) {
        node.textContent = "";
        node.dispatchEvent(new InputEvent("input", { bubbles: true, data: "" }));
      }
    });
  } catch {
    // Best effort.
  }

  await composer.handle.type(prompt, { delay: 20 });

  const sendSelectors = [
    'button[aria-label*="Send"]',
    'button[aria-label*="发送"]',
    'button[data-test-id*="send"]',
    'button[mattooltip*="Send"]',
  ];

  const sendButton = await findDeepHandle(page, sendSelectors);
  if (sendButton) {
    await sendButton.handle.click();
    return { ok: true, method: "button", selector: composer.selector, sendSelector: sendButton.selector };
  }

  await composer.handle.press("Enter");
  return { ok: true, method: "enter", selector: composer.selector };
}

function writeJsonl(filePath, records) {
  fs.writeFileSync(filePath, records.map((item) => `${JSON.stringify(item)}\n`).join(""), "utf8");
}

function buildSummary({ runtime, args, events, sendResult, artifactPaths }) {
  const interesting = events.filter((event) =>
    typeof event.url === "string" && (
      event.url.includes("gemini.google.com/_/") ||
      event.url.includes("BardChatUi") ||
      event.url.includes("batchexecute") ||
      event.url.includes("gstatic.com/_/mss/boq-bard-web")
    ),
  );

  const byUrl = new Map();
  for (const event of interesting) {
    const key = `${event.type}:${event.method ?? ""}:${event.url}`;
    byUrl.set(key, (byUrl.get(key) ?? 0) + 1);
  }

  const byHost = new Map();
  for (const event of events) {
    if (typeof event.url !== "string" || !event.url.startsWith("http")) {
      continue;
    }
    const host = new URL(event.url).host;
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
  }

  return {
    runId: artifactPaths.runId,
    anchorUrl: runtime.anchorUrl,
    proxy: runtime.proxy,
    promptAttempted: args.send,
    promptText: args.send ? args.prompt : null,
    sendResult,
    totalEvents: events.length,
    eventsByHost: Array.from(byHost.entries()).map(([host, count]) => ({ host, count })),
    interestingEndpoints: Array.from(byUrl.entries()).map(([key, count]) => ({ key, count })),
    artifactPaths: {
      events: artifactPaths.eventsPath,
      summary: artifactPaths.summaryPath,
      html: artifactPaths.htmlPath,
      screenshot: artifactPaths.screenshotPath,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = loadRuntime();
  const artifactPaths = buildArtifactPaths();
  const events = [];
  let browser;
  let page;

  ensureDir(TMP_DIR);
  ensureDir(PROFILE_DIR);

  try {
    browser = await puppeteer.launch({
      headless: args.headless,
      executablePath: findChromeExecutable(),
      userDataDir: PROFILE_DIR,
      defaultViewport: { width: 1440, height: 1000 },
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        ...(runtime.proxy ? [`--proxy-server=${runtime.proxy}`] : []),
      ],
    });

    page = await browser.newPage();
    page.setDefaultNavigationTimeout(args.timeoutMs);
    page.setDefaultTimeout(args.timeoutMs);
    page.on("console", (message) => {
      events.push({
        type: "console",
        ts: Date.now(),
        level: message.type(),
        text: message.text(),
      });
    });
    page.on("pageerror", (error) => {
      events.push({
        type: "pageerror",
        ts: Date.now(),
        message: error.message,
        stack: error.stack ?? null,
      });
    });

    const normalizedCookies = runtime.cookies.map(normalizeCookie);
    await page.setCookie(...normalizedCookies);
    events.push({
      type: "cookie_state",
      ts: Date.now(),
      setCount: normalizedCookies.length,
      visibleCookieCount: (await page.cookies(runtime.anchorUrl)).length,
    });
    await attachNetworkProbe(page, events);

    await page.goto(runtime.anchorUrl, { waitUntil: "domcontentloaded" });
    await new Promise((resolve) => setTimeout(resolve, 8_000));

    let sendResult = null;
    if (args.send) {
      sendResult = await trySendPrompt(page, args.prompt);
      await new Promise((resolve) => setTimeout(resolve, 12_000));
    }

    const pageState = await capturePageState(page);
    events.push({
      type: "page_state",
      ts: Date.now(),
      ...pageState,
    });

    fs.writeFileSync(artifactPaths.htmlPath, await page.content(), "utf8");
    await page.screenshot({ path: artifactPaths.screenshotPath, fullPage: true });
    writeJsonl(artifactPaths.eventsPath, events);
    const summary = buildSummary({ runtime, args, events, sendResult, artifactPaths });
    fs.writeFileSync(artifactPaths.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
