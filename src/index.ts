import "dotenv/config";
import { runMultiWorkspaceNotification } from "./workers/notify-all.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  logger.info("Starting multi-workspace notification check");
  await runMultiWorkspaceNotification();
}

main().catch((error) => {
  logger.error("Fatal error", error);
  process.exit(1);
});
