import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { app, BrowserWindow, dialog, shell } from "electron";

const distRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(distRoot, "..");

const configuredRendererUrl = process.env.ELECTRON_RENDERER_URL?.trim() || "";
const configuredServerUrl = process.env.ELECTRON_SERVER_URL?.trim() || "http://127.0.0.1:3100";
const isDev = Boolean(configuredRendererUrl);
const serverWorkingDirectory = app.isPackaged ? process.resourcesPath : projectRoot;
const parsedConfiguredServerUrl = new URL(configuredServerUrl);
const desktopServerBindHost =
  process.env.ELECTRON_SERVER_BIND_HOST?.trim() ||
  (isDev ? parsedConfiguredServerUrl.hostname || "127.0.0.1" : "0.0.0.0");
const desktopServerAccessHost =
  process.env.ELECTRON_SERVER_ACCESS_HOST?.trim() ||
  (parsedConfiguredServerUrl.hostname && parsedConfiguredServerUrl.hostname !== "0.0.0.0"
    ? parsedConfiguredServerUrl.hostname
    : "127.0.0.1");
const desktopServerPort = Number.parseInt(parsedConfiguredServerUrl.port || "3100", 10);
const debugLogPath = path.join(projectRoot, ".tmp-electron-debug.log");
const appIconPath = path.join(projectRoot, "electron", "assets", "app-icon.png");

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let isQuitting = false;
let activeServerUrl = configuredServerUrl;
let activeRendererUrl = configuredRendererUrl || configuredServerUrl;
let activeServerPort = Number.isNaN(desktopServerPort) ? 3100 : desktopServerPort;

function debugStartup(message: string): void {
  if (process.env.ELECTRON_DEBUG_STARTUP !== "1") {
    return;
  }

  fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once("error", () => {
      resolve(false);
    });

    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port, host);
  });
}

async function resolveAvailablePort(host: string, preferredPort: number, maxAttempts = 20): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = preferredPort + offset;
    // eslint-disable-next-line no-await-in-loop
    const available = await isPortAvailable(host, candidate);
    if (available) {
      return candidate;
    }
  }

  throw new Error(`Gemini Bridge could not find an available port starting from ${preferredPort}.`);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1360,
    minHeight: 900,
    maxWidth: 1360,
    maxHeight: 900,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#f4efe7",
    title: "Gemini Bridge",
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  debugStartup(`Waiting for ${url}`);

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        return;
      }
    } catch {
      // ignore transient startup failures
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function prepareDesktopUrls(): Promise<void> {
  if (isDev) {
    activeServerUrl = configuredServerUrl;
    activeRendererUrl = configuredRendererUrl;
    return;
  }

  if (serverProcess) {
    return;
  }

  const resolvedPort = await resolveAvailablePort(desktopServerBindHost, activeServerPort);
  if (resolvedPort !== activeServerPort) {
    debugStartup(`Port ${activeServerPort} is busy. Switching to ${resolvedPort}.`);
  }

  activeServerPort = resolvedPort;
  activeServerUrl = `http://${desktopServerAccessHost}:${resolvedPort}`;
  activeRendererUrl = activeServerUrl;
}

function startBundledServer(): void {
  if (isDev || serverProcess) {
    return;
  }

  const serverEntrypoint = path.join(distRoot, "server.js");
  const runtimeBinary = process.execPath;
  debugStartup(`Launching server with ${runtimeBinary} ${serverEntrypoint} on port ${activeServerPort}`);

  serverProcess = spawn(runtimeBinary, [serverEntrypoint], {
    cwd: serverWorkingDirectory,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      GEMINI_NODE_BRIDGE_APP_ROOT: projectRoot,
      GEMINI_NODE_BRIDGE_DATA_ROOT: app.getPath("userData"),
      GEMINI_NODE_BRIDGE_HOST: desktopServerBindHost,
      GEMINI_NODE_BRIDGE_PORT: String(activeServerPort),
    },
    stdio: "ignore",
  });

  serverProcess.once("exit", (code) => {
    serverProcess = null;
    debugStartup(`Server exited with code ${code ?? "null"}`);

    if (isQuitting) {
      return;
    }

    const detail =
      code == null ? "The background service exited unexpectedly." : `The background service exited with code ${code}.`;
    dialog.showErrorBox("Gemini Bridge", detail);
    app.quit();
  });

  serverProcess.once("error", (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    debugStartup(`Server launch error: ${detail}`);
    dialog.showErrorBox("Gemini Bridge", `The background service failed to launch: ${detail}`);
    app.quit();
  });
}

async function bootstrapWindow(): Promise<void> {
  debugStartup("Bootstrapping desktop window");
  await prepareDesktopUrls();
  startBundledServer();
  await waitForHttp(`${activeServerUrl}/health`);
  if (activeRendererUrl !== activeServerUrl) {
    await waitForHttp(activeRendererUrl);
  }

  mainWindow = createWindow();
  await mainWindow.loadURL(activeRendererUrl);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function stopBundledServer(): void {
  if (!serverProcess || serverProcess.killed) {
    return;
  }

  serverProcess.kill();
  serverProcess = null;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBundledServer();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void bootstrapWindow().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      debugStartup(`Activate bootstrap failed: ${message}`);
      dialog.showErrorBox("Gemini Bridge", message);
      app.quit();
    });
  }
});

app.whenReady()
  .then(async () => {
    app.setName("Gemini Bridge");
    debugStartup("Electron app is ready");
    await bootstrapWindow();
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    debugStartup(`Bootstrap failed: ${message}`);
    dialog.showErrorBox("Gemini Bridge", message);
    app.quit();
  });
