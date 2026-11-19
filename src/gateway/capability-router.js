import { isRoutable } from '../executor/tool-registry.js';
import { findMethodCard } from '../knowledge/knowledge-search.js';

export const capabilities = Object.freeze({
  web: 'web-local', crypto: 'crypto-local', misc: 'misc-local', pwn: null, reverse: null
});

export function route(type, requested = []) {
  const card = findMethodCard(type);
  const defaults = capabilities[type] ? [capabilities[type]] : [];
  if (!Array.isArray(requested) || requested.length > 10
    || [...defaults, ...requested].some(id => typeof id !== 'string' || !isRoutable(id, type))) {
    return { card, tools: [], reason: 'TOOL_NOT_AVAILABLE' };
  }
  return { card, tools: [...new Set([...defaults, ...requested])] };
}
