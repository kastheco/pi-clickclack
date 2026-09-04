import { createBridgeApplication, type BridgeApplication } from "./application.js";
import { ConfigurationError, loadConfig } from "./config.js";
import { createLogger, environmentSecretValues } from "./logger.js";

let application: BridgeApplication | undefined;
let shuttingDown = false;

try {
  const config = loadConfig();
  const logger = createLogger({
    secretValues: [config.clickClack.botToken, ...environmentSecretValues()],
  });
  application = createBridgeApplication(config, { logger });
  const runningApplication = application;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      logger.error("received a second shutdown signal; forcing exit", { signal });
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("received shutdown signal", { signal });
    const forceExit = setTimeout(() => {
      logger.error("bridge shutdown deadline expired; forcing exit", { signal });
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    void runningApplication.stop()
      .then((result) => {
        if (result === "completed") clearTimeout(forceExit);
      })
      .catch((error: unknown) => {
        logger.error("bridge shutdown failed", { error });
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await application.service.start();
} catch (error) {
  const issues = error instanceof ConfigurationError ? error.issues : undefined;
  const logger = createLogger({
    sink: (line) => process.stderr.write(`${line}\n`),
    secretValues: [
      ...(application ? [application.service.config.clickClack.botToken] : []),
      ...environmentSecretValues(),
    ],
  });
  logger.error("bridge startup failed", {
    ...(issues ? { configurationIssues: issues } : { error }),
  });
  const stopResult = await application?.stop();
  if (stopResult === "timed_out") {
    logger.error("bridge startup cleanup timed out; forcing exit");
    process.exit(1);
  }
  process.exitCode = 1;
}
