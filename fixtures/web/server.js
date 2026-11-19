import { createServer } from 'node:http';
import { once } from 'node:events';

export const flag = 'flag{phase1b_web}';

export async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

export async function fixture(redirects) {
  const requests = [];
  const server = await listen((req, res) => {
    requests.push(req.url);
    if (req.url === '/sample') return res.end(flag);
    if (req.url === '/timeout') return;
    if (redirects.has(req.url)) {
      res.writeHead(302, { Location: redirects.get(req.url) }).end();
      return;
    }
    res.writeHead(503).end();
  });
  return { server, requests, origin: 'http://127.0.0.1:' + server.address().port };
}

export async function closeAndProbe(server) {
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}
