import "dotenv/config";
import { runMultiWorkspaceNotification } from "./workers/notify-all.js";
import { logger } from "./utils/logger.js";
import { loadConfig } from "./config/index.js";

async function main(): Promise<void> {
  // Validate all required environment variables at startup
  loadConfig();

  logger.info("Starting multi-workspace notification check");
  await runMultiWorkspaceNotification();
}

main().catch((error) => {
  logger.error("Fatal error", error);
  process.exit(1);
});
