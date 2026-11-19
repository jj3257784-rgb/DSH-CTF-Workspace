import { readFileSync } from 'node:fs';

const metadata = JSON.parse(readFileSync(new URL('../../knowledge/metadata/methods.json', import.meta.url), 'utf8'));

export function findMethodCard(type) {
  return structuredClone(metadata.find(card => card.type === type));
}

export function searchKnowledge({ type, tag } = {}) {
  if (type === undefined && tag === undefined) return [];
  return metadata.filter(card => (type === undefined || card.type === type)
    && (tag === undefined || card.tags.includes(tag))).slice(0, 5).map(card => ({
      ...structuredClone(card),
      content: readFileSync(new URL('../../' + card.source, import.meta.url), 'utf8').slice(0, 4096)
    }));
}
