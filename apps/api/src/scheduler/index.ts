import { Cron } from "croner";
import { processAssetCleanupOutbox } from "../storage/asset-cleanup-outbox";
import { checkDueDateReminders } from "./due-date-reminders";
import { checkProjectWebhookReminders } from "./project-webhook-reminders";

const jobs: Cron[] = [];

export function initializeScheduler(): void {
  jobs.push(new Cron("*/5 * * * *", checkDueDateReminders));
  jobs.push(new Cron("*/5 * * * *", checkProjectWebhookReminders));
  jobs.push(
    new Cron("*/1 * * * *", async () => {
      try {
        await processAssetCleanupOutbox();
      } catch (error) {
        console.error("Unexpected error in asset cleanup outbox job", error);
      }
    }),
  );
  console.log(
    "⏰ Scheduler started (due date and project webhook reminders every 5 minutes, asset cleanup every minute)",
  );
}

export function shutdownScheduler(): void {
  for (const job of jobs) {
    job.stop();
  }
  jobs.length = 0;
}
