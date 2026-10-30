import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = process.env.PI_CACHE_FIX_PI_CLI;
assert.ok(cli, 'Set PI_CACHE_FIX_PI_CLI to the installed Pi CLI JavaScript entrypoint.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ?? root;
const directory = mkdtempSync(join(tmpdir(), 'pi-cache-fix-smoke-'));
const requests = [];
let serverFailure;

function responseEvents() {
  const part = { type: 'output_text', text: 'OK', annotations: [] };
  const item = { id: 'msg_local_fixture', type: 'message', role: 'assistant', status: 'completed', content: [part] };
  return [
    { type: 'response.created', response: { id: 'resp_local_fixture', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'OK' },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_local_fixture', status: 'completed', output: [item],
      usage: { input_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, total_tokens: 9 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/responses');
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      assert.ok(body.length < 65536, 'Unexpectedly large local fixture request');
    }
    const payload = JSON.parse(body);
    assert.equal(payload.model, 'local-fixture');
    assert.equal(request.headers.authorization, 'Bearer offline-test-placeholder');
    assert.ok(request.headers['session-id']);
    assert.equal(request.headers['session-id'], payload.prompt_cache_key);
    assert.equal(request.headers.session_id, request.headers['session-id']);
    requests.push({ headerPresent: true, cacheKeyMatchesHeader: true });
    assert.equal(requests.length, 1);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'local-fixture' });
    response.end(responseEvents());
  } catch (error) {
    serverFailure = error.message;
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Local smoke fixture assertion failed' } }));
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: '1', PI_TELEMETRY: '0',
  PI_CACHE_FIX_ORIGINS: origin, PI_CACHE_FIX_MAGPIE_ORIGINS: '',
  NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
  http_proxy: '', https_proxy: '', all_proxy: '' };
const settingsPath = join(directory, 'settings.json');
writeFileSync(settingsPath, JSON.stringify({ packages: [], extensions: [], retry: { enabled: false, provider: { maxRetries: 0 } },
  compaction: { enabled: false }, cacheWarming: 'off', quietStartup: true }, null, 2));
writeFileSync(join(directory, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-responses', baseUrl: `${origin}/v1`, apiKey: 'offline-test-placeholder',
  models: [{ id: 'local-fixture', name: 'Local offline fixture', reasoning: false, input: ['text'],
    contextWindow: 4096, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }, null, 2));

function command(args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: directory, env, windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Pi package command timed out')); }, 30000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Pi command failed: ${stderr || stdout}`));
      else done({ stdout, stderr });
    });
  });
}

async function infer() {
  const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-session', '--provider', 'fixture',
    '--model', 'local-fixture', '--thinking', 'off', '--no-tools', '--no-mcp', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--offline', '--no-approve',
    '--system-prompt', 'Reply with exactly OK.'], { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', assistant;
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`Local Pi smoke timed out: ${stderr}`)), 30000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.on('error', fail);
      child.on('exit', code => fail(new Error(`Pi exited before settling (${code}): ${stderr}`)));
      child.stderr.on('data', data => { stderr += data; });
      child.stdout.on('data', data => {
        buffer += data;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'message_end' && event.message?.role === 'assistant') assistant = event.message;
          if (event.type === 'response' && event.success === false) fail(new Error(event.error));
          if (event.type === 'agent_settled') { clearTimeout(timer); done(); }
        }
      });
      child.stdin.write(JSON.stringify({ type: 'prompt', message: 'Return OK.' }) + '\n');
    });
    assert.equal(assistant?.stopReason, 'stop');
    assert.equal(assistant.content.filter(item => item.type === 'text').map(item => item.text).join(''), 'OK');
    assert.ok(!/extension.*error|failed to load/i.test(stderr), stderr);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

try {
  await command(['install', source]);
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.ok(settings.packages.length > 0, 'Local package was not installed');
  await infer();
  assert.equal(serverFailure, undefined);
  assert.equal(requests.length, 1);
  await command(['remove', source]);
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).packages.length, 0);
  console.log(JSON.stringify({ result: 'PASS', installedPackageAutoloaded: true, headerAndCacheKeyMatch: true,
    localMockRequests: requests.length, upstreamProviderRequests: 0, packageRemovalVerified: true,
    isolatedAgentDirectory: directory, cacheHitVerified: false }));
} finally {
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
