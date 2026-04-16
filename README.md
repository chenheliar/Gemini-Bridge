# Gemini Bridge

[简体中文说明](./README.zh-CN.md)

Gemini Bridge is a desktop app that turns Gemini Web into an OpenAI-compatible API with a simple Chinese interface.

It is built for people who want Gemini to work inside their existing tools without dealing with command lines, config files, or port issues by hand.

![Gemini Bridge Preview](https://img.heliar.top/file/1776241686234_Gemini_Bridge.png)

## What It Does

- Connects Gemini Web to OpenAI-compatible clients
- Provides a Chinese desktop interface for cookie, proxy, and model setup
- Shows the current API address directly in the app
- Automatically switches to another port if the default one is busy
- Supports LAN access so other devices on the same network can use it
- Stores runtime data locally

## Main Features

- Chinese desktop UI designed for non-technical users
- Fixed window size for a more stable layout
- Built-in usage guide inside the app
- Default model dropdown with saved preference
- Real-time service log view
- Cookie status check and clear startup feedback
- Windows installer build and macOS build pipeline support

## Quick Start

### 1. Prepare Gemini cookies

You need valid Gemini cookies that include:

- `__Secure-1PSID`
- `__Secure-1PSIDTS`

You can use [`cookies.example.json`](./cookies.example.json) as a reference format.

### 2. Run in development

```bash
npm install
npm run dev:desktop
```

### 3. Use the app

1. Paste your cookie JSON
2. Save cookies
3. Select a default model
4. Start the service
5. Copy the API address shown in the app

## API Address

Gemini Bridge exposes an OpenAI-compatible base URL like:

```text
http://127.0.0.1:3100/v1
```

If you want another device on the same network to use it, copy the LAN address shown in the app instead of `127.0.0.1`.

Example:

```text
http://192.168.x.x:3100/v1
```

## Build

### Windows installer

```bash
npm run pack:win
```

### macOS package

```bash
npm run pack:mac
```

### Full build

```bash
npm run build
```

## Release Automation

GitHub Actions is included for automatic packaging and release publishing.

When you push a version tag such as `v1.0.1`, the workflow can:

- build the Windows installer
- build the macOS package
- upload artifacts to GitHub Releases

Workflow file:

```text
.github/workflows/release.yml
```

Additional release notes:

```text
GITHUB_RELEASE.md
```

## Project Structure

```text
electron/             Electron desktop entry
src/                  Server and bridge logic
web/                  Desktop UI source
landing.html          Single-page promo page
cookies.example.json  Cookie example
```

## Notes

- This project depends on Gemini Web cookies
- If Gemini Web changes, the bridge may need updates
- Expired cookies are the first thing to check when requests stop working
- macOS builds are currently unsigned by default

## License

MIT
