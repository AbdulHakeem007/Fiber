import { z } from "zod";

export const segmentUpsertSchema = z.object({
  segmentCode: z.string().min(3),
  cableId: z.string().cuid().optional().nullable(),
  routeLabel: z.string().max(120).optional().nullable(),
  segmentCapacity: z.number().int().positive().optional().nullable(),
  tubeLabel: z.string().max(80).optional().nullable(),
  fiberLabel: z.string().max(80).optional().nullable(),
  distanceKm: z.number().nonnegative().optional().nullable(),
  status: z.enum(["ACTIVE", "SPARE", "RESERVED", "FAULTY", "DUMMY", "PLANNED", "INACTIVE", "UNKNOWN", "DECOMMISSIONED"]),
  endpointA: z.object({
    siteId: z.string().cuid().optional().nullable(),
    rackId: z.string().cuid().optional().nullable(),
    odfId: z.string().cuid().optional().nullable(),
    portGroupId: z.string().cuid().optional().nullable(),
    rawSiteCode: z.string().optional().nullable(),
    rawRackCode: z.string().optional().nullable(),
    rawOdfCode: z.string().optional().nullable(),
    rawPortText: z.string().optional().nullable(),
  }),
  endpointB: z.object({
    siteId: z.string().cuid().optional().nullable(),
    rackId: z.string().cuid().optional().nullable(),
    odfId: z.string().cuid().optional().nullable(),
    portGroupId: z.string().cuid().optional().nullable(),
    rawSiteCode: z.string().optional().nullable(),
    rawRackCode: z.string().optional().nullable(),
    rawOdfCode: z.string().optional().nullable(),
    rawPortText: z.string().optional().nullable(),
  }),
  manualOverride: z.boolean().default(false),
  overrideReason: z.string().optional().nullable(),
  comments: z.string().optional().nullable(),
});

export type SegmentUpsertInput = z.infer<typeof segmentUpsertSchema>;
