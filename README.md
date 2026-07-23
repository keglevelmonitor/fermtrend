# FermTrend

Standalone browser app for Brewer's Friend SG-stability analysis and
trend charts. Point it at any of your BF sessions, get the same FG
classification (Stable / Settling / Still Fermenting / Jittery Readings
/ Not Enough Readings) and SG-trend graph that the FermVault Brain
dashboard shows — no fermentation controller hardware required.

Everything runs in your browser. Your Brewer's Friend API key is
stored only in `localStorage` on the device you're using; it is never
sent to any server other than Cloudflare's CORS-proxy Worker (which
forwards the request as-is to `api.brewersfriend.com` and does not log
or persist the key).

## Try it

<https://keglevelmonitor.github.io/FermTrend/>

1. Get your BF API key from <https://web.brewersfriend.com/apikey>.
2. Paste it into the SETTINGS tab. Click **Save**.
3. Go to the SESSIONS tab and pick a session.
4. The DASHBOARD tab now shows the SG trend + FG classification.

## FG analyzer settings

Same knobs the FermVault Brain exposes on its API & FG tab:

| Setting          | Default   | What it does                                                    |
|------------------|-----------|-----------------------------------------------------------------|
| Tolerance        | 0.0005 SG | Max spread inside the analysis window to call it Stable.        |
| Window (days)    | 3         | How many days back to look. 1–6.                                |
| Max outliers     | 4         | How many reading spikes we're allowed to ignore.                |
| Min readings     | 20        | How many readings the window must contain.                      |
| Stale hours      | 6         | Newest reading older than this → data-stale banner.             |

Change any of these and the analyzer + chart re-render live. Nothing
is persisted server-side; your settings live in `localStorage`.

## Repo layout

```
FermTrend/
  index.html            single-page app entry
  style.css             dark theme, same palette as FermVault Brain
  app.js                app shell + tab routing + settings form
  fg.js                 pure JS FG stability analyzer (lifted from FVP)
  chart.js              inline-SVG SG-trend chart (lifted from FVP)
  bf-client.js          browser BF API client, talks to the Worker
  storage.js            IndexedDB ring-buffer + config cache
  worker/               Cloudflare Worker CORS proxy (deploy separately)
  .github/workflows/    Pages auto-deploy on push to main
```

## Deploying your own copy

**Prerequisites:** free Cloudflare account (Workers), free GitHub
account (Pages), Node.js 18+ locally.

### 1. Fork or clone this repo

```
git clone https://github.com/keglevelmonitor/FermTrend.git
cd FermTrend
```

### 2. Deploy the Cloudflare Worker (CORS proxy)

Brewer's Friend's REST API does not send CORS headers, so a browser
cannot call `api.brewersfriend.com` directly. This ~20-line Worker
proxies the request and adds the needed headers.

```
cd worker
npm install -g wrangler         # first time only
wrangler login                  # opens a browser to authorize
wrangler deploy
```

Wrangler prints a URL like:
`https://fermtrend-proxy.<your-subdomain>.workers.dev`

Copy that URL. Edit `bf-client.js` and set:

```js
const WORKER_URL = "https://fermtrend-proxy.<your-subdomain>.workers.dev";
```

Commit and push.

### 3. Enable GitHub Pages

In your fork's repo settings → Pages → Source: **GitHub Actions**.
The included workflow (`.github/workflows/pages.yml`) publishes on
every push to `main`. First deploy takes ~30 s.

Your site is live at `https://<yourname>.github.io/FermTrend/`.

### 4. Lock the Worker to your Pages origin

In `worker/index.js`, change `ALLOWED_ORIGIN` to match your Pages URL
so only your site can use your Worker:

```js
const ALLOWED_ORIGIN = "https://<yourname>.github.io";
```

Redeploy: `cd worker && wrangler deploy`.

## Security notes

- **API key stays local.** `bf-client.js` reads the key from
  `localStorage` and puts it in the request's `Authorization` header.
  The Worker relays the header unchanged; it does not log or persist
  it. Rotate the key on <https://web.brewersfriend.com/apikey> any
  time.
- **The Worker has no persistence.** Every request is a pure
  fetch-through. No logs, no KV, no D1.
- **Source is auditable.** This repo is public. If you don't trust
  the hosted deploy, run your own — takes 15 minutes end-to-end.

## Relationship to FermVault Brain

FermTrend is a pure-JS spinoff of the FG-analysis + SG-trend code
that lives in the FermVault Brain dashboard (private repo). The
analyzer output is byte-for-byte identical: same tolerance, same
window logic, same classification vocabulary. If a session classifies
as Stable here, it classifies as Stable there. That gives you a way
to try the analyzer against your BF data without setting up a Pico
first — and gives me a standalone testbed for algorithm tweaks
before they go into the Brain firmware.

## License

MIT — see `LICENSE`.
