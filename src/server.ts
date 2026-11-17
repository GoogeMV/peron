import { buildApp, loadConfig } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });

  if (config.collect) {
    // The page works from stored data even if the feed is unreachable at boot.
    await app.collector
      .loadMetadata()
      .catch((err) => app.log.warn({ err }, "could not load station metadata"));
    app.collector.start(config.pollMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
