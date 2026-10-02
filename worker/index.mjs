const encoder = new TextEncoder();
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export function canonicalQuery(searchParams) {
  return Array.from(searchParams.entries())
    .filter(([key]) => key !== 'gw_ts' && key !== 'gw_sig')
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = leftKey.localeCompare(rightKey);
      return keyOrder || leftValue.localeCompare(rightValue);
    })
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value))
    .join('&');
}

function bytesToHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

export async function signGatewayRequest(secret, method, timestamp, payload) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']
  );
  const canonical = ['v1', String(timestamp), method.toUpperCase(), payload].join('\n');
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical))));
}

async function authenticatedEmail(ctx) {
  if (!ctx || !ctx.access) return '';
  const identity = await ctx.access.getIdentity();
  return String(identity && identity.email || '').trim().toLowerCase();
}

function allowedEmails(env) {
  return String(env.AUDREY_ALLOWED_EMAILS || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
}

async function proxyApi(request, env, fetchImpl) {
  if (!env.AUDREY_APPS_SCRIPT_URL || !env.AUDREY_GATEWAY_SECRET) {
    return json({error: 'Secure backend is not configured'}, 503);
  }

  const sourceUrl = new URL(request.url);
  const target = new URL(env.AUDREY_APPS_SCRIPT_URL);
  sourceUrl.searchParams.forEach((value, key) => target.searchParams.append(key, value));

  const method = request.method.toUpperCase();
  let body = '';
  if (method === 'POST') {
    body = await request.text();
    if (encoder.encode(body).byteLength > MAX_BODY_BYTES) {
      return json({error: 'Request is too large'}, 413);
    }
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = method === 'GET' ? canonicalQuery(target.searchParams) : body;
  const signature = await signGatewayRequest(
    env.AUDREY_GATEWAY_SECRET, method, timestamp, payload
  );
  target.searchParams.set('gw_ts', String(timestamp));
  target.searchParams.set('gw_sig', signature);

  const headers = {'Accept': 'application/json'};
  if (method === 'POST') {
    headers['Content-Type'] = request.headers.get('Content-Type') || 'text/plain;charset=utf-8';
  }

  const upstream = await fetchImpl(target.toString(), {
    method,
    headers,
    body: method === 'POST' ? body : undefined,
    redirect: 'follow'
  });
  const responseBody = await upstream.arrayBuffer();
  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export async function handleRequest(request, env, ctx, fetchImpl = fetch) {
  const email = await authenticatedEmail(ctx);
  const allowlist = allowedEmails(env);
  if (!email || !allowlist.includes(email)) {
    return json({error: 'Access required'}, email ? 403 : 401);
  }

  const url = new URL(request.url);
  if (url.pathname === '/health') {
    return json({ok: true, authenticated: true});
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json({error: 'Method not allowed'}, 405);
    }
    return proxyApi(request, env, fetchImpl);
  }
  return env.ASSETS.fetch(request);
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
