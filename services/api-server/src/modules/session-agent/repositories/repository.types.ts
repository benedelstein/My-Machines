/** Tagged template SQL function type from the Cloudflare Durable Object Agent SDK. */
export type SqlFn = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

/** A single forward-only schema migration step. */
export type Migration = (sql: SqlFn) => void;

/**
 * Repositories declare a stable `name` and an append-only list of migrations.
 * The schema manager records applied versions per repo and only runs new steps
 * on each cold start.
 *
 * The array index IS the persisted migration version: `schema_migrations`
 * stores `(repo, index)` rows, so the position of every existing entry is
 * durable history. Migrations must never be reordered, edited, or removed —
 * append new versions at the end of the list. This invariant is enforced by
 * `tests/lib/repository-migrations-append-only.test.ts`.
 */
export interface Repository {
  readonly name: string;
  readonly migrations: ReadonlyArray<Migration>;
}
