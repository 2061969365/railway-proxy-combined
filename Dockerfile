# syntax=docker/dockerfile:1
FROM teddysun/xray:latest AS xray-source
FROM cloudflare/cloudflared:latest AS cf-source
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl busybox unzip socat ca-certificates libssl3 net-tools \
    && rm -rf /var/lib/apt/lists/*

COPY --from=xray-source /usr/bin/xray /usr/bin/xray
COPY --from=cf-source /usr/local/bin/cloudflared /usr/local/bin/cloudflared

WORKDIR /app

# Copy CC Switch native proxy binary
COPY cc-switch-server /usr/local/bin/cc-switch-server

# Copy Xray & disguise assets
COPY config.json ./config.xray.json
COPY www ./www
COPY start.sh ./start.sh

RUN sed -i 's/\r$//' /app/start.sh \
 && chmod +x /app/start.sh /usr/local/bin/cc-switch-server

# Ports:
# 4096: CC Switch AI API Proxy (Claude / OpenAI native format converter)
# 8080: Xray VLESS Websocket
# 8081: httpd static disguise page
EXPOSE 4096 8080 8081

ENTRYPOINT ["/app/start.sh"]
