# Production build for the self-hosted Dub app (pnpm/turbo monorepo).
# Build context = repo root. Heavy build — give the VM adequate RAM/swap.
FROM node:22-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# Install deps (whole repo — monorepo workspace resolution)
COPY . .
RUN pnpm install --frozen-lockfile

# Build workspace packages (required: @dub/utils etc. export from dist/)
RUN pnpm build:packages

# Prisma client + Next build. Provide throwaway build-time env so codegen and
# static analysis don't fail on missing vars; real values come at runtime.
ENV NODE_OPTIONS=--max-old-space-size=8192 \
    SKIP_ENV_VALIDATION=1 \
    DATABASE_URL="mysql://root:@localhost:3306/planetscale" \
    NEXTAUTH_SECRET="build-time-placeholder-secret-build-time-placeholder" \
    # Dummy, non-empty Stripe keys so module-scope `new Stripe(...)` (e.g. the
    # importer crons calling stripeAppClient()) don't throw during next build's
    # page-data collection. Real keys are injected at runtime via Dokploy env.
    STRIPE_SECRET_KEY="sk_test_dummy_build_only" \
    STRIPE_APP_SECRET_KEY="sk_test_dummy_build_only"
RUN cd apps/web \
  && pnpm exec prisma generate --schema=./prisma/schema \
  && pnpm exec next build

EXPOSE 8888
WORKDIR /app/apps/web
# On start: sync the Prisma schema to MySQL (idempotent) then boot Next.
CMD ["sh", "-c", "pnpm exec prisma db push --schema=./prisma/schema --skip-generate --accept-data-loss && pnpm exec next start -p 8888 -H 0.0.0.0"]
