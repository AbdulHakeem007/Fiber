export default function PortalLoading() {
  return (
    <div className="portal-loading-fullscreen">
      <div className="portal-loading-card">
        <div className="portal-loading-spinner" aria-hidden="true" />
        <div>
          <div className="text-lg font-semibold">Loading portal data...</div>
          <div className="subtle mt-1">Please wait while the fiber inventory view is prepared.</div>
        </div>
      </div>
    </div>
  );
}
