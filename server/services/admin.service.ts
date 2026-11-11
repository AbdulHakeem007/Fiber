import { prisma } from "@/lib/db/prisma";
import { AlertType } from "@prisma/client";

export const adminService = {
  async listUsers() {
    return prisma.user.findMany({ include: { role: true }, orderBy: { name: "asc" } });
  },

  /**
   * First-run provisioning of the default alert policy set (post Fiber-cut removal):
   * Capacity, Topology, Data hygiene. Only runs when NO policies exist, so it never
   * overrides operator edits or re-creates a deliberately deleted policy while others
   * remain. Each policy carries the master enable/disable flag the engine respects.
   */
  async ensureDefaultAlertPolicies() {
    const count = await prisma.alertPolicy.count();
    if (count > 0) return;
    await prisma.alertPolicy.createMany({
      data: [
        { code: "CAPACITY_UTILIZATION", name: "Capacity", alertType: AlertType.HIGH_UTILIZATION, enabled: true, warningThresholdPct: 80, criticalThresholdPct: 90, cooldownMinutes: 60 },
        { code: "TOPOLOGY_RISK", name: "Topology", alertType: AlertType.CUSTOM, enabled: true, cooldownMinutes: 1440 },
        { code: "DATA_HYGIENE", name: "Data hygiene", alertType: AlertType.DATA_GAP, enabled: true, cooldownMinutes: 720 },
      ],
    });
  },

  async listPolicies() {
    return prisma.alertPolicy.findMany({ orderBy: { name: "asc" } });
  },

  async getNotificationSettings() {
    const [smtp, templates, deploymentTemplates, recipientGroups, notificationLogs, auditLogs] = await Promise.all([
      prisma.smtpConfiguration.findFirst({ where: { isActive: true }, orderBy: { updatedAt: "desc" } }),
      prisma.notificationTemplate.findMany({ orderBy: { name: "asc" } }),
      // Parallel Trace-Route deployment templates, separate from the Excel-export
      // NotificationTemplate set above.
      prisma.deploymentEmailTemplate.findMany({ orderBy: { name: "asc" } }),
      prisma.recipientGroup.findMany({ include: { members: true }, orderBy: { name: "asc" } }),
      // Recent-activity feeds stay bounded by design; 50 gives operators
      // enough context to see retry sequences and bulk operations end-to-end.
      prisma.notificationLog.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.auditLog.findMany({ include: { changedBy: true }, orderBy: { createdAt: "desc" }, take: 50 }),
    ]);
    return { smtp, templates, deploymentTemplates, recipientGroups, notificationLogs, auditLogs };
  },
};
