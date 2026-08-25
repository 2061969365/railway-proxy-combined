# railway-proxy-combined

合并版 Docker：`railway-variation` (Xray VLESS+WS + Cloudflare Tunnel + 哪吒) + `opencode-free-proxy` (Claude/OpenAI → opencode.ai 代理)

> 本地 `C:\opencode-free-proxy` 原仓库不动，本仓库为独立可部署单元，通过 `app/` vendor 拷贝形式集成。

## 架构

```
Cloudflare Edge (sg.domain:443)
  ├── /ws-node  → 127.0.0.1:8080  (xray VLESS+WS)
  ├── /v1/*     → 127.0.0.1:4096  (proxy: /v1/models, /v1/messages, /v1/chat/completions)
  ├── /api/*    → 127.0.0.1:4096  (proxy dashboard API)
  └── /*       → 127.0.0.1:8081  (www 404伪装，/?mirror 面板)
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `TUNNEL_TOKEN` | ✅ | Cloudflare Tunnel token |
| `UUID` | ❌ | 覆盖固定值 `a29738e5-bee1-c0fc-b484-ae7c49cbc828` (本版默认锁定) |
| `NEZHA_SERVER` / `NEZHA_KEY` / `NEZHA_TLS` | ❌ | 哪吒探针 |
| `PORT` | ❌ | Railway 注入，自动覆盖 `config/settings.json:port` |

## 本地构建

```bash
docker build -t railway-proxy-combined:test .
docker run --rm -e TUNNEL_TOKEN=dummy -p 4096:4096 -p 8081:8081 railway-proxy-combined:test
# 另开终端
curl http://127.0.0.1:4096/api/status
curl http://127.0.0.1:4096/v1/models | head
```

## Cloudflare Tunnel 路由 (按序)

1. `sg.domain` `/ws-node` → `http://127.0.0.1:8080` (HTTP + Websockets Enabled) — 置顶
2. `sg.domain` `/v1` → `http://127.0.0.1:4096` (HTTP)
3. `sg.domain` `/api` → `http://127.0.0.1:4096` (HTTP)
4. `sg.domain` `` (空) → `http://127.0.0.1:8081` (HTTP) — 兜底

> 若面板支持 `v1*` 通配可合并 2+3；否则拆成 `v1` + `v1/*` 两条。

## Railway 部署

1. GitHub 推送后自动 `ghcr.io/<owner>/railway-proxy-combined:latest` (Actions)
2. Railway → New Service → Deploy from GitHub / Docker Image → 填 `TUNNEL_TOKEN`
3. 健康检查 `GET /api/status`

## 客户端

* VLESS: `vless://a29738e5-bee1-c0fc-b484-ae7c49cbc828@sg.domain:443?encryption=none&security=tls&type=ws&host=sg.domain&sni=sg.domain&path=%2Fws-node#Remark`
* Proxy: `ANTHROPIC_BASE_URL=https://sg.domain/v1`  `ANTHROPIC_API_KEY=sk-ant-proxy-...`
