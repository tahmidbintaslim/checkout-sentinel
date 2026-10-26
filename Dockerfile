# syntax=docker/dockerfile:1.7
# One Dockerfile, two targets:
#   docker build --target api    -t checkout-sentinel-api .     (API and the built dashboard)
#   docker build --target worker -t checkout-sentinel-worker .

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV CI=true
RUN npm install --global pnpm@11.15.1
WORKDIR /repo

# ---- build: install the whole workspace, compile, then prune to production bundles ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/jobs/package.json packages/jobs/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY test/fixtures/package.json test/fixtures/
# Browsers are installed in the worker image below, matched to the locked Playwright version.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY test test
RUN pnpm build
# --legacy: deploy without injectWorkspacePackages, which would change local dev linking.
RUN pnpm deploy --legacy --filter @checkout-sentinel/api --prod /out/api \
 && pnpm deploy --legacy --filter @checkout-sentinel/worker --prod /out/worker \
 && cp -r apps/web/dist /out/api/web

# ---- api ----
FROM ${NODE_IMAGE} AS api
# The dashboard is static files served by the API at /. Artifacts are read from the volume the
# workers write to (mounted read-only in docker-compose.yml).
ENV NODE_ENV=production PORT=3000 DASHBOARD_DIR=/app/web ARTIFACTS_DIR=/data/artifacts
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
# Owned by node like the worker's, so the shared volume is writable for workers whichever
# container creates it first.
RUN mkdir -p /data/artifacts && chown node:node /data/artifacts
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ---- worker: same Node base plus Chromium and its system libraries ----
FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright METRICS_PORT=9465 ARTIFACTS_DIR=/data/artifacts
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
# Uses the Playwright CLI from the deployed node_modules, so the browser build always matches
# the library version in pnpm-lock.yaml.
RUN node node_modules/playwright/cli.js install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/artifacts && chown -R node:node /data /ms-playwright
USER node
EXPOSE 9465
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.METRICS_PORT||9465)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
