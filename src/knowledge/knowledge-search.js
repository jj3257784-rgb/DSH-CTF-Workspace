import { readFileSync } from 'node:fs';
import { retrieveKnowledge } from './retrieval.js';

const manifest = new URL('../../knowledge/metadata/methods.json', import.meta.url);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function readMethodCards() {
  try {
    const cards = JSON.parse(utf8.decode(readFileSync(manifest)));
    return Array.isArray(cards) ? cards.filter(card => card
      && typeof card.type === 'string' && typeof card.id === 'string' && typeof card.source === 'string'
      && Array.isArray(card.tags) && card.tags.every(tag => typeof tag === 'string')) : [];
  } catch {
    return [];
  }
}

export function findMethodCard(type) {
  return structuredClone(readMethodCards().find(card => card.type === type));
}

export function searchKnowledge({ type, tag } = {}) {
  if (type === undefined && tag === undefined) return [];
  const found = new Map();
  for (const card of readMethodCards()) {
    if ((type !== undefined && card.type !== type)
      || (tag !== undefined && !card.tags.includes(tag)) || found.has(card.id)) continue;
    const document = retrieveKnowledge({ category: card.type, maxSnippetChars: 4096, maxContextChars: 4096 }, card.id)
      .results.find(item => item.document_id === card.id && 'knowledge/' + item.source_path === card.source);
    if (!document) continue;
    found.set(card.id, { ...card, content: document.snippet });
    if (found.size === 5) break;
  }
  return [...found.values()];
}
