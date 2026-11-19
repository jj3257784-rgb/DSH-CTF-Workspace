export function verifyFlag(candidate, expected) {
  if (candidate == null) return 'NOT_FOUND';
  if (typeof candidate !== 'string' || !/^flag\{[^{}\r\n\u2028\u2029]+\}$/.test(candidate)) return 'REJECTED';
  if (expected === undefined) return 'FORMAT_VALID';
  return candidate === expected ? 'LOCALLY_VERIFIED' : 'REJECTED';
}
