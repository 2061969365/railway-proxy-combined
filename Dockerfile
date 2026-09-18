# syntax=docker/dockerfile:1
FROM teddysun/xray:latest AS xray-source
FROM cloudflare/cloudflared:latest AS cf-source
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl busybox unzip socat ca-certificates libssl3 net-tools \
    libgtk-3-0t64 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 librsvg2-2 \
    && busybox --install -s /usr/local/bin \
    && rm -rf /var/lib/apt/lists/*

# shim 探针：opencode 子进程（官方身份借道）。Node 22 + 全局 opencode。
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g opencode \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && node --version && opencode --version

# shim 并发压到 1（单 opencode 进程常驻 0.5~1.8GB，探针先保活再谈吞吐）
ENV SHIM_CONCURRENCY=1

COPY --from=xray-source /usr/bin/xray /usr/bin/xray
COPY --from=cf-source /usr/local/bin/cloudflared /usr/local/bin/cloudflared

WORKDIR /app

# Copy CC Switch native proxy binary
COPY cc-switch-server /usr/local/bin/cc-switch-server

# Copy Xray & disguise assets
COPY config.json ./config.xray.json
COPY www ./www
COPY start.sh ./start.sh

# shim 探针：opencode 配置（test provider 自环 127.0.0.1:4096）
COPY opencode.json /root/.config/opencode/opencode.json

RUN sed -i 's/\r$//' /app/start.sh \
 && chmod +x /app/start.sh /usr/local/bin/cc-switch-server

# Ports:
# 4096: CC Switch AI API Proxy (Claude / OpenAI native format converter)
# 8080: Xray VLESS Websocket
# 8081: httpd static disguise page
EXPOSE 4096 8080 8081

ENTRYPOINT ["/app/start.sh"]
