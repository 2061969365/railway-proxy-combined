# syntax=docker/dockerfile:1
FROM teddysun/xray:latest AS xray-source
FROM cloudflare/cloudflared:latest AS cf-source
FROM node:20-alpine

RUN apk add --no-cache bash curl busybox-extras unzip

COPY --from=xray-source /usr/bin/xray /usr/bin/xray
COPY --from=cf-source /usr/local/bin/cloudflared /usr/local/bin/cloudflared

WORKDIR /app

# Install proxy deps (use cache)
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy proxy source
COPY app/server.js ./server.js
COPY app/src ./src
COPY app/public ./public
COPY app/config ./config

# Copy Xray assets
COPY config.json ./config.xray.json
COPY www ./www

# Entrypoint
COPY start.sh ./start.sh
RUN sed -i 's/\r$//' /app/start.sh && chmod +x /app/start.sh \
 && touch reasoning-cache.json debug-400.json || true

EXPOSE 4096 8080 8081

ENTRYPOINT ["/app/start.sh"]
