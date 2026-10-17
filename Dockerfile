FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node bin/ ./bin/
COPY --chown=node:node src/ ./src/
COPY --chown=node:node web/ ./web/
COPY --chown=node:node .agents/skills/browser-use/ ./.agents/skills/browser-use/

ENV NODE_ENV=production \
    COKE_HOST=0.0.0.0 \
    COKE_PORT=3210 \
    COKE_CHROMIUM_PATH=/usr/bin/chromium \
    COKE_BROWSER_HEADLESS=1 \
    COKE_DATA_DIR=/data \
    COKE_AUTH_FILE=/data/auth.json \
    COKE_PROFILE_ROOT=/data/profiles
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 3210
CMD ["node", "bin/server.mjs"]
