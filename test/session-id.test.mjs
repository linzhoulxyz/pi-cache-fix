import assert from 'node:assert/strict';
import test from 'node:test';
import cacheFix, { ORIGINS_ENV, addSessionHeader, parseOrigins, targetOrigin } from '../extensions/session-id.mjs';

const model = { api: 'openai-responses', baseUrl: 'https://api.example.com/v1' };

function load(value) {
  const before = process.env[ORIGINS_ENV];
  if (value === undefined) delete process.env[ORIGINS_ENV];
  else process.env[ORIGINS_ENV] = value;
  const handlers = new Map();
  const commands = new Map();
  try {
    cacheFix({ on: (name, callback) => handlers.set(name, callback),
      registerCommand: (name, command) => commands.set(name, command) });
  } finally {
    if (before === undefined) delete process.env[ORIGINS_ENV];
    else process.env[ORIGINS_ENV] = before;
  }
  return { request: handlers.get('before_provider_headers'), status: commands.get('cache-fix').handler };
}

test('empty configuration is opt-in and inactive', () => {
  assert.equal(parseOrigins().size, 0);
  const { request } = load();
  const event = { headers: {} };
  request(event, { model, sessionManager: { getSessionId: () => { throw new Error('Must not run'); } } });
  assert.deepEqual(event.headers, {});
});

test('origins normalize casing, trailing slashes and default ports and deduplicate', () => {
  assert.deepEqual([...parseOrigins(' https://API.EXAMPLE.com:443/, https://api.example.com, http://127.0.0.1:3425 ')],
    ['https://api.example.com', 'http://127.0.0.1:3425']);
});

test('invalid origin configuration fails without echoing potentially sensitive input', () => {
  for (const value of ['*', 'example.com', 'ftp://api.example.com', 'https://api.example.com/v1',
    'https://api.example.com?q=secret', 'https://api.example.com#secret', 'https://user:secret@api.example.com']) {
    assert.throws(() => parseOrigins(value), error => error.message.includes(ORIGINS_ENV) && !error.message.includes('secret'));
  }
});

test('target matching uses exact origin, including protocol and port', () => {
  const origins = parseOrigins('https://api.example.com');
  assert.equal(targetOrigin(model, origins), 'https://api.example.com');
  for (const baseUrl of ['https://api.example.com.evil.test/v1', 'https://sub.api.example.com/v1',
    'http://api.example.com/v1', 'https://api.example.com:8443/v1', 'not a URL',
    'https://user:password@api.example.com/v1']) {
    assert.equal(targetOrigin({ ...model, baseUrl }, origins), undefined);
  }
  assert.equal(targetOrigin(undefined, origins), undefined);
});

test('Chat Completions and the separate Codex adapter are not changed', () => {
  const { request } = load('https://api.example.com');
  for (const api of ['openai-completions', 'openai-codex-responses', 'anthropic-messages']) {
    const event = { headers: {} };
    request(event, { model: { ...model, api }, sessionManager: { getSessionId: () => 'unused' } });
    assert.deepEqual(event.headers, {});
  }
});

test('only session-id is added and the current session is read for each request', () => {
  const { request } = load('https://api.example.com');
  let session = 'first-session';
  const ctx = { model, sessionManager: { getSessionId: () => session } };
  const first = { headers: { Authorization: 'synthetic-placeholder', session_id: session } };
  request(first, ctx);
  assert.deepEqual(first.headers, { Authorization: 'synthetic-placeholder', session_id: session, 'session-id': session });
  session = 'second-session';
  const second = { headers: {} };
  request(second, ctx);
  assert.equal(second.headers['session-id'], session);
});

test('existing session-id values and explicit deletions are preserved case-insensitively', () => {
  const { request } = load('https://api.example.com');
  for (const name of ['session-id', 'Session-Id', 'SESSION-ID']) {
    for (const value of ['custom-session', '', null]) {
      const event = { headers: { [name]: value } };
      request(event, { model, sessionManager: { getSessionId: () => { throw new Error('Must not override'); } } });
      assert.deepEqual(event.headers, { [name]: value });
    }
  }
});

test('invalid fallback session IDs cannot inject headers', () => {
  for (const session of ['', '  ', null, undefined, 'session\r\ninjected: yes', 'session\tvalue', 'session\u0000']) {
    const headers = {};
    assert.throws(() => addSessionHeader(headers, session));
    assert.deepEqual(headers, {});
  }
});

test('an allowed local proxy is configurable without a vendor hardcode', () => {
  const { request } = load('http://127.0.0.1:3425');
  const event = { headers: {} };
  request(event, { model: { ...model, baseUrl: 'http://127.0.0.1:3425/v1' },
    sessionManager: { getSessionId: () => 'proxy-session' } });
  assert.equal(event.headers['session-id'], 'proxy-session');
});

test('status command covers disabled, active and non-target models without a provider call', async () => {
  const messages = [];
  const ctx = { model, ui: { notify: message => messages.push(message) } };
  await load().status('', ctx);
  await load('https://api.example.com').status('', ctx);
  await load('https://another.example.com').status('', ctx);
  assert.match(messages[0], /disabled/);
  assert.match(messages[1], /active for https:\/\/api\.example\.com/);
  assert.match(messages[2], /inactive/);
});
