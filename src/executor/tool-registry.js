import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const inventory = JSON.parse(readFileSync(new URL('../../knowledge/metadata/tools.json', import.meta.url), 'utf8'));
const nodeHash = createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
for (const tool of inventory) {
  if (tool.executable_path === 'node') {
    tool.executable_path = process.execPath;
    tool.executable_sha256 = nodeHash;
    tool.version = process.versions.node;
  }
}
const registry = new Map(inventory.map(tool => [tool.tool_id, tool]));
const externalTools = new Set(['python-local', 'curl-local', 'strings-local', 'archive-local']);

export function listTools(category) {
  const selected = category === undefined ? inventory
    : inventory.filter(tool => tool.supported_categories.includes(category));
  return selected.map(tool => {
    const entry = structuredClone(tool);
    if (entry.execution_enabled) {
      const categories = category === undefined ? entry.supported_categories : [category];
      entry.execution_enabled = categories.some(type => isRoutable(entry.tool_id, type));
    }
    return entry;
  });
}

export function toolDefinition(id) {
  return structuredClone(registry.get(id));
}

export function isRoutable(id, category) {
  const tool = registry.get(id);
  if (tool?.available_status !== 'VERIFIED_AVAILABLE' || !tool.execution_enabled
    || !tool.supported_categories.includes(category)) return false;
  try {
    if (!statSync(tool.executable_path).isFile()) return false;
    return !externalTools.has(id) || createHash('sha256')
      .update(readFileSync(tool.executable_path)).digest('hex') === tool.executable_sha256;
  } catch {
    return false;
  }
}
