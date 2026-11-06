import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSearchServer } from '../apps/api/server.js';
import { serverConfig } from './config.mjs';

try {
  const frontendDir = fileURLToPath(new URL('../dist', import.meta.url));
  try { await access(`${frontendDir}/index.html`); }
  catch { throw new Error('Frontend build is missing. Run pnpm build first.'); }
  const { port, options } = serverConfig();
  const server = createSearchServer({ ...options, frontendDir });
  server.on('error', (error) => {
    console.error(`Server failed to start: ${error.code ?? 'unknown error'}`);
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(); server.closeAllConnections();
  });
  server.listen(port, () => console.log(`Card Stack: http://localhost:${port}`));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
