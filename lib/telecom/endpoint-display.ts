interface EndpointViewInput {
  contextSiteCode?: string | null;
  endpointA: { siteCode?: string | null; rackCode?: string | null; odfCode?: string | null; portLabel?: string | null };
  endpointB: { siteCode?: string | null; rackCode?: string | null; odfCode?: string | null; portLabel?: string | null };
}

export function resolveNearFarView(input: EndpointViewInput) {
  const { contextSiteCode, endpointA, endpointB } = input;
  if (!contextSiteCode) {
    return { near: endpointA, far: endpointB };
  }
  const useAAsNear = endpointA.siteCode === contextSiteCode || endpointB.siteCode !== contextSiteCode;
  return useAAsNear
    ? { near: endpointA, far: endpointB }
    : { near: endpointB, far: endpointA };
}
