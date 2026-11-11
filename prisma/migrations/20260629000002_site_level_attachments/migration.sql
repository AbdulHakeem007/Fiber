-- Site-level document ownership for OTDR/FDD/ODF photo uploads.
-- Existing legacy segment-scoped rows are retained as historical metadata, but
-- new application writes use siteId only.
ALTER TABLE "SegmentAttachment"
ADD CONSTRAINT "SegmentAttachment_siteId_fkey"
FOREIGN KEY ("siteId") REFERENCES "Site"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
