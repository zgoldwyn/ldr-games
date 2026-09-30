import { readGameServerConfig } from './config.js';
import { server } from './app.config.js';

const { port, host } = readGameServerConfig();

await server.listen(port, host);
console.log(`@ldr/game-server listening on http://${host}:${port}`);
