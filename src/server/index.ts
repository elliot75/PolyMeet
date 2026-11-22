import 'dotenv/config';
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { app } from './app';
import { attachSttProxy } from './ws/sttProxy';
const server = createServer(getRequestListener(app.fetch));
attachSttProxy(server);
const port = Number(process.env.PORT || 3001);
server.listen(port, '127.0.0.1', () =>
  console.log(`PolyMeet server listening on http://127.0.0.1:${port}`),
);
