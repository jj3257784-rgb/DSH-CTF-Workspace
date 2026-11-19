import { readFileSync } from 'node:fs';
import { modelFromEnvironment } from './model.js';
import { solveChallenge } from './solve.js';

try {
  const [consent, file] = process.argv.slice(2);
  if (consent !== '--live' || !file) throw new Error('Usage: npm run solve -- --live challenge.json');
  const input = JSON.parse(readFileSync(file, 'utf8'));
  const result = await solveChallenge({
    challenge:input.challenge, authorized_scope:input.authorized_scope, expected_flag:input.expected_flag,
    budget:input.budget, model:modelFromEnvironment()
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'LOCALLY_VERIFIED') process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
