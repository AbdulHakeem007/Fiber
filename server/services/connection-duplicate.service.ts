import type { Prisma } from "@prisma/client";
import {
  type EndpointIdentityInput,
  physicalConnectionIdentity,
  sitePairKeyForEndpoints,
} from "@/lib/telecom/connection-identity";

type Tx = Prisma.TransactionClient;

function endpointFromSegment(endpoint: {
  site?: { code: string } | null;
  rawSiteCode?: string | null;
  rack?: { rackCode: string } | null;
  rawRackCode?: string | null;
  odf?: { odfCode: string } | null;
  rawOdfCode?: string | null;
  portGroup?: { displayLabel: string } | null;
  displayPortText?: string | null;
  rawPortText?: string | null;
}): EndpointIdentityInput {
  return {
    siteCode: endpoint.site?.code ?? endpoint.rawSiteCode,
    rackCode: endpoint.rack?.rackCode ?? endpoint.rawRackCode,
    odfCode: endpoint.odf?.odfCode ?? endpoint.rawOdfCode,
    portLabel: endpoint.portGroup?.displayLabel ?? endpoint.displayPortText ?? endpoint.rawPortText,
  };
}

function endpointFromMapping(mapping: {
  localSiteCode?: string | null;
  localRackCode?: string | null;
  localOdfCode?: string | null;
  localPortLabel?: string | null;
  farSiteCode?: string | null;
  farRackCode?: string | null;
  farOdfCode?: string | null;
  farPortLabel?: string | null;
}) {
  return {
    local: {
      siteCode: mapping.localSiteCode,
      rackCode: mapping.localRackCode,
      odfCode: mapping.localOdfCode,
      portLabel: mapping.localPortLabel,
    },
    far: {
      siteCode: mapping.farSiteCode,
      rackCode: mapping.farRackCode,
      odfCode: mapping.farOdfCode,
      portLabel: mapping.farPortLabel,
    },
  };
}

export const connectionDuplicateService = {
  identityForEndpoints(endpointA: EndpointIdentityInput, endpointB: EndpointIdentityInput) {
    return physicalConnectionIdentity(endpointA, endpointB);
  },

  async findDuplicateSegment(
    tx: Tx,
    endpointA: EndpointIdentityInput,
    endpointB: EndpointIdentityInput,
    options: { excludeSegmentId?: string | null } = {},
  ) {
    const sitePairKey = sitePairKeyForEndpoints(endpointA, endpointB);
    const desiredIdentity = physicalConnectionIdentity(endpointA, endpointB);

    const candidates = await tx.linkSegment.findMany({
      where: {
        sitePairKey,
        id: options.excludeSegmentId ? { not: options.excludeSegmentId } : undefined,
        status: { not: "DECOMMISSIONED" },
      },
      include: {
        endpointA: { include: { site: true, rack: true, odf: true, portGroup: true } },
        endpointB: { include: { site: true, rack: true, odf: true, portGroup: true } },
        endpointMappings: true,
      },
      take: 200,
    });

    return candidates.find((segment) => {
      const segmentIdentity = physicalConnectionIdentity(
        endpointFromSegment(segment.endpointA),
        endpointFromSegment(segment.endpointB),
      );
      if (segmentIdentity === desiredIdentity) return true;

      return segment.endpointMappings.some((mapping) => {
        const mapped = endpointFromMapping(mapping);
        return physicalConnectionIdentity(mapped.local, mapped.far) === desiredIdentity;
      });
    }) ?? null;
  },
};
