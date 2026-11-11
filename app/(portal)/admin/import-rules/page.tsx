import { ImportRulesManager } from "@/components/admin/import-rules-manager";
import { prisma } from "@/lib/db/prisma";

export default async function AdminImportRulesPage() {
  const sites = await prisma.site.findMany({
    include: { aliases: true },
    orderBy: { code: "asc" },
  });

  return (
    <ImportRulesManager
      siteCodes={sites.map((site) => site.code)}
      initialAliases={sites.flatMap((site) =>
        site.aliases.map((alias) => ({
          id: alias.id,
          siteCode: site.code,
          alias: alias.alias,
          aliasNormalized: alias.aliasNormalized,
        })),
      )}
    />
  );
}
