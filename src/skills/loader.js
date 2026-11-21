import { readFileSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';

const root = new URL('../../skills/', import.meta.url);
const schema = JSON.parse(readFileSync(new URL('skill.schema.json', root), 'utf8'));

function matches(value, rule) {
  if (rule.type === 'array') {
    return Array.isArray(value) && value.length >= rule.minItems
      && value.every(item => matches(item, rule.items));
  }
  return typeof value === 'string'
    && value.trim().length >= (rule.minLength ?? 0)
    && (!rule.pattern || new RegExp(rule.pattern).test(value))
    && (!rule.enum || rule.enum.includes(value))
    && (rule.const === undefined || rule.const === value);
}

function readAsset(path, invalidEncoding) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? 'SKILL_NOT_FOUND' : 'SKILL_READ_FAILED', { cause: error });
  }
  if (!isUtf8(bytes)) throw new Error(invalidEncoding);
  return bytes.toString('utf8');
}

export function loadSkill(type, tools) {
  if (!schema.properties.category.enum.includes(type)) throw new Error('SKILL_INVALID_METADATA');
  const id = 'ctf-' + type;
  const directory = new URL(id + '/', root);
  const raw = readAsset(new URL('skill.json', directory), 'SKILL_INVALID_METADATA');
  let metadata;
  try {
    metadata = JSON.parse(raw);
  } catch (error) {
    throw new Error('SKILL_INVALID_METADATA', { cause: error });
  }
  if (!metadata || Object.keys(metadata).length !== schema.required.length
    || !schema.required.every(key => Object.hasOwn(metadata, key) && matches(metadata[key], schema.properties[key]))
    || metadata.category !== type || metadata.id !== id || metadata.name !== id
    || metadata.required_capabilities.some(tool => !tools.includes(tool))) {
    throw new Error('SKILL_INVALID_METADATA');
  }
  let body;
  try {
    body = readAsset(new URL(metadata.entrypoint, directory), 'SKILL_INVALID_BODY');
  } catch (error) {
    error.skillVersion = metadata.version;
    throw error;
  }
  const header = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const names = header?.[1].split(/\r?\n/).filter(line => /^(?:name|'name'|"name")[ \t]*:/.test(line));
  if (names?.length !== 1 || names[0] !== 'name: ' + id || !body.slice(header[0].length).trim()) {
    throw Object.assign(new Error('SKILL_INVALID_BODY'), { skillVersion: metadata.version });
  }
  return { metadata, body };
}
