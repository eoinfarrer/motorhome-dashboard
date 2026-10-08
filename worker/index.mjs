const encoder = new TextEncoder();
const MAX_BODY_BYTES = 8 * 1024 * 1024;
let accessJwks = null;
let accessJwksExpiresAt = 0;

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

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalJsonValue(value[key]);
      return result;
    }, {});
  }
  if (typeof value === 'string') return value.normalize('NFC');
  return value;
}

export function canonicalJsonBody(body) {
  try {
    return JSON.stringify(canonicalJsonValue(JSON.parse(body)));
  } catch (_error) {
    return String(body || '');
  }
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

function decodeJwtPart(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return JSON.parse(atob(padded));
}

function jwtSignatureBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

async function accessSigningKeys(env) {
  if (accessJwks && Date.now() < accessJwksExpiresAt) return accessJwks;
  const team = String(env.AUDREY_ACCESS_TEAM_DOMAIN || '').trim();
  if (!team) return [];
  const response = await fetch('https://' + team + '/cdn-cgi/access/certs');
  if (!response.ok) return [];
  const document = await response.json();
  accessJwks = Array.isArray(document.keys) ? document.keys : [];
  accessJwksExpiresAt = Date.now() + 5 * 60 * 1000;
  return accessJwks;
}

async function authenticatedEmail(request, env, ctx) {
  // Cloudflare's Workers Access integration exposes a verified identity on
  // ctx.access. Prefer it so the gateway does not duplicate Access's token
  // validation or reject a token that the platform has already accepted.
  if (ctx && ctx.access && typeof ctx.access.getIdentity === 'function') {
    try {
      const identity = await ctx.access.getIdentity();
      const email = String(identity && identity.email || '').trim().toLowerCase();
      if (email) return email;
    } catch (error) {
      console.warn('Audrey Access runtime identity failed', {
        name: String(error && error.name || 'Error'),
        message: String(error && error.message || '').slice(0, 160)
      });
      // Fall through to manual JWT validation for compatible runtimes.
    }
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  const team = String(env.AUDREY_ACCESS_TEAM_DOMAIN || '').trim();
  const audience = String(env.AUDREY_ACCESS_AUD || '').trim();
  if (token && team && audience) {
    try {
      const [encodedHeader, encodedClaims, encodedSignature, extra] = token.split('.');
      if (!encodedHeader || !encodedClaims || !encodedSignature || extra) {
        console.warn('Audrey Access JWT rejected', {reason: 'token_shape'});
        return '';
      }
      const header = decodeJwtPart(encodedHeader);
      const claims = decodeJwtPart(encodedClaims);
      if (header.alg !== 'RS256' || !header.kid) {
        console.warn('Audrey Access JWT rejected', {reason: 'header'});
        return '';
      }
      if (claims.iss !== 'https://' + team) {
        console.warn('Audrey Access JWT rejected', {reason: 'issuer'});
        return '';
      }
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audiences.includes(audience)) {
        console.warn('Audrey Access JWT rejected', {reason: 'audience'});
        return '';
      }
      if (!claims.exp || Number(claims.exp) <= Date.now() / 1000) {
        console.warn('Audrey Access JWT rejected', {reason: 'expired'});
        return '';
      }
      const key = (await accessSigningKeys(env)).find(candidate => candidate.kid === header.kid && candidate.kty === 'RSA');
      if (!key) {
        console.warn('Audrey Access JWT rejected', {reason: 'signing_key'});
        return '';
      }
      const cryptoKey = await crypto.subtle.importKey('jwk', key, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
      const verified = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5', cryptoKey, jwtSignatureBytes(encodedSignature), encoder.encode(encodedHeader + '.' + encodedClaims)
      );
      if (!verified) {
        console.warn('Audrey Access JWT rejected', {reason: 'signature'});
        return '';
      }
      const email = String(claims.email || '').trim().toLowerCase();
      if (!email) console.warn('Audrey Access JWT rejected', {reason: 'email'});
      return email;
    } catch (error) {
      console.warn('Audrey Access JWT validation failed', {
        name: String(error && error.name || 'Error'),
        message: String(error && error.message || '').slice(0, 160)
      });
      return '';
    }
  }
  console.warn('Audrey Access identity missing', {
    path: new URL(request.url).pathname,
    hasRuntimeIdentity: Boolean(ctx && ctx.access),
    hasJwt: Boolean(token),
    hasEmailHeader: Boolean(request.headers.get('cf-access-authenticated-user-email'))
  });
  return '';
}

export function canonicalAccessEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  const separator = email.lastIndexOf('@');
  if (separator <= 0) return email;
  let local = email.slice(0, separator);
  let domain = email.slice(separator + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') {
    local = local.split('+')[0].replace(/\./g, '');
  }
  return local + '@' + domain;
}

function allowedEmails(env) {
  return String(env.AUDREY_ALLOWED_EMAILS || '')
    .split(',').map(canonicalAccessEmail).filter(Boolean);
}

async function emailAllowed(email, env) {
  const canonical = canonicalAccessEmail(email);
  const hashes = String(env.AUDREY_ALLOWED_EMAIL_HASHES || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (hashes.length) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical));
    return hashes.includes(bytesToHex(new Uint8Array(digest)));
  }
  return allowedEmails(env).includes(canonical);
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
  const payload = method === 'GET' ? canonicalQuery(target.searchParams) : canonicalJsonBody(body);
  const signature = await signGatewayRequest(
    env.AUDREY_GATEWAY_SECRET, method, timestamp, payload
  );
  target.searchParams.set('gw_ts', String(timestamp));
  target.searchParams.set('gw_sig', signature);

  const headers = {'Accept': 'application/json'};
  if (method === 'POST') {
    headers['Content-Type'] = request.headers.get('Content-Type') || 'text/plain;charset=utf-8';
  }

  let postAction = '';
  if (method === 'POST') {
    try { postAction = String(JSON.parse(body).action || ''); } catch (_error) {}
  }
  const safeToRetry = method === 'GET' || postAction === 'rank_route_pois' || postAction === 'enrich_route';
  const attempts = safeToRetry ? 3 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const upstream = await fetchImpl(target.toString(), {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        redirect: 'follow'
      });
      const responseBody = await upstream.arrayBuffer();
      const contentType = upstream.headers.get('Content-Type') || '';
      const decodedBody = new TextDecoder().decode(responseBody);
      const preview = decodedBody.slice(0, 80).trim();
      const looksJson = /json/i.test(contentType) || preview.startsWith('{') || preview.startsWith('[');
      const retryable = safeToRetry && (upstream.status === 429 || upstream.status >= 500 || !looksJson);
      if (retryable && attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 200));
        continue;
      }
      if (!looksJson) {
        return json({error: 'Backend returned an invalid response', code: 'UPSTREAM_INVALID_RESPONSE'}, 502);
      }
      return new Response(responseBody, {
        status: upstream.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Audrey-Upstream-Attempts': String(attempt)
        }
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 200));
        continue;
      }
    }
  }
  console.error('Audrey backend request failed', lastError);
  return json({error: 'Backend is temporarily unavailable', code: 'UPSTREAM_UNAVAILABLE'}, 502);
}

export async function handleRequest(request, env, ctx, fetchImpl = fetch) {
  const email = await authenticatedEmail(request, env, ctx);
  if (!email || !(await emailAllowed(email, env))) {
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
  if (!env.STATIC || typeof env.STATIC.fetch !== 'function') {
    return json({error: 'Secure static site is not configured'}, 503);
  }
  return env.STATIC.fetch(request);
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
