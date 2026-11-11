import { z } from "zod";

export const importUploadSchema = z.object({
  fileName: z.string().min(3),
  templateVersion: z.string().optional().nullable(),
  sourceSystem: z.string().optional().nullable(),
});

export const stagingRowSchema = z.object({
  rowNumber: z.number().int().positive(),
  rawJson: z.string().min(2),
  normalizedJson: z.string().optional().nullable(),
  proposedSegmentCode: z.string().optional().nullable(),
});
