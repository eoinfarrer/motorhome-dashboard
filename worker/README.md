# Secure Audrey staging deployment

This Worker hosts a separate Audrey build and proxies its `/api` requests to a
gateway-protected Apps Script deployment. The existing GitHub Pages site and
Apps Script deployment can continue running while this version is tested.

## Cloudflare setup

1. Create a Worker on the Cloudflare free plan.
2. Enable Cloudflare Access for both preview and production Worker URLs.
3. Add an Allow policy for the owner's exact email address.
4. Configure these encrypted Worker secrets:
   - `AUDREY_APPS_SCRIPT_URL`
   - `AUDREY_GATEWAY_SECRET`
   - `AUDREY_ALLOWED_EMAILS`
5. Set the same `AUDREY_GATEWAY_SECRET` value in Apps Script properties.

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
