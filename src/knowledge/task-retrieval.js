import { randomUUID } from 'node:crypto';
import { audit } from '../gateway/audit-recorder.js';
import { retrieveKnowledge } from './retrieval.js';

export function retrieveForTask(store, category, request, skill, reason) {
  const query_id = randomUUID();
  const retrieval_timestamp = new Date().toISOString();
  const validRequest = request === undefined || (request && typeof request === 'object'
    && !Array.isArray(request) && !Object.hasOwn(request, 'category'));
  const result = reason || !validRequest
    ? { result_status: 'REJECTED', results: [], issues: [{ error_category: reason ?? 'INVALID_QUERY' }] }
    : retrieveKnowledge({ ...request, category });
  const context = {
    query_id, category, retrieval_timestamp, skill_id: skill.selected_skill_id ?? null,
    source_evidence_id: skill.skill_evidence_id ?? null
  };
  const results = result.results.map(item => {
    const record = audit(store, 'knowledge_retrieval', 'RETRIEVED', {
      ...context, document_id: item.document_id, source_path: item.source_path,
      content_hash: item.content_hash, relevance_score: item.relevance_score
    });
    return Object.freeze({ ...item, tags: Object.freeze(item.tags), evidence_id: record.evidence_id });
  });
  for (const issue of result.issues) {
    const status = ['INDEX_READ_FAILED', 'SOURCE_READ_FAILED', 'HASH_MISMATCH'].includes(issue.error_category)
      ? 'READ_FAILED' : 'REJECTED';
    audit(store, 'knowledge_retrieval', status, {
      ...context, document_id: issue.document_id ?? null, source_path: null,
      content_hash: null, relevance_score: null, error_category: issue.error_category
    });
  }
  if (!results.length && !result.issues.length) {
    audit(store, 'knowledge_retrieval', result.result_status, {
      ...context, document_id: null, source_path: null, content_hash: null, relevance_score: null,
      error_category: null
    });
  }
  return Object.freeze({
    ...context, result_status: result.result_status, results: Object.freeze(results),
    ...(result.issues.length && { issues: Object.freeze(result.issues.map(issue => Object.freeze({
      ...issue, ...(issue.tags && { tags: Object.freeze(issue.tags) })
    }))) })
  });
}
