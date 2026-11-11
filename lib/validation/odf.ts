import { normalizeOdfIdentifier } from "@/lib/telecom/connection-identity";

export function odfCodeWarning(value?: string | null) {
  return normalizeOdfIdentifier(value).warning;
}

export function normalizeOdfCode(value?: string | null) {
  return normalizeOdfIdentifier(value).value;
}
