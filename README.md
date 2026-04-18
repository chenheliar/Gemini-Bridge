# Gemini Node Bridge

[中文说明](./README.zh-CN.md)

Gemini Node Bridge is a single-package Node.js application that turns Gemini Web into an OpenAI-compatible API and includes a built-in management dashboard.

It is designed for internal use: paste your Gemini cookies, optionally set a proxy, start the bridge, and use the `/v1` endpoints from any OpenAI-compatible client.

## What it includes

- OpenAI-compatible endpoints:
  - `GET /v1/models`
  - `POST /v1/chat/completions`
- Built-in dashboard for:
  - service start, stop, and restart
  - cookie editing and status checks
  - proxy configuration
  - live service logs
  - live conversation logs
- Automatic cookie health monitoring
- Light and dark theme support
- Support for `socks5h://`, `http://`, and `https://` proxies

## Project layout

This repository is now managed as one package.

```text
src/                  Server, Gemini bridge logic, config, and runtime state
web/                  Dashboard source code
data/                 Runtime data such as config.json
cookies.example.json  Example cookie payload
```

## Requirements

- Node.js 20 or newer is recommended
- A Google account that can access Gemini Web
- Valid Gemini cookies

## Install

```bash
npm install
```

## Quick start

### 1. Prepare cookies

Copy [`cookies.example.json`](./cookies.example.json) as a reference and export your Gemini cookies from the browser.

Recommended method: use the browser extension **Global Cookie Manager**.

1. Install Global Cookie Manager in your browser.
2. Sign in to [Gemini](https://gemini.google.com/).
3. Open the extension and filter cookies for `google.com`.
4. Export the cookie list as JSON.
5. Paste the exported JSON directly into the dashboard cookie editor.

The bridge requires these cookies:

- `__Secure-1PSID`
- `__Secure-1PSIDTS`

Optional cookies can be included too, but the two values above are the critical ones used for health checks.

### 2. Start in development mode

```bash
npm run dev
```

Default local addresses:

- Dashboard API: `http://127.0.0.1:3100`
- Vite dev frontend: `http://127.0.0.1:5173`

In development, the frontend proxies `/admin`, `/v1`, and `/health` to the local server.

### 3. Paste cookies in the dashboard

Open the dashboard, paste the full cookie JSON into the cookie editor, and save it.

The service will:

- store the cookies in `cookies.json`
- re-check cookie status immediately
- restart the bridge automatically if it is already running

### 4. Start the bridge

Use the dashboard service controls to start the Gemini bridge.

If cookies and proxy settings are valid, the OpenAI-compatible API becomes available right away.

## Production build

```bash
npm run build
npm start
```

After build, the server hosts the dashboard from `dist/web`, so you can open:

- `http://127.0.0.1:3100`

## Available scripts

- `npm run dev` - run server and dashboard together
- `npm run dev:server` - run only the server in watch mode
- `npm run dev:web` - run only the dashboard
- `npm run build` - build server and dashboard
- `npm start` - start the built server
- `npm run lint:web` - run frontend lint checks

## OpenAI-compatible usage

### List models

```bash
curl http://127.0.0.1:3100/v1/models
```

### Chat completion

```bash
curl http://127.0.0.1:3100/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash",
    "messages": [
      { "role": "user", "content": "Introduce yourself briefly." }
    ]
  }'
```

### Base URL for OpenAI-compatible tools

Use this base URL in your client:

```text
http://127.0.0.1:3100/v1
```

## Dashboard behavior

- Cookie status is checked automatically every second
- The dashboard shows whether critical cookies are healthy, expiring, expired, or missing
- Service logs appear in the live log panel
- Conversation records appear in the conversation log page as requests complete
- If live streaming disconnects, the dashboard reconnects automatically

## Runtime files

- `cookies.json` - saved cookie payload
- `data/config.json` - saved runtime config such as proxy and port

These files are created locally when you use the app.

## Proxy notes

- Supported formats:
  - `socks5h://127.0.0.1:7890`
  - `http://127.0.0.1:7890`
  - `https://127.0.0.1:7890`
- Many local proxy tools expose an HTTP proxy port even if the app itself uses HTTPS
- If proxy validation fails, check protocol, host, port, and whether Gemini is reachable through that route

## Limits

- This project depends on Gemini Web cookies and request behavior
- If Google changes the Gemini Web request format, the bridge may require updates
- Expired cookies can make the service appear available while requests fail, so refreshing cookies is the first thing to check when errors appear

## License

MIT
