import type { SplitterInventoryRow } from "@/types/splitters";

interface RackDrilldown {
  rackCode: string;
  name?: string | null;
  status?: string | null;
  odfs: Array<{ odfCode: string; name?: string | null; status?: string | null; maxPorts?: number | null }>;
}

export function SiteInventoryDrilldown({ siteCode, racks, splitters }: { siteCode: string; racks: RackDrilldown[]; splitters: SplitterInventoryRow[] }) {
  const odfCount = racks.reduce((total, rack) => total + rack.odfs.length, 0);
  const splitterOutputCount = splitters.reduce((total, splitter) => total + splitter.outputCount, 0);
  return (
    <div id="inventory-drilldown" className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="section-title">Unified Site Inventory Drill-down</div>
          <div className="subtle mt-1">On-demand local view for {siteCode}: racks, ODF modules, and splitter deployments in one place.</div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="badge tag-none">{racks.length} racks</span>
          <span className="badge tag-none">{odfCount} ODFs</span>
          <span className="badge tag-none">{splitters.length} splitters</span>
          <span className="badge tag-none">{splitterOutputCount} splitter outputs</span>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-white/5 p-4">
          <div className="mb-3 font-semibold text-slate-950 dark:text-white">Rack / ODF estate</div>
          <div className="max-h-[360px] overflow-auto">
            <table>
              <thead><tr><th>Rack</th><th>ODF</th><th>Max ports</th><th>Status</th></tr></thead>
              <tbody>
                {racks.flatMap((rack) => rack.odfs.length ? rack.odfs.map((odf) => (
                  <tr key={`${rack.rackCode}-${odf.odfCode}`}>
                    <td>{rack.rackCode}</td><td>{odf.odfCode}</td><td>{odf.maxPorts ?? "-"}</td><td>{odf.status ?? rack.status ?? "-"}</td>
                  </tr>
                )) : [
                  <tr key={`${rack.rackCode}-empty`}><td>{rack.rackCode}</td><td>-</td><td>-</td><td>{rack.status ?? "-"}</td></tr>,
                ])}
                {!racks.length ? <tr><td colSpan={4}>No local racks found.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-white/5 p-4">
          <div className="mb-3 font-semibold text-slate-950 dark:text-white">Splitter cards touching this site</div>
          <div className="max-h-[360px] overflow-auto">
            <table>
              <thead><tr><th>Type</th><th>Splitter</th><th>Location</th><th>Configured / Capacity</th><th>Status</th></tr></thead>
              <tbody>
                {splitters.map((splitter) => (
                  <tr key={splitter.id}>
                    <td>{splitter.splitterType ?? `${splitter.scope}_SPL`}</td>
                    <td>{splitter.splitterCode}</td>
                    <td>{splitter.locationContext ?? splitter.location ?? "-"}</td>
                    <td>{splitter.configuredOutputPorts ?? splitter.usedFibers} / {splitter.totalHardwareCapacity ?? splitter.outputPortCapacity ?? splitter.outputCount}</td>
                    <td>{splitter.status}</td>
                  </tr>
                ))}
                {!splitters.length ? <tr><td colSpan={5}>No splitter cards found for this site.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
