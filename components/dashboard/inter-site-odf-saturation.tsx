"use client";

import { useEffect, useState } from "react";
import { Cable } from "lucide-react";
import type { IntraSiteSaturationGroup } from "@/lib/dashboard/odf-dashboard-metrics";
import { nextRotationIndex } from "@/lib/dashboard/odf-dashboard-metrics";

const ROTATE_MS = 45_000;

function saturationBand(value: number): string {
  if (value > 90) return "critical";
  if (value > 75) return "high";
  if (value > 50) return "moderate";
  return "normal";
}

export function IntraSiteOdfSaturationPanel({
  groups,
}: {
  groups: IntraSiteSaturationGroup[];
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const safeIndex = groups.length ? activeIndex % groups.length : 0;
  const activeGroup = groups[safeIndex];

  useEffect(() => {
    if (groups.length <= 1) return;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => nextRotationIndex(current, groups.length));
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [groups.length]);

  return (
    <section
      className="card min-w-0 w-full p-5"
      data-testid="intra-site-odf-saturation"
      data-active-site={activeGroup?.siteCode ?? ""}
      aria-labelledby="intra-site-odf-saturation-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Cable className="h-4 w-4 text-violet-500" aria-hidden="true" />
            <h2 id="intra-site-odf-saturation-title" className="section-title">Core &amp; DC Intra-Site ODF Saturation</h2>
          </div>
          <div className="subtle mt-1">
            Live intra-site tie-cable capacity from existing ODF mapping rows.
          </div>
        </div>
        <span className="kpi-trend kpi-trend-flat">
          {groups.length ? `Site ${safeIndex + 1} of ${groups.length}` : "No qualifying sites"}
        </span>
      </div>

      {activeGroup ? (
        <>
          <div className="odf-saturation-site mt-4">
            <div>
              <div className="odf-saturation-site-name">{activeGroup.siteLabel}</div>
              <div className="subtle">{activeGroup.rows.length} intra-site segment{activeGroup.rows.length === 1 ? "" : "s"}</div>
            </div>
            <span className="exch-tag-badge">{activeGroup.siteTag}</span>
          </div>
          <div className="odf-saturation-rotation-track" aria-hidden="true">
            <span key={safeIndex} className="odf-saturation-rotation-fill" />
          </div>
          <div className="odf-saturation-table-shell mt-3">
            <table className="odf-saturation-table">
              <thead>
                <tr>
                  <th>Segment Name</th>
                  <th className="num">Total Capacity</th>
                  <th className="num">Near End Available Ports</th>
                  <th className="num">Far End Available Ports</th>
                  <th className="num">Saturation (%)</th>
                  <th>Site Tag</th>
                </tr>
              </thead>
              <tbody>
                {activeGroup.rows.map((row) => (
                  <tr key={row.key}>
                    <td className="odf-saturation-segment">{row.segmentName}</td>
                    <td className="num">{row.totalCapacity.toLocaleString()}</td>
                    <td className="num">{row.nearEndAvailablePorts.toLocaleString()}</td>
                    <td className="num">{row.farEndAvailablePorts.toLocaleString()}</td>
                    <td className="num">
                      <span className={`exch-sat exch-sat-${saturationBand(row.saturationPct)}`}>{row.saturationPct}%</span>
                    </td>
                    <td><span className="odf-site-tag">{row.siteTag}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="dashboard-empty-state mt-4">
          No intra-site ODF mappings currently match the Core/DC site pool.
        </div>
      )}
    </section>
  );
}
