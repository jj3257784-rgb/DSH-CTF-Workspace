import { startConsole } from './server.js';

const app = await startConsole(process.env.DSH_CONTAINER === '1' ? { port: 8080, host: '0.0.0.0' } : {});
console.log('CTF Workbench ' + app.launchUrl);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    try { await app.close(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  });
}
