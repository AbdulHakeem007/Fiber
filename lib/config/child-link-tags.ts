export const CHILD_LINK_TAGS = [
  "A-MPLS",
  "Backbone",
  "B2B",
  "MPLS Core",
  "Interconnect",
  "ISP-SPL",
  "OSP-SPL",
] as const;

export type ChildLinkTag = (typeof CHILD_LINK_TAGS)[number];

export function isChildLinkTag(value: unknown): value is ChildLinkTag {
  return typeof value === "string" && (CHILD_LINK_TAGS as readonly string[]).includes(value);
}
