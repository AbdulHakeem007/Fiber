"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, Upload } from "lucide-react";
import { useState } from "react";
import { REGION_OPTIONS, normalizeRegionPrefix } from "@/lib/config/regions";

export function TopbarControls() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState("");
  const selectedRegion = normalizeRegionPrefix(searchParams.get("regionPrefix"));

  function runSearch() {
    const value = query.trim();
    if (!value) {
      router.push("/odf-racks");
      return;
    }
    const normalized = value.toUpperCase();
    // A facility Site Code (e.g. MU2000, DH1000) opens the complete asset
    // ecosystem for that site — its racks, ODF frames, port mappings and ATP
    // (splitter-output) inventory — on the ODF & Racks explorer, which fetches
    // that data server-side. Service/cable/explicit-ODF queries stay on the
    // ODF-mapping inventory trace.
    const looksLikeSiteCode = /^(?!SV-|CBL-|ODF)[A-Z]{2,}\d{2,}/.test(normalized);
    if (looksLikeSiteCode) {
      router.push(`/odf-racks?search=${encodeURIComponent(value)}` as any);
      return;
    }
    router.push(`/inventory?search=${encodeURIComponent(value)}` as any);
  }

  function applyRegion(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("regionPrefix", value);
    else params.delete("regionPrefix");
    const target = pathname.startsWith("/sites") || pathname.startsWith("/inventory") ? pathname : "/sites";
    router.push(`${target}?${params.toString()}` as any);
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2.5">
      <input
        className="input-dark min-w-[260px] flex-1"
        type="search"
        placeholder="Search site, service, cable, ODF, rack, port pair — press Enter"
        aria-label="Global search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            runSearch();
          }
        }}
      />
      <button
        type="button"
        className="btn btn-ghost"
        onClick={runSearch}
        aria-label="Run search"
        title="Search"
      >
        <Search className="h-4 w-4" aria-hidden="true" />
        Search
      </button>
      <select
        className="input-dark"
        value={selectedRegion}
        aria-label="Filter by region"
        onChange={(event) => applyRegion(event.target.value)}
      >
        <option value="">Region: All</option>
        {REGION_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <Link className="btn btn-primary" href="/import-center">
        <Upload className="h-4 w-4" aria-hidden="true" />
        Import Excel
      </Link>
    </div>
  );
}
