import { prioritySiteTag, type SiteTagSource } from "@/lib/telecom/site-tags";

const SITE_TAG_CLASS: Record<string, string> = {
  DC: "exch-dc-badge",
  CORE: "exch-core-badge",
};

export function siteTagBadgeClass(tag: string): string {
  return SITE_TAG_CLASS[tag.toUpperCase()] ?? "exch-tag-badge";
}

export function SiteTagBadge({ tag }: { tag: string }) {
  return (
    <span className={siteTagBadgeClass(tag)} title="Resolved site priority tag">
      {tag}
    </span>
  );
}

export function PrioritySiteTagBadge({ source }: { source: SiteTagSource }) {
  return <SiteTagBadge tag={prioritySiteTag(source)} />;
}
