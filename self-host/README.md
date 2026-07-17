# Self-Hosting Dub (ShipFast fork)

Runs the full Dub app — **including the Partners / conversions EE features** — against
self-hosted equivalents of the services Dub normally assumes (PlanetScale, Upstash,
Tinybird, Resend, S3). For **development/testing** per the EE license in
`apps/web/app/(ee)/LICENSE.md`; production use requires a Dub Enterprise license.

## Service map

| Dub dependency | Self-hosted replacement | Port |
|---|---|---|
| PlanetScale (MySQL) | `mysql:8` + `ps-http-sim` proxy | 3306 / 3900 |
| Upstash Redis | `redis` + `serverless-redis-http` (Upstash REST shim) | 6379 / 8079 |
| Resend | Mailhog (SMTP + UI) | 1025 / 8025 |
| AWS S3 / R2 | MinIO (+ auto-created buckets) | 9002 / 9003 |
| Upstash QStash | _shim TBD_ | — |
| Tinybird (Clickhouse) | _shim TBD_ | — |

## Quick start (local)

```bash
# 1. Runtime (colima or Docker Desktop). On a flaky network, colima's image fetch
#    may stall — download the image manually and boot with --disk-image.
colima start --cpu 4 --memory 6 --disk 60

# 2. Backing services
docker compose -f self-host/docker-compose.dev.yml up -d

# 3. App deps + workspace packages (REQUIRED before next dev, or middleware
#    fails to resolve @dub/utils — its `main` points at an unbuilt dist/)
pnpm install
pnpm build:packages

# 4. Env — copy the template and fill throwaway local secrets
cp self-host/.env.selfhost.example apps/web/.env
#   generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 5. Schema -> MySQL (creates all 82 tables incl. Partner/Program/Commission/Payout)
cd apps/web && pnpm prisma:push

# 6. Run
pnpm dev            # http://localhost:8888  (/ -> /login)
```

## Auth (local, no real email needed)

Dub logs the magic link to the dev console. Trigger sign-in, then grab the printed
`/api/auth/callback/email?...token=...` URL from the `pnpm dev` output and open it.

## Status

- ✅ Full stack boots; app serves; auth (magic link) + workspace creation work.
- ⏳ Partners conversion tracking needs the Tinybird shim; payouts need Stripe
  Connect / PayPal. See the plan for remaining phases.
