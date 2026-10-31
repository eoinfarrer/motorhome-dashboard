const encoder = new TextEncoder();
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PUSH_SUBSCRIPTION_PREFIX = 'push-subscription:';
const PUSH_STATE_PREFIX = 'flood-push-state:';
const WEATHER_PUSH_STATE_PREFIX = 'weather-push-state:';
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
    const parsed = JSON.parse(body);
    // POST authentication fields are carried in the JSON envelope as well as
    // the query string. Exclude them from the signed payload so the signature
    // does not depend on where Google exposes those fields to Apps Script.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      delete parsed.gw_ts;
      delete parsed.gw_sig;
    }
    return JSON.stringify(canonicalJsonValue(parsed));
  } catch (_error) {
    return String(body || '');
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

function concatBytes(...arrays) {
  const size = arrays.reduce((total, array) => total + array.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  arrays.forEach(array => { result.set(array, offset); offset += array.length; });
  return result;
}

async function hmacSha256(keyBytes, valueBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, valueBytes));
}

async function hkdfExpand(prk, info, length) {
  const output = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])));
  return output.slice(0, length);
}

function validPushSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object') return false;
  let endpoint;
  try { endpoint = new URL(subscription.endpoint); } catch (_error) { return false; }
  if (endpoint.protocol !== 'https:') return false;
  const host = endpoint.hostname.toLowerCase();
  const trusted = host === 'fcm.googleapis.com'
    || host === 'updates.push.services.mozilla.com'
    || host === 'web.push.apple.com'
    || host.endsWith('.push.apple.com')
    || host.endsWith('.notify.windows.com');
  if (!trusted) return false;
  const p256dh = String(subscription.keys && subscription.keys.p256dh || '');
  const auth = String(subscription.keys && subscription.keys.auth || '');
  try {
    return base64UrlToBytes(p256dh).length === 65 && base64UrlToBytes(auth).length >= 16;
  } catch (_error) {
    return false;
  }
}

async function pushSubscriptionKey(subscription) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(subscription.endpoint || '')));
  return PUSH_SUBSCRIPTION_PREFIX + bytesToHex(new Uint8Array(digest)).slice(0, 32);
}

async function createVapidAuthorization(endpoint, env) {
  const privateJwk = JSON.parse(String(env.AUDREY_VAPID_PRIVATE_JWK || '{}'));
  const publicKey = String(env.AUDREY_VAPID_PUBLIC_KEY || '');
  if (!privateJwk.d || !privateJwk.x || !privateJwk.y || !publicKey) throw new Error('Web Push VAPID is not configured');
  const origin = new URL(endpoint).origin;
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({typ:'JWT', alg:'ES256'})));
  const claims = bytesToBase64Url(encoder.encode(JSON.stringify({
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: String(env.AUDREY_VAPID_SUBJECT || 'https://audrey.eoinfarrer.uk')
  })));
  const input = header + '.' + claims;
  const key = await crypto.subtle.importKey('jwk', privateJwk, {name:'ECDSA', namedCurve:'P-256'}, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, key, encoder.encode(input)));
  return 'vapid t=' + input + '.' + bytesToBase64Url(signature) + ', k=' + publicKey;
}

export async function encryptWebPushPayload(subscription, payload) {
  if (!validPushSubscription(subscription)) throw new Error('Invalid Web Push subscription');
  const clientPublic = base64UrlToBytes(subscription.keys.p256dh);
  const authSecret = base64UrlToBytes(subscription.keys.auth);
  const clientKey = await crypto.subtle.importKey('raw', clientPublic, {name:'ECDH', namedCurve:'P-256'}, false, []);
  const serverKeys = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits']);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH', public:clientKey}, serverKeys.privateKey, 256));

  const keyInfo = concatBytes(encoder.encode('WebPush: info\0'), clientPublic, serverPublic);
  const prkKey = await hmacSha256(authSecret, sharedSecret);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const contentKey = await hkdfExpand(prk, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, encoder.encode('Content-Encoding: nonce\0'), 12);
  const plaintext = concatBytes(encoder.encode(JSON.stringify(payload)), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv:nonce}, aesKey, plaintext));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);
  return concatBytes(salt, recordSize, new Uint8Array([serverPublic.length]), serverPublic, ciphertext);
}

export async function sendWebPush(subscription, notification, env, fetchImpl = fetch) {
  const body = await encryptWebPushPayload(subscription, notification);
  const response = await fetchImpl(subscription.endpoint, {
    method:'POST',
    headers:{
      'Authorization': await createVapidAuthorization(subscription.endpoint, env),
      'Content-Encoding':'aes128gcm',
      'Content-Type':'application/octet-stream',
      'TTL':'3600',
      'Urgency': notification && notification.urgency === 'high' ? 'high' : 'normal'
    },
    body
  });
  return {ok:response.ok, status:response.status};
}

async function storedPushSubscriptions(env) {
  if (!env.AUDREY_PUSH || typeof env.AUDREY_PUSH.list !== 'function') return [];
  const listed = await env.AUDREY_PUSH.list({prefix:PUSH_SUBSCRIPTION_PREFIX});
  const subscriptions = [];
  for (const key of listed.keys || []) {
    const value = await env.AUDREY_PUSH.get(key.name, 'json');
    if (validPushSubscription(value)) subscriptions.push({key:key.name, subscription:value});
  }
  return subscriptions;
}

async function deliverPushToAll(env, notification, fetchImpl = fetch, shouldDeliver = () => true) {
  const subscriptions = await storedPushSubscriptions(env);
  const results = [];
  for (const item of subscriptions) {
    if (!shouldDeliver(item.subscription, notification)) continue;
    try {
      const result = await sendWebPush(item.subscription, notification, env, fetchImpl);
      results.push(result);
      if (result.status === 404 || result.status === 410) await env.AUDREY_PUSH.delete(item.key);
    } catch (error) {
      console.warn('Audrey Web Push delivery failed', {message:String(error && error.message || error).slice(0,160)});
      results.push({ok:false, status:0});
    }
  }
  return results;
}

function weatherSeverityAllowed(alert, subscription) {
  const prefs = subscription && subscription.audreyPreferences || {};
  const minimum = {alert:2, warning:3, severe:4}[String(prefs.severity || 'alert')] || 2;
  const severity = String(alert.severity || 'alert');
  if (({alert:2, warning:3, severe:4}[severity] || 2) < minimum) return false;
  if (severity === 'severe') return true;
  const start = String(prefs.quietStart || '22:00'), end = String(prefs.quietEnd || '07:00');
  const current = new Date();
  const minutes = current.getUTCHours() * 60 + current.getUTCMinutes();
  const parse = value => { const match = /^(\d{2}):(\d{2})$/.exec(value); return match ? Number(match[1]) * 60 + Number(match[2]) : null; };
  const startMinutes = parse(start), endMinutes = parse(end);
  if (startMinutes == null || endMinutes == null || startMinutes === endMinutes) return true;
  const quiet = startMinutes < endMinutes ? minutes >= startMinutes && minutes < endMinutes : minutes >= startMinutes || minutes < endMinutes;
  return !quiet;
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

  let upstreamBody = body;
  if (method === 'POST') {
    try {
      const envelope = JSON.parse(body);
      if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
        envelope.gw_ts = String(timestamp);
        envelope.gw_sig = signature;
        upstreamBody = JSON.stringify(envelope);
      }
    } catch (_error) {
      // Non-JSON requests retain query-string authentication for compatibility.
    }
  }

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
        body: method === 'POST' ? upstreamBody : undefined,
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

async function fetchAudreyDashboardForPush(env, fetchImpl = fetch) {
  if (!env.AUDREY_APPS_SCRIPT_URL || !env.AUDREY_GATEWAY_SECRET) throw new Error('Secure backend is not configured');
  const target = new URL(env.AUDREY_APPS_SCRIPT_URL);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signGatewayRequest(env.AUDREY_GATEWAY_SECRET, 'GET', timestamp, canonicalQuery(target.searchParams));
  target.searchParams.set('gw_ts', String(timestamp));
  target.searchParams.set('gw_sig', signature);
  const response = await fetchImpl(target.toString(), {headers:{'Accept':'application/json'}, redirect:'follow'});
  if (!response.ok) throw new Error('Audrey backend returned HTTP ' + response.status);
  const data = await response.json();
  if (data && data.error) throw new Error(String(data.error));
  return data;
}

function floodPushState(alerts) {
  return (alerts || []).reduce((state, alert) => {
    if (alert && alert.id) state[String(alert.id)] = Number(alert.severityLevel || 9);
    return state;
  }, {});
}

function floodPushNotification(alert, data) {
  const level = Number(alert.severityLevel);
  const label = level === 1 ? 'Severe flood warning' : level === 2 ? 'Flood warning' : 'Flood alert';
  const targets = (alert.targets || []).map(target => target.label).filter(Boolean);
  const target = targets[0] || alert.targetLabel || data && data.meta && data.meta.currentLocation || 'your trip';
  return {
    title:'Audrey · ' + label,
    body:String(alert.title || label) + ' near ' + target + '. Open Audrey for official details.',
    tag:'audrey-flood-' + String(alert.id || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(-80),
    url:'/?view=home',
    urgency:level <= 2 ? 'high' : 'normal'
  };
}

export async function runFloodPushCheck(env, fetchImpl = fetch) {
  if (!env.AUDREY_PUSH) return {checked:false, reason:'storage_unavailable'};
  const data = await fetchAudreyDashboardForPush(env, fetchImpl);
  const risk = data && data.floodRisk || {};
  const alerts = risk.monitoring && Array.isArray(risk.alerts) ? risk.alerts : [];
  const trip = String(data && data.meta && data.meta.tripName || 'trip').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0,80);
  const stateKey = PUSH_STATE_PREFIX + trip;
  const previous = await env.AUDREY_PUSH.get(stateKey, 'json') || {};
  const current = floodPushState(alerts);
  if (!alerts.length) {
    await env.AUDREY_PUSH.put(stateKey, JSON.stringify(current));
    return {checked:true, alerts:0, sent:0};
  }
  const changed = alerts.filter(alert => previous[alert.id] == null || Number(alert.severityLevel) < Number(previous[alert.id]));
  if (!changed.length) return {checked:true, alerts:alerts.length, sent:0};
  changed.sort((left,right) => Number(left.severityLevel) - Number(right.severityLevel));
  const deliveries = await deliverPushToAll(env, floodPushNotification(changed[0], data), fetchImpl);
  const sent = deliveries.filter(result => result.ok).length;
  if (sent) await env.AUDREY_PUSH.put(stateKey, JSON.stringify(current));
  return {checked:true, alerts:alerts.length, changed:changed.length, sent};
}

function weatherPushNotification(alert) {
  const urgency = alert.severity === 'severe' || alert.severity === 'warning' ? 'high' : 'normal';
  return {
    title: 'Audrey · ' + String(alert.title || 'Weather risk'),
    body: String(alert.message || 'Review conditions before setting out.') + (alert.action ? ' ' + String(alert.action) : ''),
    tag: 'audrey-weather-' + String(alert.type || 'risk') + '-' + String(alert.date || '').replace(/[^A-Za-z0-9_-]/g, '-'),
    url: '/?view=home',
    urgency
  };
}

export async function runWeatherPushCheck(env, fetchImpl = fetch) {
  if (!env.AUDREY_PUSH) return {checked:false, reason:'storage_unavailable'};
  const data = await fetchAudreyDashboardForPush(env, fetchImpl);
  const risk = data && data.weatherRisk || {};
  const alerts = risk.alerts && Array.isArray(risk.alerts) ? risk.alerts : [];
  const trip = String(data && data.meta && data.meta.tripName || 'trip').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0,80);
  const stateKey = WEATHER_PUSH_STATE_PREFIX + trip;
  const previous = await env.AUDREY_PUSH.get(stateKey, 'json') || {};
  const rank = {severe:4, warning:3, alert:2, info:1};
  const current = alerts.reduce((state, alert) => {
    const id = String(alert.type || 'risk') + '|' + String(alert.date || '') + '|' + String(alert.location || '');
    state[id] = rank[alert.severity] || 1;
    return state;
  }, {});
  const changed = alerts.filter(alert => {
    const id = String(alert.type || 'risk') + '|' + String(alert.date || '') + '|' + String(alert.location || '');
    return previous[id] == null || (rank[alert.severity] || 1) > Number(previous[id]);
  });
  if (!changed.length) {
    await env.AUDREY_PUSH.put(stateKey, JSON.stringify(current));
    return {checked:true, alerts:alerts.length, sent:0};
  }
  changed.sort((left, right) => (rank[right.severity] || 0) - (rank[left.severity] || 0));
  const chosen = changed[0];
  const deliveries = await deliverPushToAll(env, weatherPushNotification(chosen), fetchImpl, subscription => weatherSeverityAllowed(chosen, subscription));
  const sent = deliveries.filter(result => result.ok).length;
  if (sent) await env.AUDREY_PUSH.put(stateKey, JSON.stringify(current));
  return {checked:true, alerts:alerts.length, changed:changed.length, sent};
}

export async function runActivitySuggestionPushCheck(env, fetchImpl = fetch) {
  if (!env.AUDREY_PUSH) return {checked:false, reason:'storage_unavailable'};
  const data = await fetchAudreyDashboardForPush(env, fetchImpl);
  const suggestion = data && data.activitySuggestion;
  if (!suggestion) return {checked:true, sent:0, reason:'no_high_signal_suggestion'};
  const trip = String(data && data.meta && data.meta.tripName || 'trip').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0,80);
  const key = PUSH_STATE_PREFIX + 'activity-suggestion:' + trip + ':' + String(suggestion.date || 'today');
  if (await env.AUDREY_PUSH.get(key)) return {checked:true, sent:0, reason:'already_sent'};
  const deliveries = await deliverPushToAll(env, {title:'Audrey · '+String(suggestion.title || 'Today suggestion'), body:String(suggestion.message || '')+' '+String(suggestion.action || ''), tag:'audrey-activity-'+String(suggestion.date || 'today'), url:'/?view=home', urgency:'normal'}, fetchImpl, subscription => !!(subscription.audreyPreferences && subscription.audreyPreferences.activityAware));
  const sent = deliveries.filter(result => result.ok).length;
  if (sent) await env.AUDREY_PUSH.put(key, 'sent');
  return {checked:true, sent};
}

async function handlePushRoute(request, env, url, fetchImpl) {
  if (!env.AUDREY_PUSH) return json({error:'Notification storage is not configured'}, 503);
  if (url.pathname === '/push/public-key' && request.method === 'GET') {
    const publicKey = String(env.AUDREY_VAPID_PUBLIC_KEY || '');
    return publicKey ? json({publicKey}) : json({error:'Notifications are not configured'}, 503);
  }
  if (url.pathname === '/push/subscription' && request.method === 'POST') {
    const subscription = await request.json();
    if (!validPushSubscription(subscription)) return json({error:'Invalid notification subscription'}, 400);
    const key = await pushSubscriptionKey(subscription);
    await env.AUDREY_PUSH.put(key, JSON.stringify(subscription));
    return json({success:true});
  }
  if (url.pathname === '/push/subscription' && request.method === 'DELETE') {
    const subscription = await request.json();
    if (subscription && subscription.endpoint) await env.AUDREY_PUSH.delete(await pushSubscriptionKey(subscription));
    return json({success:true});
  }
  if (url.pathname === '/push/test' && request.method === 'POST') {
    const deliveries = await deliverPushToAll(env, {
      title:'Audrey notifications are ready',
      body:'Flood and critical travel alerts can now reach this iPhone when Audrey is closed.',
      tag:'audrey-notification-test', url:'/?view=home', urgency:'normal'
    }, fetchImpl);
    return json({success:deliveries.some(result => result.ok), delivered:deliveries.filter(result => result.ok).length});
  }
  return json({error:'Not found'}, 404);
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
  if (url.pathname.startsWith('/push/')) {
    if (!['GET','POST','DELETE'].includes(request.method)) return json({error:'Method not allowed'}, 405);
    return handlePushRoute(request, env, url, fetchImpl);
  }
  if (!env.STATIC || typeof env.STATIC.fetch !== 'function') {
    return json({error: 'Secure static site is not configured'}, 503);
  }
  return env.STATIC.fetch(request);
}

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([
      runFloodPushCheck(env).catch(error => console.error('Audrey scheduled flood push failed', {message:String(error && error.message || error).slice(0,160)})),
      runWeatherPushCheck(env).catch(error => console.error('Audrey scheduled weather push failed', {message:String(error && error.message || error).slice(0,160)})),
      runActivitySuggestionPushCheck(env).catch(error => console.error('Audrey scheduled activity suggestion failed', {message:String(error && error.message || error).slice(0,160)}))
    ]));
  }
};
