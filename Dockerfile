# Build in CI, then deploy the resulting image by digest. No runtime source fetch.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 nudge && useradd --uid 10001 --gid nudge --no-create-home nudge
ARG NUDGE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/mike1ros-gh/nudge1" \
      org.opencontainers.image.revision="${NUDGE_REVISION}"

FROM runtime AS web
COPY --from=build --chown=nudge:nudge /app/.next/standalone ./
COPY --from=build --chown=nudge:nudge /app/.next/static ./.next/static
COPY --from=build --chown=nudge:nudge /app/public ./public
USER nudge
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "server.js"]

# The worker and migration tools need the generated Prisma client, TypeScript
# sources and tsx/Prisma runtime. Do not prune devDependencies from these targets.
FROM runtime AS worker
COPY --from=build --chown=nudge:nudge /app/node_modules ./node_modules
COPY --from=build --chown=nudge:nudge /app/package.json /app/tsconfig.json ./
COPY --from=build --chown=nudge:nudge /app/app/generated ./app/generated
COPY --from=build --chown=nudge:nudge /app/lib ./lib
COPY --from=build --chown=nudge:nudge /app/worker ./worker
COPY --from=build --chown=nudge:nudge /app/deploy/cron.mjs ./deploy/cron.mjs
USER nudge
CMD ["node_modules/.bin/tsx", "worker/dm-worker.ts"]

FROM worker AS migrate
COPY --from=build --chown=nudge:nudge /app/prisma ./prisma
COPY --from=build --chown=nudge:nudge /app/prisma.config.ts ./prisma.config.ts
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]
