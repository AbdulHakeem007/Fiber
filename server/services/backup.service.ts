import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";
import { isSqlite } from "@/lib/db/provider";

/**
 * Automated SQLite backup engine.
 *
 * Snapshots are taken with `VACUUM INTO`, SQLite's online-backup statement:
 * it runs as a read transaction, so active pool connections and operator
 * sessions are never blocked while the snapshot is written. Under WAL mode
 * writers continue concurrently.
 *
 * On PostgreSQL this engine is disabled: `VACUUM INTO` does not exist and file
 * snapshots don't apply. Use `pg_dump` (or your managed-service snapshots)
 * instead — e.g. `pg_dump "$DATABASE_URL" -Fc -f backups/fiber-portal-<date>.dump`.
 */
const PG_BACKUP_GUIDANCE =
  "In-app file backups are only available on SQLite. On PostgreSQL, use pg_dump or your managed-service snapshots, e.g. pg_dump \"$DATABASE_URL\" -Fc -f backups/fiber-portal-<date>.dump";
const BACKUP_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // every 3 days
const BACKUP_RETENTION_COUNT = Number(process.env.BACKUP_RETENTION_COUNT ?? 14);
const BACKUP_PREFIX = "fiber-portal-backup-";

function backupDirectory(): string {
  return path.resolve(process.cwd(), process.env.BACKUP_DIR?.trim() || "backups");
}

function timestampLabel(date = new Date()): string {
  return date.toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");
}

export type BackupFileInfo = {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
};

async function listBackupFiles(): Promise<BackupFileInfo[]> {
  const dir = backupDirectory();
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const backups: BackupFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(BACKUP_PREFIX) || !entry.endsWith(".db")) continue;
    try {
      const info = await stat(path.join(dir, entry));
      backups.push({ fileName: entry, sizeBytes: info.size, createdAt: info.mtime.toISOString() });
    } catch {
      // Unreadable entry — skip it rather than failing the listing.
    }
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function enforceRetention(): Promise<number> {
  const backups = await listBackupFiles();
  const expired = backups.slice(Math.max(1, BACKUP_RETENTION_COUNT));
  for (const backup of expired) {
    try {
      await unlink(path.join(backupDirectory(), backup.fileName));
    } catch {
      // Retention cleanup is best-effort; the next run retries.
    }
  }
  return expired.length;
}

export const backupService = {
  async listBackups() {
    const backups = await listBackupFiles();
    const newest = backups[0] ?? null;
    const nextDueAt = newest
      ? new Date(new Date(newest.createdAt).getTime() + BACKUP_INTERVAL_MS).toISOString()
      : new Date().toISOString();
    return {
      directory: backupDirectory(),
      intervalDays: 3,
      retentionCount: BACKUP_RETENTION_COUNT,
      lastBackupAt: newest?.createdAt ?? null,
      nextDueAt,
      backups,
    };
  },

  async runBackup(reason: string): Promise<BackupFileInfo> {
    if (!isSqlite()) throw new Error(PG_BACKUP_GUIDANCE);
    const dir = backupDirectory();
    await mkdir(dir, { recursive: true });
    const fileName = `${BACKUP_PREFIX}${timestampLabel()}.db`;
    // SQLite requires forward slashes inside the quoted VACUUM INTO target
    // (works on Windows too); single quotes in the path are escaped.
    const target = path.join(dir, fileName).replace(/\\/g, "/").replace(/'/g, "''");
    await prisma.$executeRawUnsafe(`VACUUM INTO '${target}'`);
    const info = await stat(path.join(dir, fileName));
    const removed = await enforceRetention();
    console.log(`[backup] snapshot ${fileName} written (${Math.round(info.size / 1024 / 1024)} MB, reason: ${reason}${removed ? `, ${removed} expired snapshot(s) removed` : ""})`);
    return { fileName, sizeBytes: info.size, createdAt: info.mtime.toISOString() };
  },

  /**
   * Scheduler entry point: takes a snapshot only when the newest one is
   * older than the 3-day interval (or none exists yet).
   */
  async runScheduledBackupIfDue(): Promise<{ ran: boolean; backup?: BackupFileInfo; lastBackupAt?: string | null }> {
    // PostgreSQL backups are handled externally (pg_dump / managed snapshots).
    if (!isSqlite()) return { ran: false, lastBackupAt: null };
    const backups = await listBackupFiles();
    const newest = backups[0] ?? null;
    const ageMs = newest ? Date.now() - new Date(newest.createdAt).getTime() : Number.POSITIVE_INFINITY;
    if (ageMs < BACKUP_INTERVAL_MS) {
      return { ran: false, lastBackupAt: newest?.createdAt ?? null };
    }
    try {
      const backup = await this.runBackup("scheduled 3-day interval");
      return { ran: true, backup };
    } catch (error) {
      console.error("[backup] scheduled backup failed:", error);
      return { ran: false, lastBackupAt: newest?.createdAt ?? null };
    }
  },
};
