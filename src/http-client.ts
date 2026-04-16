import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

import { DEFAULT_BROWSER_HEADERS } from "./constants.js";

interface BrowserHttpClientOptions {
  proxyUrl?: string | null;
  timeoutMs?: number;
  initialCookies?: Record<string, string>;
}

const KEEP_ALIVE_AGENT_OPTIONS: http.AgentOptions = {
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 32,
  maxFreeSockets: 8,
};

function getEnvProxyUrl(): string | null {
  const candidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function createAgents(proxyUrl?: string | null): { httpAgent?: unknown; httpsAgent?: unknown } {
  const resolvedProxyUrl = proxyUrl?.trim() || getEnvProxyUrl();
  if (!resolvedProxyUrl) {
    return {
      httpAgent: new http.Agent(KEEP_ALIVE_AGENT_OPTIONS),
      httpsAgent: new https.Agent(KEEP_ALIVE_AGENT_OPTIONS),
    };
  }

  if (resolvedProxyUrl.startsWith("socks")) {
    const agent = new SocksProxyAgent(resolvedProxyUrl, KEEP_ALIVE_AGENT_OPTIONS);
    return { httpAgent: agent, httpsAgent: agent };
  }

  if (resolvedProxyUrl.startsWith("http://")) {
    return {
      httpAgent: new HttpProxyAgent(resolvedProxyUrl, KEEP_ALIVE_AGENT_OPTIONS),
      httpsAgent: new HttpsProxyAgent(resolvedProxyUrl, KEEP_ALIVE_AGENT_OPTIONS),
    };
  }

  if (resolvedProxyUrl.startsWith("https://")) {
    return {
      httpAgent: new HttpsProxyAgent(resolvedProxyUrl, KEEP_ALIVE_AGENT_OPTIONS),
      httpsAgent: new HttpsProxyAgent(resolvedProxyUrl, KEEP_ALIVE_AGENT_OPTIONS),
    };
  }

  throw new Error(`Unsupported proxy protocol: ${resolvedProxyUrl}`);
}

function formatProxyProbeError(proxyUrl: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (proxyUrl.startsWith("https://")) {
    return new Error(
      `Proxy ${proxyUrl} failed the TLS handshake or is unreachable. If you are using a local proxy such as Clash, Surge, or Charles, use http://127.0.0.1:7890 instead of https://127.0.0.1:7890. Original error: ${message}`,
    );
  }

  return new Error(`Proxy ${proxyUrl} is unreachable: ${message}`);
}

async function probeSocket(proxyUrl: string, timeoutMs: number): Promise<void> {
  const parsed = new URL(proxyUrl);
  const host = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const onError = (error: unknown) => finish(() => reject(formatProxyProbeError(proxyUrl, error)));
    const onTimeout = () => finish(() => reject(new Error(`Proxy ${proxyUrl} timed out (>${timeoutMs}ms)`)));

    const socket = parsed.protocol === "https:"
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => finish(() => {
          socket.end();
          resolve();
        }))
      : net.connect({ host, port }, () => finish(() => {
          socket.end();
          resolve();
        }));

    socket.setTimeout(timeoutMs);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

export async function validateProxyConnection(proxyUrl?: string | null, timeoutMs = 3500): Promise<void> {
  if (!proxyUrl) {
    return;
  }

  await probeSocket(proxyUrl, timeoutMs);
}

export class BrowserHttpClient {
  private readonly axios: AxiosInstance;
  private readonly cookieMap = new Map<string, string>();

  constructor(options: BrowserHttpClientOptions = {}) {
    Object.entries(options.initialCookies ?? {}).forEach(([key, value]) => {
      this.cookieMap.set(key, value);
    });

    const agents = createAgents(options.proxyUrl);
    this.axios = axios.create({
      timeout: options.timeoutMs ?? 600_000,
      maxRedirects: 5,
      responseType: "text",
      validateStatus: () => true,
      proxy: false,
      ...agents,
    });
  }

  private parseSetCookieHeader(setCookie: unknown): void {
    const cookieHeaders = Array.isArray(setCookie) ? setCookie : typeof setCookie === "string" ? [setCookie] : [];
    for (const item of cookieHeaders) {
      const firstPart = item.split(";")[0] ?? "";
      const separator = firstPart.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const name = firstPart.slice(0, separator).trim();
      const value = firstPart.slice(separator + 1).trim();
      if (name) {
        this.cookieMap.set(name, value);
      }
    }
  }

  private buildHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      ...DEFAULT_BROWSER_HEADERS,
      ...(extraHeaders ?? {}),
    };

    const cookieHeader = Array.from(this.cookieMap.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }
    return headers;
  }

  private handleResponse<T>(response: AxiosResponse<T>): AxiosResponse<T> {
    this.parseSetCookieHeader(response.headers["set-cookie"]);
    return response;
  }

  async getText(url: string, headers?: Record<string, string>): Promise<string> {
    const response = this.handleResponse(
      await this.axios.get<string>(url, {
        headers: this.buildHeaders(headers),
        responseType: "text",
      }),
    );
    return typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  }

  async postStream(
    url: string,
    body: string,
    headers?: Record<string, string>,
    params?: Record<string, string>,
  ): Promise<AxiosResponse<NodeJS.ReadableStream>> {
    return this.handleResponse(
      await this.axios.post<NodeJS.ReadableStream>(url, body, {
        headers: this.buildHeaders(headers),
        params,
        responseType: "stream",
      }),
    );
  }
}
