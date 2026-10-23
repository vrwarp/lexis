# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Keep optional deps: that is how the Claude Agent SDK ships its native binary.
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build \
 && npm prune --omit=dev \
 && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-*-musl

# ---------- runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    LEXIS_DATA_DIR=/data \
    CLAUDE_CONFIG_DIR=/data/claude
# The pipeline's agents shell out to zip/unzip (extract and package the EPUB),
# grep (stray-phrase scans) and git (workspace versioning).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git zip unzip \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1001 lexis \
 && mkdir -p /data && chown lexis:lexis /data
WORKDIR /app
COPY --from=build --chown=lexis:lexis /app/package.json ./
COPY --from=build --chown=lexis:lexis /app/node_modules ./node_modules
COPY --from=build --chown=lexis:lexis /app/dist ./dist
COPY --chown=lexis:lexis agents/ ./agents/
COPY --chown=lexis:lexis public/ ./public/
# The Agent SDK ships the Claude Code binary in a per-platform package. Link it
# onto the PATH (so `docker compose exec lexis claude auth login` also works)
# and prove it launches on this platform.
RUN set -eu; \
  binary="$(find /app/node_modules/@anthropic-ai -maxdepth 2 \
    \( -type d -name '*-musl' -prune \) -o \( -type f -name claude -perm -u+x -print \) | head -n1)"; \
  test -n "$binary"; \
  "$binary" --version; \
  ln -sf "$binary" /usr/local/bin/claude; \
  mkdir -p /data/claude && chown -R lexis:lexis /data
# Agents run with permissions bypassed, which Claude Code refuses to do as root.
USER lexis
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
