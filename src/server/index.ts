import 'dotenv/config';
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { app } from './app';
import { attachSttProxy } from './ws/sttProxy';
import { closeDb, getDb } from './db';

getDb();
const server = createServer(getRequestListener(app.fetch));
const wss = attachSttProxy(server);
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`PolyMeet server listening on http://${host}:${port}`));

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const client of wss.clients) {
    client.close(1001, 'server_shutting_down');
  }
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => {
    closeDb();
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
