import { prisma } from "@/lib/db/prisma";

export const auditRepository = {
  listRecent: async () => prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
};
