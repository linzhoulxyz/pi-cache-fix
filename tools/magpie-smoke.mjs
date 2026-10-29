// All model traffic stays on loopback, with isolated Pi/Magpie configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const cli = process.env.PI_CACHE_FIX_PI_CLI;
const magpie = process.env.PI_CACHE_FIX_MAGPIE_EXE;
assert.ok(cli && magpie, 'Set PI_CACHE_FIX_PI_CLI and PI_CACHE_FIX_MAGPIE_EXE to installed program paths.');
const source = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const directory = mkdtempSync(join(tmpdir(), 'pi-cache-fix-magpie-'));
const home = join(directory, 'home');
const agent = join(home, 'agent');
const config = join(home, 'config', 'magpie');
for (const path of [agent, config]) mkdirSync(path, { recursive: true });
const requests = [];

function responseEvents(turn) {
  const part = { type: 'output_text', text: 'OK', annotations: [] };
  const item = { id: `msg_fixture_${turn}`, type: 'message', role: 'assistant', status: 'completed', content: [part] };
  return [
    { type: 'response.created', response: { id: `resp_fixture_${turn}`, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'OK' },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `resp_fixture_${turn}`, status: 'completed', output: [item],
      usage: { input_tokens: 8, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, total_tokens: 9 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"object":"list","data":[{"id":"fixture"}]}');
    return;
  }
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/responses');
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      assert.ok(raw.length < 1048576);
    }
    const body = JSON.parse(raw);
    assert.equal(body.model, 'fixture');
    assert.equal(request.headers.authorization, 'Bearer offline-upstream-placeholder');
    requests.push({ headers: request.headers, body });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(responseEvents(requests.length));
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"Loopback fixture rejected the request"}}');
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const reservation = createTcpServer();
await new Promise(done => reservation.listen(0, '127.0.0.1', done));
const gatewayPort = reservation.address().port;
await new Promise(done => reservation.close(done));
const origin = `http://127.0.0.1:${gatewayPort}`;
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: join(home, 'config'),
  XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
  PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_CACHE_FIX_ORIGINS: origin,
  PI_CACHE_FIX_MAGPIE_ORIGINS: origin, MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`, MAGPIE_NO_ACCOUNTS: '1',
  MAGPIE_NO_STATS: '1', DO_NOT_TRACK: '1', MAGPIE_TEST_SANDBOX: home, MAGPIE_NO_HANDOVER: '1',
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' };
writeFileSync(join(config, 'providers.json'), JSON.stringify({ providers: [{ id: 'offline', name: 'Offline',
  responses: `http://127.0.0.1:${server.address().port}/v1`, baseAPI: 'responses', models: ['fixture'],
  key: 'offline-upstream-placeholder' }] }));
writeFileSync(join(config, 'settings.json'), JSON.stringify({ redact: false, redactModelAuto: false, noAutoUpdate: true }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [], extensions: [],
  retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false },
  cacheWarming: 'off', quietStartup: true }));
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-responses', baseUrl: `${origin}/v1`, apiKey: 'offline-gateway-placeholder',
  models: [{ id: 'offline/fixture', name: 'Loopback fixture', reasoning: false, input: ['text'],
    contextWindow: 4096, maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(done => { child.once('exit', done); child.kill(); });
}

async function install() {
  const child = spawn(process.execPath, [cli, 'install', source], { cwd: directory, env, windowsHide: true });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new Error(`Local package installation failed: ${output}`)));
  });
}

let gateway, pi, gatewayLog = '', stderr = '';
try {
  gateway = spawn(magpie, ['serve'], { cwd: directory, env, windowsHide: true });
  gateway.stdout.on('data', data => { gatewayLog += data; });
  gateway.stderr.on('data', data => { gatewayLog += data; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (gateway.exitCode !== null) throw new Error(`Isolated gateway exited: ${gatewayLog}`);
    ready = await new Promise(done => {
      const socket = connect({ host: '127.0.0.1', port: gatewayPort });
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => done(false));
    });
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, 'Isolated gateway did not start');
  await install();
  pi = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-session', '--provider', 'fixture',
    '--model', 'offline/fixture', '--thinking', 'off', '--no-tools', '--no-mcp', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--offline', '--no-approve',
    '--system-prompt', 'Reply with exactly OK.'], { cwd: directory, env, windowsHide: true });
  let buffer = '', assistant, waiter, counter = 0;
  const fail = error => { if (waiter) { clearTimeout(waiter.timer); waiter.reject(error); waiter = undefined; } };
  pi.on('error', fail);
  pi.on('exit', code => fail(new Error(`Pi exited (${code}): ${stderr}`)));
  pi.stderr.on('data', data => { stderr += data; });
  pi.stdout.on('data', data => {
    buffer += data;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'message_end' && event.message?.role === 'assistant') assistant = event.message;
      if (event.type === 'response' && event.success === false) { fail(new Error(event.error)); continue; }
      if (waiter?.matches(event)) {
        clearTimeout(waiter.timer);
        const done = waiter.resolve;
        waiter = undefined;
        done(event);
      }
    }
  });
  function command(type, fields = {}) {
    const id = String(++counter);
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject,
        matches: event => type === 'prompt' ? event.type === 'agent_settled' : event.type === 'response' && event.id === id,
        timer: setTimeout(() => fail(new Error(`Pi ${type} timed out: ${stderr}`)), 30000) };
      pi.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
    });
  }
  const sessionIds = [];
  for (const [sessionIndex, turns] of [9, 3].entries()) {
    if (sessionIndex) await command('new_session');
    let previous, sessionId;
    for (let turn = 1; turn <= turns; turn++) {
      const before = requests.length;
      await command('prompt', { message: `Offline fixture turn ${turn}: return OK.` });
      assert.equal(assistant?.stopReason, 'stop');
      assert.equal(assistant.content.filter(item => item.type === 'text').map(item => item.text).join(''), 'OK');
      assert.equal(requests.length, before + 1, 'One fixture request per turn, no retries');
      const { headers, body } = requests.at(-1);
      assert.ok(headers['session-id'], 'Pi session-id must reach the fake upstream through Magpie');
      assert.equal(headers['session-id'], headers.session_id);
      assert.equal(headers['session-id'], body.prompt_cache_key);
      assert.equal(headers.originator, 'codex_cli_rs');
      assert.match(headers['user-agent'], /^pi[ /(]/);
      sessionId ??= headers['session-id'];
      assert.equal(headers['session-id'], sessionId, 'Session identity remains stable across turns');
      if (previous) {
        assert.ok(body.input.length > previous.input.length);
        assert.deepEqual(body.input.slice(0, previous.input.length), previous.input, 'Earlier input prefix must stay identical');
        for (const key of ['instructions', 'tools', 'model']) assert.deepEqual(body[key], previous[key]);
      }
      previous = body;
    }
    sessionIds.push(sessionId);
  }
  assert.notEqual(sessionIds[0], sessionIds[1], 'A new Pi session must use a new cache identity');
  assert.ok(!/extension.*error|failed to load/i.test(stderr), stderr);
  console.log(JSON.stringify({ result: 'PASS', localMockRequests: requests.length, sessionTurns: [9, 3],
    sessionHeadersAndCacheKeyMatch: true, prefixStable: true, newSessionChangesIdentity: true,
    realPiUserAgentPreserved: true, upstreamProviderRequests: 0, cacheHitVerified: false,
    isolatedDirectory: directory }));
} finally {
  await stop(pi);
  await stop(gateway);
  writeFileSync(join(directory, 'gateway.log'), gatewayLog);
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
