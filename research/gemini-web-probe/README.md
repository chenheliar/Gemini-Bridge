# Gemini Web Probe

This isolated sandbox is for inspecting Gemini Web's browser-native network calls without touching the running bridge service.

## What it does

- launches a separate Chrome profile
- imports cookies from the root project
- opens the configured anchor conversation
- records Gemini Web network activity to `artifacts/<timestamp>/`
- optionally attempts to submit one prompt through the page UI

## Usage

Install dependencies:

```bash
npm install
```

Capture page-load requests only:

```bash
npm run probe
```

Capture page-load requests and attempt one real send:

```bash
npm run probe:send -- --prompt "Reply with exactly: probe-ok"
```

## Artifacts

Each run writes:

- `summary.json`
- `events.jsonl`
- `page.html`
- `screenshot.png`

Decode one artifact into a timeline focused on Gemini RPCs:

```bash
npm run analyze -- --artifact artifacts/<timestamp>
```

The analyzer now highlights:

- the `StreamGenerate` payload's visible fields such as prompt and locale
- the RPC window immediately before and after generation
- `source-path` transitions, including when the browser lands on a new `/app/<conversation-id>`
- likely post-generate binding calls such as `PCck7e` and the follow-up `aPya6c`

## Notes

- The sandbox reads `../../cookies.json` and `../../data/config.json`.
- It uses its own Chromium profile under `.tmp/profile`.
- It does not modify the bridge service or reuse its Node process.
