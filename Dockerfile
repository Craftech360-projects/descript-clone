# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build the web UI.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS web
WORKDIR /app

# Manifests before source: this layer re-runs only when a dependency changes,
# so editing a component does not reinstall the world.
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/server/package.json ./apps/server/
COPY packages/core/package.json ./packages/core/
RUN npm ci

COPY packages/core ./packages/core
COPY apps/web ./apps/web
RUN npm run build --workspace apps/web

# ---------------------------------------------------------------------------
# Stage 2 — production dependencies, resolved without the build toolchain.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/server/package.json ./apps/server/
COPY packages/core/package.json ./packages/core/
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Stage 3 — runtime.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim

# ffmpeg     — every import and render shells out to it. Without it the app
#              boots happily and fails on first use with spawn ENOENT.
# fonts + fontconfig
#            — the burned-caption style asks for "Arial", which does not exist
#              on Debian. Liberation Sans is metric-compatible and fontconfig
#              substitutes it, so captions keep their intended size. With no
#              fonts at all libass renders nothing and the burn silently no-ops.
#              IMPORTED fonts take a different path: libass loads them straight
#              from the media/fonts dir (passed as the burn's fontsdir), and
#              FreeType reads TTF/OTF/WOFF unconditionally and WOFF2 via brotli —
#              which bookworm's libfreetype ships with, so an imported WOFF2 burns
#              here. A FreeType built WITHOUT brotli would fall back on WOFF2.
# tini       — node as PID 1 does not reap exited children, and this process
#              spawns an ffmpeg per render.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-liberation \
      fontconfig \
      tini \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core ./packages/core
COPY apps/server ./apps/server
COPY --from=web /app/apps/web/dist ./apps/web/dist

# Node 24 runs the TypeScript sources directly (type stripping), so the server
# needs no build step — the .ts files above are the artifact.
ENV NODE_ENV=production \
    PORT=8787 \
    MEDIA_DIR=/data \
    # Projects, jobs, folder memories: NOT web-served, so not under MEDIA_DIR.
    # Inside the /data volume so one mount still holds everything — without
    # this they land in an image layer and are lost on every rebuild.
    DATA_DIR=/data/state \
    # The server now binds loopback by default. A container that did that
    # would be unreachable through -p while its own HEALTHCHECK, which curls
    # 127.0.0.1 from INSIDE, stayed green. Publishing a port is an explicit
    # decision, so state it explicitly.
    HOST=0.0.0.0 \
    WEB_DIST=./apps/web/dist

# Uploads, renders and project JSON are state: they belong on a volume, not in
# a container layer that vanishes on the next deploy.
RUN mkdir -p /data/uploads /data/renders /data/projects && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8787

# Reports unhealthy when ffmpeg is missing, so a broken image never takes traffic.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/src/index.ts"]
