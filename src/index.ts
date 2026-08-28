import { ConfigurationError, loadConfig } from "./config.js";
import { createLogger, environmentSecretValues } from "./logger.js";
import { BridgeService } from "./service.js";

let service: BridgeService | undefined;
let shuttingDown = false;

try {
  const config = loadConfig();
  const logger = createLogger({
    secretValues: [config.clickClack.botToken, ...environmentSecretValues()],
  });
  service = new BridgeService(config, { logger });
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("received shutdown signal", { signal });
    service?.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await service.start();
} catch (error) {
  const issues = error instanceof ConfigurationError ? error.issues : undefined;
  const logger = createLogger({
    sink: (line) => process.stderr.write(`${line}\n`),
    secretValues: [
      ...(service ? [service.config.clickClack.botToken] : []),
      ...environmentSecretValues(),
    ],
  });
  logger.error("bridge startup failed", {
    ...(issues ? { configurationIssues: issues } : { error }),
  });
  service?.stop();
  process.exitCode = 1;
}
