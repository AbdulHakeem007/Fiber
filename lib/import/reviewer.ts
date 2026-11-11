export function summarizeImportWarnings(issues: Array<{ severity: string }>) {
  return {
    total: issues.length,
    errors: issues.filter((x) => x.severity === "ERROR" || x.severity === "CRITICAL").length,
    warnings: issues.filter((x) => x.severity === "WARNING").length,
    info: issues.filter((x) => x.severity === "INFO").length,
  };
}
