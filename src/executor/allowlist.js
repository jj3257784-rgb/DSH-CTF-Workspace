import { checkScope } from '../gateway/entry-controller.js';

import { toolDefinition } from './tool-registry.js';

export function validate(tool, scope, input) {
  const definition = toolDefinition(tool);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !definition || Object.keys(input).some(key => !definition.allowed_arguments.includes(key))) throw new Error('Invalid input');
  if (['web-local', 'curl-local'].includes(tool) && checkScope('web', scope) && typeof input.url === 'string') {
    const url = new URL(input.url);
    if (url.origin !== new URL(scope).origin || url.username || url.password || url.hash || url.search
      || !/^\/[a-zA-Z0-9/_-]*$/.test(url.pathname)) throw new Error('Target outside scope or invalid path');
    return { url: url.href };
  }
  if (['crypto-local', 'python-local'].includes(tool) && typeof input.ciphertext === 'string'
    && /^(?:[a-f0-9]{2}){1,4096}$/i.test(input.ciphertext)
    && Number.isInteger(input.key) && input.key >= 0 && input.key <= 255) {
    return { ciphertext: input.ciphertext.toLowerCase(), key: input.key };
  }
  if (tool === 'archive-local' && input.file === 'phase2b.zip') return { file: input.file };
  if (tool === 'static-local' && typeof input.file === 'string'
    && /^[a-zA-Z0-9_-]+\.(?:png|wav)$/.test(input.file)) return { file: input.file };
  if (['static-local', 'strings-local'].includes(tool) && typeof input.file === 'string'
    && /^[a-zA-Z0-9_-]+\.(?:bin|elf|zip|b64)$/.test(input.file)) return { file: input.file };
  if (tool === 'misc-local' && typeof input.file === 'string'
    && /^[a-zA-Z0-9_-]+\.b64$/.test(input.file)) return { file: input.file };
  throw new Error('Invalid input');
}
