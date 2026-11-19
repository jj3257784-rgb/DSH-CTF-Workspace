import { composeWorkspace } from '../workspace.js';
import { hasGatewayPermit } from '../gateway/entry-controller.js';
import { get } from 'node:http';
import { spawn } from 'node:child_process';
import { isRoutable, toolDefinition } from './tool-registry.js';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { OUTPUT_LIMIT, WEB_TIMEOUT_MS } from './execution-limits.js';
import { validate } from './allowlist.js';

export function hash(value) {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function getLocal(url, timeout) {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent: false, signal: AbortSignal.timeout(timeout) }, response => {
      const chunks = [];
      let size = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        size += chunk.length;
        if (size > OUTPUT_LIMIT) {
          reject(new Error('OUTPUT_LIMIT'));
          request.destroy();
        }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error('HTTP_STATUS'));
        resolve({ value: Buffer.concat(chunks).toString('utf8'), http_status: response.statusCode });
      });
    });
    request.on('error', reject);
  });
}

const pythonProgram = [
  'import sys,json',
  'a=json.load(sys.stdin)',
  'raw=bytes.fromhex(a["ciphertext"])',
  'plain=bytes(x ^ a["key"] for x in raw)',
  'reverse=bytes(x ^ a["key"] for x in plain)',
  'print(json.dumps(dict(intermediate_hex=plain.hex(),reencoded=reverse.hex(),round_trip=reverse==raw)))'
].join('\n');

function decodeCanonicalBase64(source) {
  if (source.some(byte => byte > 0x7f)) return null;
  const encoded = source.toString('ascii').trim();
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.toString('base64') === encoded ? decoded : null;
}

function inspectBytes(source, file) {
  const header_hex = source.subarray(0, 32).toString('hex');
  const elf = header_hex.startsWith('7f454c46');
  let format = 'UNKNOWN';
  if (elf) format = 'ELF';
  else if (/^504b(?:0304|0506)/.test(header_hex)) format = 'ZIP';
  else if (header_hex.startsWith('89504e470d0a1a0a')) format = 'PNG';
  else if (/^52494646[0-9a-f]{8}57415645/.test(header_hex)) format = 'WAVE';
  else if (file.endsWith('.b64') && decodeCanonicalBase64(source)?.length) format = 'BASE64';
  const byteOrder = source[5];
  const machine = elf && source.length >= 20 && [1, 2].includes(byteOrder)
    ? (byteOrder === 1 ? source.readUInt16LE(18) : source.readUInt16BE(18)) : null;
  return {
    format, header_hex, machine, size: source.length, source_hash: hash(source),
    fact_type: 'STATIC_OBSERVATION', dynamic_facts: 'UNVERIFIED'
  };
}

function runProcess(tool, args, stdin, cwd, timeout) {
  return new Promise((resolve, reject) => {
    const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
    const child = spawn(tool.executable_path, args, { cwd, env, shell: false, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let error;
    const stop = category => {
      error ??= category;
      child.kill();
    };
    const timer = setTimeout(() => stop('TIMEOUT'), timeout);
    const collect = chunks => chunk => {
      size += chunk.length;
      if (size > tool.output_limit) stop('OUTPUT_LIMIT');
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', () => {});
    child.on('error', () => { error ??= 'ADAPTER_ERROR'; });
    child.on('close', code => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      const metrics = {
        exit_code: code,
        stdout_summary: out.length + ' bytes',
        stderr_summary: err.length + ' bytes',
        output_hash: hash(out)
      };
      if (error || code !== 0) {
        reject(Object.assign(new Error(error ?? (tool.tool_id === 'curl-local' && code === 28
          ? 'TIMEOUT' : 'TOOL_EXIT_NONZERO')), metrics));
      } else resolve({ out, metrics });
    });
    child.stdin.end(stdin);
  });
}

async function runExternal(tool, args, source, cwd, timeout) {
  const id = tool.tool_id;
  if (id === 'curl-local') {
    const { out, metrics } = await runProcess(tool, ['-q', '--silent', '--show-error',
      '--noproxy', '*', '--proto', '=http', '--max-redirs', '0', '--write-out', '\n%{http_code}',
      '--url', args.url], undefined, cwd, timeout);
    const http_status = Number(out.subarray(-3).toString());
    if (http_status !== 200) throw Object.assign(new Error('HTTP_STATUS'), metrics);
    return { value: out.subarray(0, -4).toString('utf8'), http_status, metrics };
  }
  if (id === 'python-local') {
    const { out, metrics } = await runProcess(tool, ['-I', '-S', '-B', '-c', pythonProgram],
      JSON.stringify(args), cwd, timeout);
    const result = JSON.parse(out.toString());
    return { ...result, value: Buffer.from(result.intermediate_hex, 'hex').toString('utf8'), metrics };
  }
  if (id === 'strings-local') {
    const { out, metrics } = await runProcess(tool, ['-a', '-n', '4'], source, cwd, timeout);
    return { value: out.toString('utf8'), source_hash: hash(source), fact_type: 'STATIC_OBSERVATION', metrics };
  }
  const scratch = mkdtempSync(join(cwd, 'archive-'));
  const archive = join(scratch, 'fixture.zip');
  try {
    writeFileSync(archive, source, { flag: 'wx' });
    const { out, metrics } = await runProcess(tool, ['l', '-tzip', '-slt', '--', 'fixture.zip'],
      undefined, scratch, timeout);
    return { value: out.toString('utf8'), source_hash: hash(source), archive_action: 'list', metrics };
  } finally {
    if (existsSync(archive)) unlinkSync(archive);
    rmdirSync(scratch);
  }
}

// Authorization is supplied by the composing workspace, which owns the task registry.
function createExecutor(authorize, fixtureRoot) {
  return {
    prepare(permit, tool, input) {
      if (!hasGatewayPermit(permit) || !authorize(permit)) throw new Error('Missing Gateway permit');
      if (!permit.tool_allowlist.includes(tool)) throw new Error('Tool outside allowlist');
      if (!isRoutable(tool, permit.challenge_type)) throw new Error('Tool unavailable');
      const definition = toolDefinition(tool);
      const args = validate(tool, permit.authorized_scope, input);
      const external = ['python-local', 'curl-local', 'strings-local', 'archive-local'].includes(tool);
      if (external && hash(readFileSync(definition.executable_path)) !== 'sha256:' + definition.executable_sha256) {
        throw new Error('Tool identity changed');
      }
      let source;
      if (args.file) {
        const root = realpathSync(fixtureRoot);
        const path = realpathSync(join(root, args.file));
        if (dirname(path) !== root) throw new Error('File outside fixture root');
        if (!statSync(path).isFile()) throw new Error('Invalid fixture type');
        const fd = openSync(path, 'r');
        try {
          const buffer = Buffer.alloc(OUTPUT_LIMIT + 1);
          const stat = fstatSync(fd);
          if (!stat.isFile()) throw new Error('Invalid fixture type');
          if (stat.size > OUTPUT_LIMIT) throw new Error('OUTPUT_LIMIT');
          let length = 0;
          while (length < buffer.length) {
            const count = readSync(fd, buffer, length, buffer.length - length);
            if (!count) break;
            length += count;
            if (length >= stat.size) break;
          }
          if (length > OUTPUT_LIMIT) throw new Error('OUTPUT_LIMIT');
          source = buffer.subarray(0, length);
        } finally {
          closeSync(fd);
        }
      }
      if (tool === 'archive-local' && hash(source) !== 'sha256:' + definition.fixture_sha256) {
        throw new Error('Archive fixture identity changed');
      }
      const digest = hash(JSON.stringify({ tool, ...args, source: source && hash(source) }));
      return {
        digest,
        version: external ? definition.version : 'node-' + process.versions.node,
        operation: definition.supported_operations[0],
        async run(remaining, cwd) {
          if (!hasGatewayPermit(permit) || !authorize(permit)) throw new Error('Missing Gateway permit');
          if (external) return runExternal(definition, args, source, cwd, Math.min(remaining, definition.timeout_limit));
          if (tool === 'static-local') return inspectBytes(source, args.file);
          if (tool === 'web-local') return getLocal(args.url, Math.min(remaining, WEB_TIMEOUT_MS));
          if (tool === 'crypto-local') {
            const bytes = Buffer.from(args.ciphertext, 'hex').map(byte => byte ^ args.key);
            const reencoded = bytes.map(byte => byte ^ args.key).toString('hex');
            return {
              value: bytes.toString('utf8'), intermediate_hex: bytes.toString('hex'),
              reencoded, round_trip: reencoded === args.ciphertext
            };
          }
          const artifact = decodeCanonicalBase64(source);
          if (!artifact) throw new Error('INVALID_BASE64');
          return { artifact, value: artifact.toString('utf8'), source_hash: hash(source), artifact_hash: hash(artifact), encoding: 'base64' };
        }
      };
    }
  };
}



export function createWorkspace(root = 'data', fixtureRoot = 'fixtures/misc') {
  return composeWorkspace(createExecutor, root, fixtureRoot);
}

