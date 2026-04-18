import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { APP_DATA_ROOT } from "./constants.js";
import { ensureDir } from "./utils.js";

const COOKIE_STATE_KEY = "cookies_raw";

export class StateStore {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;

  constructor(dbPath = path.join(APP_DATA_ROOT, "data", "state.db")) {
    this.dbPath = dbPath;
    ensureDir(path.dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value_text TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getText(key: string): string | null {
    const row = this.db
      .prepare("SELECT value_text FROM app_state WHERE key = ? LIMIT 1")
      .get(key) as { value_text: string } | undefined;

    return row?.value_text ?? null;
  }

  setText(key: string, value: string): void {
    this.db
      .prepare(`
        INSERT INTO app_state (key, value_text, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_text = excluded.value_text,
          updated_at = excluded.updated_at
      `)
      .run(key, value, new Date().toISOString());
  }

  hasCookies(): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM app_state WHERE key = ? LIMIT 1")
      .get(COOKIE_STATE_KEY) as { found: number } | undefined;

    return row?.found === 1;
  }

  getCookiesRaw(): string | null {
    return this.getText(COOKIE_STATE_KEY);
  }

  setCookiesRaw(raw: string): void {
    this.setText(COOKIE_STATE_KEY, raw);
  }
}
