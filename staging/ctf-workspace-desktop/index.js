import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let implementation = fileURLToPath(new URL('../../src/dsh/plugin.js', import.meta.url));
if (!existsSync(implementation)) {
  const profile = require.resolve('dsh-ctf-workspace-desktop/package.json');
  // Node resolves the installed package to its real location. Find the
  // owning profile even when the package manager uses nested node_modules.
  let directory = dirname(profile);
  while (true) {
    const manifest = resolve(directory, 'package.json');
    if (existsSync(manifest)) {
      const source = JSON.parse(readFileSync(manifest, 'utf8').replace(/^\uFEFF/, ''))
        .dependencies?.['dsh-ctf-workspace-desktop'];
      if (source?.startsWith('file:')) {
        implementation = resolve(directory, source.slice(5), '../../src/dsh/plugin.js');
        break;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Desktop profile has no workspace plugin file dependency');
    directory = parent;
  }
}

export const { apply, inject, name } = require(implementation);
