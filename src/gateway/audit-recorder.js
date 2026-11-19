export function audit(store, type, result_status, fields = {}) {
  return store.append(type, { ...fields, result_status });
}
