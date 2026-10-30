export const ORIGINS_ENV = 'PI_CACHE_FIX_ORIGINS';
export const MAGPIE_ORIGINS_ENV = 'PI_CACHE_FIX_MAGPIE_ORIGINS';

export function parseOrigins(value = '', envName = ORIGINS_ENV) {
  const origins = new Set();
  for (const entry of value.split(',').map(item => item.trim()).filter(Boolean)) {
    let url;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`${envName} must contain comma-separated HTTP(S) origins.`);
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`${envName} accepts origins only, without credentials, paths, queries or fragments.`);
    }
    origins.add(url.origin);
  }
  return origins;
}

export function targetOrigin(model, origins) {
  if (model?.api !== 'openai-responses') return undefined;
  try {
    const url = new URL(model.baseUrl);
    if (url.username || url.password) return undefined;
    return origins.has(url.origin) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function hasSessionHeader(headers) {
  return hasHeader(headers, 'session-id');
}

function hasHeader(headers, name) {
  return Object.keys(headers).some(key => key.toLowerCase() === name);
}

export function addSessionHeader(headers, sessionId) {
  // A null value is an intentional header deletion in Pi; preserve it too.
  if (hasSessionHeader(headers)) return false;
  if (typeof sessionId !== 'string' || !sessionId.trim() || /[\x00-\x1f\x7f]/.test(sessionId)) {
    throw new Error('pi-cache-fix requires a nonempty session ID without control characters.');
  }
  headers['session-id'] = sessionId;
  return true;
}

export default function cacheFix(pi) {
  const origins = parseOrigins(process.env[ORIGINS_ENV]);
  const magpieOrigins = parseOrigins(process.env[MAGPIE_ORIGINS_ENV], MAGPIE_ORIGINS_ENV);
  for (const origin of magpieOrigins) {
    if (!origins.has(origin) || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) {
      throw new Error(`${MAGPIE_ORIGINS_ENV} requires loopback origins also listed in ${ORIGINS_ENV}.`);
    }
  }
  pi.on('before_provider_headers', (event, ctx) => {
    const origin = targetOrigin(ctx.model, origins);
    if (!origin) return;
    if (!hasSessionHeader(event.headers)) addSessionHeader(event.headers, ctx.sessionManager.getSessionId());
    // Magpie's keyed Responses relay forwards session headers only on its
    // Codex path. Opt in on a local gateway without replacing Pi's User-Agent.
    if (magpieOrigins.has(origin) && !hasHeader(event.headers, 'originator')) {
      event.headers.originator = 'codex_cli_rs';
    }
  });
  pi.registerCommand('cache-fix', {
    description: 'Show pi-cache-fix configuration for the current model (no inference request).',
    handler: async (_args, ctx) => {
      const origin = targetOrigin(ctx.model, origins);
      const message = origins.size === 0
        ? `pi-cache-fix: disabled. Set ${ORIGINS_ENV} and restart Pi.`
        : origin
          ? `pi-cache-fix: active for ${origin} (openai-responses). Existing session-id headers are preserved.`
            + (magpieOrigins.has(origin)
              ? ' Magpie compatibility configured: originator=codex_cli_rs; Pi User-Agent kept; existing originator preserved.'
              : '')
            + ' This is not a cache-hit check.'
          : 'pi-cache-fix: inactive for this model. Select openai-responses on an allowed origin.';
      ctx.ui.notify(message, 'info');
    },
  });
}
