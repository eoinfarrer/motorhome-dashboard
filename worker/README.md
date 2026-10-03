# Secure Audrey staging deployment

The secure staging setup uses two Workers. `audrey-secure` holds the separate
static Audrey build. `audrey-gateway` is the protected entry point, checks the
Cloudflare Access identity, serves those files through a Service binding, and
proxies `/api` to a gateway-protected Apps Script deployment. This split is
required because Cloudflare does not expose `ctx.access` to a Worker that has
its own Static Assets binding. The existing GitHub Pages site and Apps Script
deployment continue running while this version is tested.

## Cloudflare setup

1. Upload `dist-secure` to the `audrey-secure` static Worker.
2. Deploy `audrey-gateway` and bind `STATIC` to the `audrey-secure` service.
3. Enable Cloudflare Access for both preview and production gateway URLs.
4. Add an Allow policy for the owner's exact email address.
5. Configure these encrypted gateway secrets:
   - `AUDREY_APPS_SCRIPT_URL`
   - `AUDREY_GATEWAY_SECRET`
   - `AUDREY_ALLOWED_EMAILS`
6. Set the same `AUDREY_GATEWAY_SECRET` value in Apps Script properties.

Use `.dev.vars.example` as the local configuration template. Never commit
`.dev.vars` or the gateway secret.

## Commands

```sh
npm test
npm run build:secure
npm run dev:secure
npm run deploy:secure
```

## Cutover

1. Test the protected Worker URL on phone and desktop.
2. Verify dashboard reads, trip edits, settings, route imports and exports.
3. Replace the public GitHub Pages app with a link to the protected URL.
4. Remove the old anonymous Apps Script deployment.
5. Reauthorise Strava with `read_all` only after the public endpoint is gone.

The old Apps Script deployment is an immutable older version, so it remains a
rollback option until it is explicitly removed.
