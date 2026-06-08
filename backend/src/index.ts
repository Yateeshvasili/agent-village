import { config } from './config.js';
import { buildContainer } from './container.js';
import { createServer } from './http/server.js';
import { log } from './logger.js';

async function main(): Promise<void> {
  const container = await buildContainer();
  const app = createServer(container);

  const server = app.listen(config.port, () => {
    log.info('http.listening', { port: config.port, backend: container.db.backend, llm: container.llm.name });
  });

  await container.scheduler.start();

  const shutdown = async (signal: string) => {
    log.info('shutdown.begin', { signal });
    container.scheduler.stop();
    server.close();
    await container.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('boot.failed', { error: String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
