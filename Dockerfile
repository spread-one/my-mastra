FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
ARG VCS_REF
ARG SOURCE_URL=https://github.com/spread-one/my-mastra
LABEL org.opencontainers.image.source=$SOURCE_URL \
      org.opencontainers.image.revision=$VCS_REF
ENV NODE_ENV=production SLACK_HEALTH_FILE=/run/my-mastra/health.json
WORKDIR /app
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
HEALTHCHECK --interval=5s --timeout=3s --start-period=35s --retries=3 CMD ["node", "dist/slack/health-check.js"]
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "dist/slack.js"]
