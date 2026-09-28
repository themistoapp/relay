# Relay

Pull APIs on a schedule, pick and transform the data you need, and serve it back out as your own
clean API. Self-hosted in Docker. [Try the click-through demo](https://themisto.app/relay/about.html#try-me).

1. **Source**: a URL, method, auth and schedule. Relay calls it and keeps every response.
2. **Response**: the shape of what came back, worked out automatically.
3. **Pick**: tick the fields you want.
4. **Transform**: maths (× ÷ round…), list summaries (lowest, average, "the name of the cheapest"…),
   text and dates, and history (change over 24 h, highest this week…).
5. **Shape**: build the JSON you'll serve with drag and drop: groups, and lists that repeat per item,
   sorted, filtered and trimmed.
6. **Publish**: an address, API keys, CORS and a rate limit.

The **History** tab on each source shows every pull, what changed between them, and any field over
time. **Data** is a read-only view of the database, plus storage, backups and settings export.

## Quick start

You need Docker with Compose.

```sh
git clone https://github.com/themistoapp/relay.git && cd relay
cat > .env <<EOT
ADMIN_PASSWORD=pick-a-password
APP_SECRET=$(openssl rand -base64 32)
EOT
docker compose up -d
```

Open http://localhost:8080 and sign in. Published endpoints are served from http://localhost:8081.
Keep a copy of `.env`: without `APP_SECRET`, stored API tokens can't be decrypted.

## Two ports

| Port | Serves | Expose it? |
| --- | --- | --- |
| 8080 | Admin UI and its API | LAN only, or behind Cloudflare Access |
| 8081 | Published endpoints at `/v1/<name>`, and `/healthz` | Yes, through a reverse proxy |

The admin API doesn't exist on 8081 at all, so pointing a public hostname at 8081 can't expose it.
If something else already uses 8080 or 8081, set `ADMIN_HOST_PORT` / `PUBLIC_HOST_PORT`.

## Settings

Set these in `.env` (or your stack's environment). Only the first two are required.

| Variable | Default | What it's for |
| --- | --- | --- |
| `ADMIN_PASSWORD` | (none) | The admin UI password (8+ characters). |
| `APP_SECRET` | (none) | Encrypts stored upstream tokens and signs the login cookie (16+ characters, e.g. `openssl rand -base64 32`). **Back it up.** Without it, stored tokens can't be decrypted and have to be re-entered. |
| `PUBLIC_BASE_URL` | `http://localhost:8081` | The public address of port 8081, e.g. `https://api.example.com`. Only used to show full URLs in the UI. |
| `TZ` | `Europe/London` | Time zone for schedules, "daily" pulls and history windows. |
| `CLIENT_IP_HEADER` | (empty) | Set to `cf-connecting-ip` when traffic comes through Cloudflare, so rate limits and logs see the visitor rather than a Cloudflare edge. |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Which proxies may set `X-Forwarded-For`. The default trusts private networks (NPM on the same host or LAN). |
| `ALERT_WEBHOOK_URL` | (empty) | Called when a source fails `ALERT_AFTER_FAILURES` pulls in a row, and again when it recovers. ntfy URLs get a plain message; anything else (e.g. a Home Assistant webhook) gets JSON `{title, message, source, status}`. |
| `ALERT_AFTER_FAILURES` | `3` | |
| `BACKUP_KEEP` | `7` | Nightly database copies to keep in `/data/backups` (0 turns backups off). |
| `REQUEST_LOG_KEEP` | `20000` | Rows of the endpoint request log to keep. |
| `MAX_RESPONSE_MB` | `10` | Upstream responses bigger than this are refused. |

## Deploying with Portainer

1. Add a stack and paste in `docker-compose.yml`. It builds straight from this repo, so nothing else
   is needed.
2. Set `ADMIN_PASSWORD`, `APP_SECRET`, `PUBLIC_BASE_URL` and anything else from the table above in
   the stack's environment.
3. Deploy, then check `http://<host>:8081/healthz`. `builtAt` shows when the image was built, so you
   can tell a fresh redeploy from a stale image.
4. To update, use **Pull and redeploy** with **Re-pull image and redeploy** ticked.

Data lives in the `relay-data` volume (`/data/relay.db` plus `/data/backups`).

### Behind Nginx Proxy Manager

Add a proxy host, e.g. `api.example.com` → `http://<docker host IP>:8081`, with an SSL
certificate. Don't add one for 8080. If NPM runs in Docker on the same host, you can instead put
Relay on NPM's network (see the commented `networks` block in the compose file), forward to
`relay:8081`, and remove the 8081 port mapping.

If the hostname goes through Cloudflare, set `CLIENT_IP_HEADER=cf-connecting-ip`.

## Calling an endpoint

```sh
curl https://api.example.com/v1/fuel-kimbolton -H "X-Api-Key: rly_…"
```

The key can also go in the URL as `?key=`. Responses carry:

- `X-Relay-Fetched-At`: when the data being served was pulled.
- `X-Relay-Stale: true`: the latest pull failed, so the last good data is being served.
- `X-Relay-Warnings: <n>`: that many fields failed to compute and are `null`.
- `X-RateLimit-Limit`, `-Remaining`, `-Reset`, and `Retry-After` on a 429.

Before a source's first successful pull, its endpoints answer `503`.

## Storage

Each response body is stored gzipped, once per distinct content: a pull that returns the same
response as an earlier one only adds a small row pointing at it. Pulls older than a source's
"keep history" setting are pruned hourly. The latest good pull is always kept, because endpoints
serve from it.

## Development

Needs Node 22.13+ (for the built-in `node:sqlite`).

```sh
npm install
cp .env.example .env   # set ADMIN_PASSWORD and APP_SECRET
npm run dev            # server on :8080/:8081, UI with hot reload on http://localhost:5173
npm test
npm run typecheck
npm run build && npm start
```

Layout:

- `src/engine`: paths, shape inference, transform steps, rendering and diffing. Pure TypeScript,
  shared with the UI.
- `src/db`: SQLite schema, migrations and queries.
- `src/puller`: fetching, scheduling, alerts, pruning and backups.
- `src/admin`: the admin API on 8080.
- `src/public`: the endpoint server on 8081.
- `web`: the Svelte admin UI.

## Licence

MIT. See [LICENSE](LICENSE).
