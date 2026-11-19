import { startConsole } from './server.js';

const app = await startConsole();
console.log('CTF Workbench ' + app.launchUrl);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    try { await app.close(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  });
}
