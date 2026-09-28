# bookworm-slim (glibc). Node 24: node:sqlite is built in and
# unflagged, so there's no native SQLite module to compile.
FROM node:24-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY scripts ./scripts
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    ADMIN_PORT=8080 \
    PUBLIC_PORT=8081

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# The database and nightly backups live here. Owned by the unprivileged node user so a fresh named
# volume inherits the right permissions.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

# 8080: admin UI (keep it on the LAN). 8081: the re-served endpoints (point the proxy here).
EXPOSE 8080 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PUBLIC_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
