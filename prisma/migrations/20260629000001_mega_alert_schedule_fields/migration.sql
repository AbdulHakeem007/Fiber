-- Add customisable email subject and body to each weekly report schedule.
-- These power the Mega Alert "Template Copy Editor" in the admin panel.
ALTER TABLE "WeeklyReportSchedule" ADD COLUMN "emailSubject" TEXT;
ALTER TABLE "WeeklyReportSchedule" ADD COLUMN "emailBody" TEXT;
