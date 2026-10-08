import assert from 'node:assert/strict';
import test from 'node:test';
import {canonicalAccessEmail, canonicalJsonBody, canonicalQuery, handleRequest, signGatewayRequest} from './index.mjs';

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

test('secure gateway returns JSON when the upstream remains invalid', async () => {
  const response = await handleRequest(
    new Request('https://audrey.example/api?action=get_routes'),
    env(), access(), async () => new Response('<!doctype html><title>Bad gateway</title>')
  );
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal((await response.json()).code, 'UPSTREAM_INVALID_RESPONSE');
});
