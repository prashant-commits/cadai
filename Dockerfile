# Web app image (Next.js standalone output). The geometry service is geo/Dockerfile;
# compose.yaml runs both. Secrets come from the environment at run time, never the image.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CADAI_RUN_DIR=/data/runs \
    CADAI_DB_SINGLE_PROCESS=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Applied at startup by src/lib/db/migrate.ts (read from <cwd>/db/migrations).
COPY --from=build /app/db/migrations ./db/migrations
# Runs, objects and the PGlite database live here (a volume in compose.yaml).
RUN mkdir -p /data/runs && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# The geo service reads its token from a file; the web app reads it from CADAI_GEO_TOKEN.
CMD ["sh", "-c", "if [ -r /run/secrets/geo_token ]; then CADAI_GEO_TOKEN=\"$(cat /run/secrets/geo_token)\"; export CADAI_GEO_TOKEN; fi; exec node server.js"]
