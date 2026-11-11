export function canonicalResourceStatus(status?: string | null): string {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (normalized === "USED") return "ACTIVE";
  if (["SPARE", "PLANNED", "UNKNOWN"].includes(normalized)) return "AVAILABLE";
  return normalized || "AVAILABLE";
}

export function displayStatusLabel(status?: string | null): string {
  // PLANNED and INACTIVE are first-class, operator-selectable statuses, so they
  // must display distinctly rather than being folded into "Available" by the
  // canonical mapping (which is intentionally left untouched for capacity logic).
  const raw = String(status ?? "").trim().toUpperCase();
  if (raw === "PLANNED") return "Planned";
  if (raw === "INACTIVE") return "Inactive";
  const normalized = canonicalResourceStatus(status);
  switch (normalized) {
    case "ACTIVE":
      return "Active";
    case "AVAILABLE":
      return "Available";
    case "RESERVED":
      return "Reserved";
    case "REHOMED":
      return "Rehomed";
    case "FAULTY":
      return "Faulty";
    case "DUMMY":
      return "Dummy";
    case "DECOMMISSIONED":
      return "Decommissioned";
    default:
      return normalized;
  }
}

export function badgeClassForStatus(status: string): string {
  const raw = String(status ?? "").trim().toUpperCase();
  if (raw === "PLANNED") return "badge-planned";
  if (raw === "INACTIVE") return "badge-decommissioned";
  switch (canonicalResourceStatus(status)) {
    case "ACTIVE":
      return "badge-active";
    case "AVAILABLE":
      return "badge-available";
    case "RESERVED":
      return "badge-reserved";
    case "REHOMED":
      return "badge-rehomed";
    case "FAULTY":
      return "badge-faulty";
    case "DUMMY":
      return "badge-planned";
    case "DECOMMISSIONED":
      return "badge-decommissioned";
    default:
      return "badge-available";
  }
}
