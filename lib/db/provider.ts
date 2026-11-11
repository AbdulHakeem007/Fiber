// Database provider detection from DATABASE_URL. Used to gate SQLite-only behaviour
// (WAL PRAGMAs, VACUUM INTO file backups) so the app runs cleanly on PostgreSQL.

export type DatabaseProvider = "postgresql" | "sqlite";

export function databaseProvider(): DatabaseProvider {
  const url = (process.env.DATABASE_URL ?? "").trim().toLowerCase();
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return "postgresql";
  // `file:`, `sqlite:`, or empty → treat as SQLite (the legacy local-dev default).
  return "sqlite";
}

export function isSqlite(): boolean {
  return databaseProvider() === "sqlite";
}

export function isPostgres(): boolean {
  return databaseProvider() === "postgresql";
}
