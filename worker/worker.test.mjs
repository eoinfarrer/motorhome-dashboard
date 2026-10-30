import assert from 'node:assert/strict';
import test from 'node:test';
import {canonicalAccessEmail, canonicalJsonBody, canonicalQuery, encryptWebPushPayload, handleRequest, runFloodPushCheck, sendWebPush, signGatewayRequest} from './index.mjs';

class MemoryKv {
  constructor() { this.values = new Map(); }
  async get(key, type) {
    const value = this.values.get(key);
    if (value == null) return null;
    return type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.values.set(key, String(value)); }
  async delete(key) { this.values.delete(key); }
  async list(options = {}) {
    const prefix = options.prefix || '';
    return {keys: Array.from(this.values.keys()).filter(key => key.startsWith(prefix)).map(name => ({name}))};
  }
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function pushFixture() {
  const recipient = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits']);
  const recipientPublic = new Uint8Array(await crypto.subtle.exportKey('raw', recipient.publicKey));
  const vapid = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', vapid.privateKey);
  const publicJwk = await crypto.subtle.exportKey('jwk', vapid.publicKey);
  const publicRaw = new Uint8Array(65);
  publicRaw[0] = 4;
  publicRaw.set(Buffer.from(publicJwk.x, 'base64url'), 1);
  publicRaw.set(Buffer.from(publicJwk.y, 'base64url'), 33);
  return {
    subscription: {
      endpoint:'https://fcm.googleapis.com/fcm/send/audrey-test',
      keys:{p256dh:base64Url(recipientPublic), auth:base64Url(crypto.getRandomValues(new Uint8Array(16)))}
    },
    vapidEnv:{
      AUDREY_VAPID_PRIVATE_JWK:JSON.stringify(privateJwk),
      AUDREY_VAPID_PUBLIC_KEY:base64Url(publicRaw),
      AUDREY_VAPID_SUBJECT:'https://audrey.example'
    }
  };
}

function access(email = 'owner@example.com') {
  return {access: {getIdentity: async () => ({email})}};
}

function env(overrides = {}) {
  return {
    AUDREY_ALLOWED_EMAILS: 'owner@example.com',
    AUDREY_APPS_SCRIPT_URL: 'https://script.google.com/macros/s/secure/exec',
    AUDREY_GATEWAY_SECRET: 'test-secret',
    STATIC: {fetch: async () => new Response('asset')},
    ...overrides
  };
}

test('secure Worker rejects requests without a validated Access identity', async () => {
  const response = await handleRequest(
    new Request('https://audrey.example/health'), env(), {}, async () => new Response('{}')
  );
  assert.equal(response.status, 401);
});

test('secure Worker does not trust an unsigned Access email header', async () => {
  const response = await handleRequest(
    new Request('https://audrey.example/health', {
      headers: {'cf-access-authenticated-user-email': 'owner@example.com'}
    }), env(), {}, async () => new Response('{}')
  );
  assert.equal(response.status, 401);
});

test('secure Worker prefers the identity already verified by Workers Access', async () => {
  const response = await handleRequest(
    new Request('https://audrey.example/health', {
      headers: {'cf-access-jwt-assertion': 'not.a.valid-jwt'}
    }), env(), access(), async () => new Response('{}')
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true, authenticated: true});
});

test('secure Worker enforces its owner allowlist after Access authentication', async () => {
  const response = await handleRequest(
    new Request('https://audrey.example/health'), env(), access('other@example.com')
  );
  assert.equal(response.status, 403);
});

test('secure Worker treats Gmail and Googlemail aliases as the same mailbox', async () => {
  assert.equal(canonicalAccessEmail('Eoin.Farrer+audrey@googlemail.com'), 'eoinfarrer@gmail.com');
  const response = await handleRequest(
    new Request('https://audrey.example/health'),
    env({AUDREY_ALLOWED_EMAILS: 'eoinfarrer@gmail.com'}),
    access('Eoin.Farrer+audrey@googlemail.com')
  );
  assert.equal(response.status, 200);
});

test('secure Worker can enforce a deployment-stable hashed owner allowlist', async () => {
  const allowed = await handleRequest(
    new Request('https://audrey.example/health'),
    env({
      AUDREY_ALLOWED_EMAILS: 'stale@example.com',
      AUDREY_ALLOWED_EMAIL_HASHES: 'afd76a0e454d2edbc591115d0cff9a72c6683e4c169e0c97014c74525bb2a27b'
    }),
    access('eoinfarrer@gmail.com')
  );
  assert.equal(allowed.status, 200);

  const denied = await handleRequest(
    new Request('https://audrey.example/health'),
    env({AUDREY_ALLOWED_EMAIL_HASHES: 'afd76a0e454d2edbc591115d0cff9a72c6683e4c169e0c97014c74525bb2a27b'}),
    access('other@gmail.com')
  );
  assert.equal(denied.status, 403);
});

test('secure gateway serves the bound static site to its allowed owner', async () => {
  const response = await handleRequest(
    new Request('https://audrey.example/'), env(), access()
  );
  assert.equal(await response.text(), 'asset');
});

test('secure Worker signs and forwards query requests to Apps Script', async () => {
  let forwarded;
  const response = await handleRequest(
    new Request('https://audrey.example/api?trip=Italy%20Winter&action=get_trip_draft'),
    env(), access(), async (url, options) => {
      forwarded = {url: new URL(url), options};
      return new Response(JSON.stringify({success: true}), {
        headers: {'Content-Type': 'application/json'}
      });
    }
  );

  assert.equal(response.status, 200);
  assert.equal(forwarded.options.method, 'GET');
  assert.match(forwarded.url.searchParams.get('gw_sig'), /^[a-f0-9]{64}$/);
  assert.ok(forwarded.url.searchParams.get('gw_ts'));
  assert.equal(forwarded.url.searchParams.get('trip'), 'Italy Winter');
});

test('gateway signatures are deterministic across query ordering', async () => {
  const left = canonicalQuery(new URLSearchParams('trip=A%20B&action=get_trip_draft'));
  const right = canonicalQuery(new URLSearchParams('action=get_trip_draft&trip=A+B'));
  assert.equal(left, right);
  assert.equal(
    await signGatewayRequest('secret', 'GET', 123, left),
    await signGatewayRequest('secret', 'GET', 123, right)
  );
});

test('POST signatures use stable JSON regardless of formatting and key order', () => {
  const left = canonicalJsonBody('{"route":{"name":"Albanyà","points":[{"lon":2,"lat":1}]},"action":"rank_route_pois"}');
  const right = canonicalJsonBody('{\n  "action": "rank_route_pois", "route": {"points": [{"lat": 1, "lon": 2}], "name": "Albanyà"}\n}');
  assert.equal(left, right);
});

test('secure gateway retries a transient invalid GET response', async () => {
  let attempts = 0;
  const response = await handleRequest(
    new Request('https://audrey.example/api?action=get_routes'),
    env(), access(), async () => {
      attempts++;
      if (attempts === 1) return new Response('<!doctype html><title>Temporary error</title>');
      return new Response(JSON.stringify({success: true, routes: []}), {
        headers: {'Content-Type': 'application/json'}
      });
    }
  );
  assert.equal(attempts, 2);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Audrey-Upstream-Attempts'), '2');
  assert.deepEqual(await response.json(), {success: true, routes: []});
});

test('secure gateway retries a read-only route POST but not a trip mutation', async () => {
  let routeAttempts = 0;
  const routeResponse = await handleRequest(
    new Request('https://audrey.example/api', {
      method: 'POST', body: JSON.stringify({action:'rank_route_pois',features:[]})
    }), env(), access(), async () => {
      routeAttempts++;
      return routeAttempts === 1
        ? new Response('<!doctype html><title>Temporary error</title>')
        : new Response(JSON.stringify({success:true,pois:[]}), {headers:{'Content-Type':'application/json'}});
    }
  );
  assert.equal(routeAttempts, 2);
  assert.equal(routeResponse.status, 200);

  let mutationAttempts = 0;
  const mutationResponse = await handleRequest(
    new Request('https://audrey.example/api', {
      method: 'POST', body: JSON.stringify({action:'update_trip',tripName:'Test'})
    }), env(), access(), async () => {
      mutationAttempts++;
      return new Response('<!doctype html><title>Temporary error</title>');
    }
  );
  assert.equal(mutationAttempts, 1);
  assert.equal(mutationResponse.status, 502);
});

test('secure gateway carries POST authentication in the JSON envelope', async () => {
  let forwarded;
  const response = await handleRequest(
    new Request('https://audrey.example/api', {
      method: 'POST',
      headers: {'Content-Type':'text/plain;charset=utf-8'},
      body: JSON.stringify({action:'create_trip',tripName:'Christmas Eve in Horsham',items:[]})
    }),
    env(), access(), async (url, options) => {
      forwarded = {url, body: JSON.parse(options.body)};
      return new Response(JSON.stringify({success:true,tripName:'Christmas Eve in Horsham'}), {
        headers:{'Content-Type':'application/json'}
      });
    }
  );
  assert.equal(response.status, 200);
  const target = new URL(forwarded.url);
  assert.match(target.searchParams.get('gw_ts'), /^\d+$/);
  assert.match(target.searchParams.get('gw_sig'), /^[a-f0-9]{64}$/);
  assert.equal(forwarded.body.gw_ts, target.searchParams.get('gw_ts'));
  assert.equal(forwarded.body.gw_sig, target.searchParams.get('gw_sig'));
  assert.equal(forwarded.body.action, 'create_trip');
});

test('secure gateway returns JSON when the upstream remains invalid', async () => {
  const response = await handleRequest(
    new Request('https://audrey.example/api?action=get_routes'),
    env(), access(), async () => new Response('<!doctype html><title>Bad gateway</title>')
  );
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal((await response.json()).code, 'UPSTREAM_INVALID_RESPONSE');
});

test('secure Worker stores only a validated owner push subscription', async () => {
  const fixture = await pushFixture();
  const storage = new MemoryKv();
  const configured = env({...fixture.vapidEnv, AUDREY_PUSH:storage});
  const keyResponse = await handleRequest(new Request('https://audrey.example/push/public-key'), configured, access());
  assert.equal(keyResponse.status, 200);
  assert.equal((await keyResponse.json()).publicKey, fixture.vapidEnv.AUDREY_VAPID_PUBLIC_KEY);

  const response = await handleRequest(new Request('https://audrey.example/push/subscription', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(fixture.subscription)
  }), configured, access());
  assert.equal(response.status, 200);
  assert.equal((await storage.list({prefix:'push-subscription:'})).keys.length, 1);
});

test('Web Push payload uses the RFC 8291 record shape and VAPID headers', async () => {
  const fixture = await pushFixture();
  const encrypted = await encryptWebPushPayload(fixture.subscription, {title:'Audrey test', body:'Ready'});
  assert.equal(encrypted.length > 16 + 4 + 1 + 65, true);
  assert.equal(new DataView(encrypted.buffer, encrypted.byteOffset + 16, 4).getUint32(0, false), 4096);
  assert.equal(encrypted[20], 65);

  let sent;
  const result = await sendWebPush(fixture.subscription, {title:'Audrey test', body:'Ready'}, fixture.vapidEnv, async (url, options) => {
    sent = {url, options};
    return new Response('', {status:201});
  });
  assert.equal(result.ok, true);
  assert.equal(sent.options.headers['Content-Encoding'], 'aes128gcm');
  assert.match(sent.options.headers.Authorization, /^vapid t=.+, k=.+$/);
});

test('scheduled flood push sends only for a new or escalated official warning', async () => {
  const fixture = await pushFixture();
  const storage = new MemoryKv();
  const configured = env({...fixture.vapidEnv, AUDREY_PUSH:storage});
  await storage.put('push-subscription:test', JSON.stringify(fixture.subscription));
  let deliveries = 0;
  const dashboard = {
    meta:{tripName:'Lake District'},
    floodRisk:{monitoring:true, alerts:[{id:'ea:123', severityLevel:2, title:'Flood warning for Keswick', targets:[{label:'Keswick'}]}]}
  };
  const mockFetch = async url => {
    if (String(url).startsWith(configured.AUDREY_APPS_SCRIPT_URL)) {
      return new Response(JSON.stringify(dashboard), {headers:{'Content-Type':'application/json'}});
    }
    deliveries++;
    return new Response('', {status:201});
  };
  const first = await runFloodPushCheck(configured, mockFetch);
  const second = await runFloodPushCheck(configured, mockFetch);
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(deliveries, 1);
});
