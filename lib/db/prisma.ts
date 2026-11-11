import { PrismaClient } from "@prisma/client";
import { isSqlite } from "./provider";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
  // eslint-disable-next-line no-var
  var backupSchedulerStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var criticalLinksSchedulerStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var weeklyReportsSchedulerStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var pendingDeletionSweepStarted: boolean | undefined;
}

/**
 * Automated 3-day database backup scheduler. Bootstrapped here because this
 * module only exists in the Node.js server bundle (never edge/middleware),
 * and every API route touches it. The check runs every 6 hours; a snapshot is
 * only written when the newest backup is older than the 3-day interval, so
 * restarts never produce redundant backups. Dynamic import breaks the
 * prisma <-> backup-service cycle.
 */
function startBackupScheduler() {
  if (globalThis.backupSchedulerStarted) return;
  globalThis.backupSchedulerStarted = true;
  const BACKUP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const runCheck = () => {
    void import("@/server/services/backup.service")
      .then(({ backupService }) => backupService.runScheduledBackupIfDue())
      .catch((error) => console.warn("[backup] scheduler check failed:", error));
  };
  // First check shortly after boot, off the critical startup path.
  setTimeout(runCheck, 30_000)?.unref?.();
  setInterval(runCheck, BACKUP_CHECK_INTERVAL_MS)?.unref?.();
}

/**
 * Weekly "Critical Links" email report scheduler. Same restart-safe pattern as
 * the backup scheduler: the worker only checks on a cadence and the service
 * decides whether a send is actually due (last SENT older than the interval).
 *
 * Cadence is hourly by default; override CRITICAL_LINKS_REPORT_CHECK_MS for
 * fast local QA (e.g. 60000 = check every minute) together with
 * CRITICAL_LINKS_REPORT_INTERVAL_MS=60000 to effectively send every minute.
 */
function startCriticalLinksReportScheduler() {
  if (globalThis.criticalLinksSchedulerStarted) return;
  globalThis.criticalLinksSchedulerStarted = true;
  const checkMs = Number(process.env.CRITICAL_LINKS_REPORT_CHECK_MS);
  const CHECK_INTERVAL_MS = Number.isFinite(checkMs) && checkMs >= 5_000 ? checkMs : 60 * 60 * 1000;
  const runCheck = () => {
    void import("@/server/services/critical-links-report.service")
      .then(({ criticalLinksReportService }) => criticalLinksReportService.runScheduledReportIfDue())
      .catch((error) => console.warn("[critical-links] scheduler check failed:", error));
  };
  setTimeout(runCheck, 45_000)?.unref?.();
  setInterval(runCheck, CHECK_INTERVAL_MS)?.unref?.();
}

/**
 * Weekly alert reports scheduler. Same restart-safe pattern: the worker only
 * checks on a cadence and the service decides, per schedule, whether this week's
 * configured weekday/time slot is due (and not already sent). Checks every 10 min
 * by default; override WEEKLY_REPORTS_CHECK_MS for fast local QA.
 */
function startWeeklyReportsScheduler() {
  if (globalThis.weeklyReportsSchedulerStarted) return;
  globalThis.weeklyReportsSchedulerStarted = true;
  const checkMs = Number(process.env.WEEKLY_REPORTS_CHECK_MS);
  const CHECK_INTERVAL_MS = Number.isFinite(checkMs) && checkMs >= 5_000 ? checkMs : 10 * 60 * 1000;
  const runCheck = () => {
    void import("@/server/services/weekly-report.service")
      .then(({ weeklyReportService }) => weeklyReportService.runDueSchedules())
      .catch((error) => console.warn("[weekly-report] scheduler check failed:", error));
  };
  setTimeout(runCheck, 60_000)?.unref?.();
  setInterval(runCheck, CHECK_INTERVAL_MS)?.unref?.();
}

/**
 * Delayed-deletion purge scheduler. Once a deletion hold's 24 working-hour
 * timer completes, the PORTAL is responsible for executing the purge (plain
 * hard delete, or the Reverse Split for an adjacent segment pair) — an operator
 * does not need to have any page open. Same restart-safe pattern as the other
 * schedulers; the service re-derives each hold's GCC-calendar deadline and
 * only purges holds whose window has fully elapsed. Checks every 5 minutes by
 * default; override PENDING_DELETION_SWEEP_CHECK_MS for fast local QA.
 */
function startPendingDeletionSweepScheduler() {
  if (globalThis.pendingDeletionSweepStarted) return;
  globalThis.pendingDeletionSweepStarted = true;
  const checkMs = Number(process.env.PENDING_DELETION_SWEEP_CHECK_MS);
  const CHECK_INTERVAL_MS = Number.isFinite(checkMs) && checkMs >= 5_000 ? checkMs : 5 * 60 * 1000;
  const runCheck = () => {
    void import("@/server/services/pending-deletion.service")
      .then(({ pendingDeletionService }) => pendingDeletionService.sweepExpired())
      .catch((error) => console.warn("[pending-deletion] sweep failed:", error));
  };
  setTimeout(runCheck, 90_000)?.unref?.();
  setInterval(runCheck, CHECK_INTERVAL_MS)?.unref?.();
}

function createPrismaClient() {
  const client = new PrismaClient({
    log: ["warn", "error"],
    // Bounded transactions: a stuck lock must fail fast instead of letting
    // parallel operator sessions queue forever behind it.
    transactionOptions: {
      maxWait: 10_000,
      timeout: 30_000,
    },
  });

  // SQLite concurrency hardening for parallel operator sessions (SQLite only —
  // PostgreSQL handles MVCC concurrency natively and rejects PRAGMA statements):
  // - WAL journal lets readers proceed while one writer commits, instead of
  //   the default rollback journal where any write blocks every read.
  // - busy_timeout makes competing writers wait for the lock (up to 10s)
  //   rather than instantly failing with SQLITE_BUSY ("database is locked").
  // - synchronous=NORMAL is the recommended WAL pairing: durable on app
  //   crash, far fewer fsyncs under concurrent load.
  if (isSqlite()) {
    void client
      .$queryRawUnsafe("PRAGMA journal_mode=WAL;")
      .then(() => client.$queryRawUnsafe("PRAGMA busy_timeout=10000;"))
      .then(() => client.$queryRawUnsafe("PRAGMA synchronous=NORMAL;"))
      .catch((error) => {
        console.warn("[prisma] SQLite concurrency pragmas could not be applied:", error);
      });
  }

  return client;
}

export const prisma = global.prismaGlobal ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.prismaGlobal = prisma;
}

// Skip during `next build` page-data collection; run only on live servers.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  startBackupScheduler();
  startCriticalLinksReportScheduler();
  startWeeklyReportsScheduler();
  startPendingDeletionSweepScheduler();
}
