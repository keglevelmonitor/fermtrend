# FermTrend CORS Proxy Worker

A stateless Cloudflare Worker that proxies requests from the FermTrend
browser app to `api.brewersfriend.com` and adds the `Access-Control-*`
response headers that Brewer's Friend's API does not set.

Without this, the browser cannot call BF's REST API at all — the
preflight OPTIONS request fails immediately.

## Deploy

```
npm install -g wrangler
wrangler login              # opens a browser to authorize
wrangler deploy
```

Wrangler prints a URL like `https://fermtrend-proxy.<subdomain>.workers.dev`.
Copy that URL into `../bf-client.js` (the `WORKER_URL` constant near the top).

## Locking to your Pages origin

Production traffic is allowed from `https://keglevelmonitor.github.io`
(and your fork's Pages URL if you change `PRODUCTION_ORIGIN` in
`index.js`).

Local preview is also allowed so `npx serve` / `localhost` / LAN
`192.168.*` / `10.*` HTTP origins can hit the Worker during development.
Random public websites are still blocked by CORS.

## What it does NOT do

- No logging. No KV. No D1. No R2. No secrets.
- Does not inspect the Authorization header — just forwards it.
- Does not cache. Every request goes to BF fresh.
- Does not accept anything other than GET (and OPTIONS preflight).
- Does not forward cookies in either direction.

## Cost

Free tier: 100,000 requests/day, 10ms CPU per request. Typical
single-user daily traffic is well under 1,500 requests. One Worker
comfortably serves dozens of concurrent users on the free tier.

## Local development

```
wrangler dev
```

Runs the Worker locally at `http://localhost:8787`. Point
`WORKER_URL` at that during development if you want to iterate on
the proxy without deploying.
