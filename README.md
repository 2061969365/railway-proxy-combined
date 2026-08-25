# railway-proxy-combined

合并版 Docker：`railway-variation` (Xray VLESS+WS + Cloudflare Tunnel + 哪吒) + `opencode-free-proxy` (Claude/OpenAI → opencode.ai 代理)

> 本地 `C:\opencode-free-proxy` 原仓库不动，本仓库为独立可部署单元，通过 `app/` vendor 拷贝形式集成。

## 架构

```
Cloudflare Edge (sg.yourdomain.com:443)
  ├── /ws-node  → 127.0.0.1:8080  (xray VLESS+WS)
  ├── /v1/*     → 127.0.0.1:4096  (proxy: /v1/models, /v1/messages, /v1/chat/completions)
  ├── /api/*    → 127.0.0.1:4096  (proxy dashboard API)
  └── /*       → 127.0.0.1:8081  (三体伪装页，/?mirror 面板)
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `TUNNEL_TOKEN` | ✅ | Cloudflare Tunnel token |
| `UUID` | ❌ | 可覆盖，默认 `a29738e5-bee1-c0fc-b484-ae7c49cbc828` (`start.sh:5` `${UUID:-fixed}`) |
| `NEZHA_SERVER` / `NEZHA_KEY` / `NEZHA_TLS` | ❌ | 哪吒探针 |
| `PORT` | ❌ | Railway 注入但被忽略；proxy 固定 `4096`，`start.sh` 通过 `socat` 将 `$PORT` 转发至 `4096` 兼容健康检查。**切勿设为 `8080`/`8081`（与 Xray/httpd 冲突），建议 `PORT=3000`** |

## 本地构建

```bash
docker build -t railway-proxy-combined:test .
docker run --rm -e TUNNEL_TOKEN=dummy -p 4096:4096 -p 8081:8081 railway-proxy-combined:test
# 另开终端
curl http://127.0.0.1:4096/api/status
curl http://127.0.0.1:4096/v1/models | head
```

## Cloudflare Tunnel 路由 (按序)

1. `sg.yourdomain.com` `/ws-node` → `http://127.0.0.1:8080` (HTTP + Websockets Enabled) — 置顶
2. `sg.yourdomain.com` `/v1` → `http://127.0.0.1:4096` (HTTP) — 前缀匹配，覆盖 `/v1/*`
3. `sg.yourdomain.com` `/api` → `http://127.0.0.1:4096` (HTTP) — 前缀匹配，覆盖 `/api/*`
4. `sg.yourdomain.com` `` (空) → `http://127.0.0.1:8081` (HTTP) — 兜底

> 仅第 1 条需开 Websockets；2/3 已是前缀匹配，无需 `v1*` 通配。

伪装页：`https://sg.yourdomain.com/` 显示《三体·地球往事》深度解读站，`https://sg.yourdomain.com/?mirror` 显示节点订阅面板。

## Railway 部署

1. GitHub 推送后自动 `ghcr.io/2061969365/railway-proxy-combined:latest` + `:main` (Actions, 已去 `sha` 抖动，**镜像名固定 `latest`**，需在 GitHub Packages 将包设为 Public) — 在 Railway 固定使用 `...:latest` 即可，不会再变
2. Railway → New Service → Deploy from GitHub / Docker Image → 填 `TUNNEL_TOKEN`，**Variables 设 `PORT=3000`**（避开 8080/8081）
3. 健康检查 `GET /api/status` (`railway.json` 已配置，`socat` 将 `$PORT` 转发至 `4096`)

## 客户端

* VLESS: `vless://a29738e5-bee1-c0fc-b484-ae7c49cbc828@sg.yourdomain.com:443?encryption=none&security=tls&type=ws&host=sg.yourdomain.com&sni=sg.yourdomain.com&path=%2Fws-node#Remark`
* Proxy: `ANTHROPIC_BASE_URL=https://sg.yourdomain.com/v1`  `ANTHROPIC_API_KEY=sk-ant-proxy-...`
