import type { Migration, SqlFn, Repository } from "./repository.types";

export type SecretKey =
  | "git_proxy_secret"
  | "editor_token"
  | "webhook_token"; // todo rename to session_bearer_secret after migration

interface SecretRow {
  key: SecretKey;
  value: string;
}

export class SecretRepository implements Repository {
  readonly name = "secrets";
  readonly migrations: ReadonlyArray<Migration> = [
    (sql) => {
      sql`
        CREATE TABLE IF NOT EXISTS secrets (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `;
    },
  ];

  constructor(private sql: SqlFn) {}

  get(key: SecretKey): string | null {
    const rows = this.sql<SecretRow>`SELECT value FROM secrets WHERE key = ${key}`;
    return rows[0]?.value ?? null;
  }

  getAll(): Partial<Record<SecretKey, string>> {
    const rows = this.sql<SecretRow>`SELECT key, value FROM secrets`;
    const result: Partial<Record<SecretKey, string>> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  set(key: SecretKey, value: string): void {
    this.sql`INSERT OR REPLACE INTO secrets (key, value) VALUES (${key}, ${value})`;
  }

  delete(key: SecretKey): void {
    this.sql`DELETE FROM secrets WHERE key = ${key}`;
  }
}
