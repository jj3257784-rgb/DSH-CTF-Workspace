import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../knowledge/', import.meta.url));
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const schemaPath = resolve(root, 'metadata/document.schema.json');
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const options = new Set(['category', 'tags', 'query', 'limit', 'maxSnippetChars', 'maxContextChars']);
const maxDocumentBytes = 256 * 1024;

function bounded(value, max) {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

function compileRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)
    || (rule.enum !== undefined && (!Array.isArray(rule.enum)
      || !rule.enum.every(value => typeof value === 'string')))
    || (rule.pattern !== undefined && typeof rule.pattern !== 'string')) {
    throw new Error('Invalid knowledge schema rule');
  }
  if (rule.pattern !== undefined) rule.pattern = new RegExp(rule.pattern);
  if (rule.type === 'array') compileRule(rule.items);
}

function matches(value, rule) {
  if (rule.type === 'array') {
    return Array.isArray(value) && new Set(value).size === value.length
      && Array.from(value).every(item => matches(item, rule.items));
  }
  return typeof value === 'string'
    && value.trim().length >= (rule.minLength ?? 0)
    && (!rule.pattern || rule.pattern.test(value))
    && (!rule.enum || rule.enum.includes(value))
    && (rule.const === undefined || rule.const === value);
}

function validMetadata(entry, { required, properties }) {
  return entry != null
    && Object.keys(entry).length === required.length
    && required.every(key => Object.hasOwn(entry, key) && matches(entry[key], properties[key]));
}

function readDocument(directory, entry) {
  const file = realpathSync(resolve(directory, entry.source_path));
  const path = relative(directory, file);
  if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) {
    return { error: 'SOURCE_OUTSIDE_ROOT' };
  }
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > maxDocumentBytes) return { error: 'SOURCE_READ_FAILED' };
  const bytes = readFileSync(file);
  if (bytes.length > maxDocumentBytes) return { error: 'SOURCE_READ_FAILED' };
  const hash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  if (hash !== entry.content_hash) return { error: 'HASH_MISMATCH' };
  return { body: utf8.decode(bytes), hash };
}

function rank(entry, body, words) {
  const title = (entry.title + ' ' + entry.tags.join(' ')).toLowerCase();
  const summary = entry.summary.toLowerCase();
  const content = body.toLowerCase();
  let score = 0;
  let first = Infinity;
  for (const word of words) {
    if (title.includes(word)) score += 4;
    if (summary.includes(word)) score += 2;
    const offset = content.indexOf(word);
    if (offset >= 0) {
      score += 1;
      first = Math.min(first, offset);
    }
  }
  if (!Number.isFinite(first)) return { score, offset: 0 };
  if (body.length !== content.length) {
    let foldedOffset = 0;
    let originalOffset = 0;
    for (const character of body) {
      foldedOffset += character.toLowerCase().length;
      if (foldedOffset > first) break;
      originalOffset += character.length;
    }
    return { score, offset: originalOffset };
  }
  return { score, offset: first };
}

export function createKnowledgeSearch(directory, index, documentId) {
  return function search(input = {}) {
    const empty = (result_status, issues = []) => ({ result_status, results: [], issues });
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !options.has(key))) {
      return empty('REJECTED', [{ error_category: 'INVALID_QUERY' }]);
    }
    let schema;
    try {
      schema = JSON.parse(utf8.decode(readFileSync(schemaPath)));
      if (!Array.isArray(schema.properties.category.enum) || !Array.isArray(schema.required)
        || !schema.required.length || !schema.required.every(key => schema.properties[key])) {
        throw new Error('Invalid knowledge schema');
      }
      for (const key of new Set(schema.required)) compileRule(schema.properties[key]);
    } catch {
      return empty('READ_FAILED', [{ error_category: 'INDEX_READ_FAILED' }]);
    }
    const categories = schema.properties.category.enum;
    const { category, tags = [], query = '', limit = 3, maxSnippetChars = 1024, maxContextChars = 3072 } = input;
    if (!categories.includes(category) || !Array.isArray(tags) || tags.length > 16
      || Array.from(tags).some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 64)
      || typeof query !== 'string' || query.length > 1024
      || !bounded(limit, 10) || !bounded(maxSnippetChars, 4096) || !bounded(maxContextChars, 8192)) {
      return empty('REJECTED', [{ error_category: 'INVALID_QUERY' }]);
    }
    if (!Array.isArray(index)) return empty('READ_FAILED', [{ error_category: 'INDEX_READ_FAILED' }]);
    let canonical;
    try {
      canonical = realpathSync(directory);
    } catch {
      return empty('READ_FAILED', [{ error_category: 'SOURCE_READ_FAILED' }]);
    }
    if (tags.length) {
      const knownTags = new Set(index.flatMap(entry =>
        validMetadata(entry, schema) ? entry.tags : []));
      const unknownTags = [...new Set(tags)].filter(tag => !knownTags.has(tag));
      if (unknownTags.length) {
        return empty('REJECTED', [{ error_category: 'UNKNOWN_TAGS', tags: unknownTags }]);
      }
    }
    const words = [...new Set([...segmenter.segment(query.toLowerCase())]
      .filter(token => token.isWordLike).map(token => token.segment))];
    if (query.trim() && !words.length) return empty('NO_RESULT');

    const seenIds = new Set();
    const seenPaths = new Set();
    const seenHashes = new Set();
    const issues = [];
    const ranked = [];
    for (const entry of index) {
      if (entry?.category !== category && categories.includes(entry?.category)) continue;
      if (!validMetadata(entry, schema)
        || seenIds.has(entry.document_id) || seenPaths.has(entry.source_path.toLowerCase())
        || seenHashes.has(entry.content_hash)) {
        issues.push({ error_category: 'INVALID_METADATA' });
        continue;
      }
      seenIds.add(entry.document_id);
      seenPaths.add(entry.source_path.toLowerCase());
      seenHashes.add(entry.content_hash);
      if (documentId !== undefined && entry.document_id !== documentId) continue;
      if (!tags.every(tag => entry.tags.includes(tag))) continue;
      let document;
      try {
        document = readDocument(canonical, entry);
      } catch {
        document = { error: 'SOURCE_READ_FAILED' };
      }
      if (document.error) {
        issues.push({ document_id: entry.document_id, error_category: document.error });
        continue;
      }
      const { score, offset } = rank(entry, document.body, words);
      if (!words.length || score) {
        const start = Math.min(offset, Math.max(0, document.body.length - maxSnippetChars));
        const snippet = document.body.slice(start, start + maxSnippetChars);
        if (snippet) ranked.push({ entry, snippet, score, matchOffset: offset - start });
      }
    }
    ranked.sort((left, right) => right.score - left.score
      || (left.entry.document_id < right.entry.document_id ? -1 : 1));
    const results = [];
    let remaining = maxContextChars;
    for (const { entry, snippet, score, matchOffset } of ranked) {
      if (!remaining || results.length === limit) break;
      const start = Math.min(matchOffset, Math.max(0, snippet.length - remaining));
      const excerpt = snippet.slice(start, start + remaining)
        .replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '');
      if (!excerpt) continue;
      remaining -= excerpt.length;
      results.push({ ...structuredClone(entry), relevance_score: score, snippet: excerpt });
    }
    const failed = issues.some(issue => ['SOURCE_READ_FAILED', 'HASH_MISMATCH'].includes(issue.error_category));
    return { result_status: results.length ? 'RETRIEVED' : failed ? 'READ_FAILED'
      : issues.length ? 'REJECTED' : 'NO_RESULT', results, issues };
  };
}

export function retrieveKnowledge(input, documentId) {
  let index;
  try {
    index = JSON.parse(utf8.decode(readFileSync(resolve(root, 'metadata/documents.json'))));
  } catch {
    // A missing or invalid index must not invent sources.
  }
  return createKnowledgeSearch(root, index, documentId)(input);
}

export function selectOfflineMethodCard(material) {
  const { category, algorithm, ciphertext, key, httpRecord, source } = material ?? {};
  if (category === 'crypto' && typeof algorithm === 'string' && /^xor$/i.test(algorithm.trim())
    && typeof ciphertext === 'string' && /^(?:[\da-f]{2}){1,4096}$/i.test(ciphertext)
    && Number.isInteger(key) && key >= 0 && key <= 255) {
    return retrieveKnowledge({ category, tags: ['math'] });
  }
  const httpRequestLine = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE) \S+ HTTP\/\d(?:\.\d)?[ \t]*$/m;
  const httpStatusLine = /^HTTP\/\d(?:\.\d)? [1-5]\d{2}(?:[ \t]|$)/m;
  const httpImport = /^[ \t]*import\s+(?:[\w$*,{}\s]+\s+from\s+)?(['"])(?:node:)?https?\1/m;
  const httpRequire = /^[ \t]*(?:(?:const|let|var)\s+[\w${}, \t]+\s*=\s*)?require\s*\(\s*(['"])(?:node:)?https?\1\s*\)/m;
  // Keep line breaks so the line-anchored patterns keep their original scope.
  const sourceLines = typeof source === 'string' ? source.replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
    token => /^(?:\/|\x60)/.test(token) ? token.replace(/[^\r\n]/g, '\u0000') : token
  ) : '';
  if (category === 'web' && ((typeof httpRecord === 'string'
    && (httpRequestLine.test(httpRecord) || httpStatusLine.test(httpRecord)))
    || httpImport.test(sourceLines) || httpRequire.test(sourceLines))) {
    return retrieveKnowledge({ category, tags: ['http'] });
  }
  return { result_status: 'NO_RESULT', results: [], issues: [] };
}
