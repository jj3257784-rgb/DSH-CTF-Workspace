const transitions = {
  CREATED: ['PREFLIGHT_PENDING'],
  PREFLIGHT_PENDING: ['REJECTED', 'PREFLIGHT_PASSED'],
  PREFLIGHT_PASSED: ['RUNNING', 'INTERRUPTED'],
  RUNNING: ['PAUSED', 'FAILED', 'COMPLETED', 'INTERRUPTED'],
  PAUSED: ['RUNNING', 'INTERRUPTED']
};

export function createTaskState(store) {
  let status = 'CREATED';
  store.append('state', { result_status: status });
  return {
    get status() { return status; },
    transition(next, reason = null) {
      if (!transitions[status]?.includes(next)) throw new Error('Invalid task transition');
      store.append('state', { result_status: next, error_category: reason });
      status = next;
    }
  };
}
