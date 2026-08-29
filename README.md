# railway-proxy-combined

合并版 Docker：`railway-variation` (Xray VLESS+WS + Cloudflare Tunnel + 哪吒) + `CC Switch 原生代理引擎` (Claude Code / OpenCode / OpenAI ↔ OpenCode Zen 自适应转换)

## 架构

```
Cloudflare Edge (sg.yourdomain.com:443)
  ├── /ws-node  → 127.0.0.1:8080  (xray VLESS+WS)
  ├── /v1/*     → 127.0.0.1:4096  (CC Switch AI API Proxy: /v1/messages, /v1/chat/completions, /v1/responses)
  └── /*       → 127.0.0.1:8081  (三体伪装页，/?mirror 面板)
```

## 核心特性

- **100% CC Switch 工业级协议转换引擎**：原生内置 Tool Calling（工具调用）、Thinking 思考流保护、SSE 流式事件处理。
- **模型级智能多格式分流**：
  - 请求 `muse-spark-1.2-contributor-free` ➔ 自动动态走 `openai_responses` (`/v1/responses`) 协议。
  - 请求 `mimo-v2.5-free` / `hy3-free` / `ling-3.0-flash-fin-free` ➔ 自动动态走 `openai_chat` (`/v1/chat/completions`) 协议。
  - 请求 Claude 原生模型 ➔ 自动走 `anthropic` (`/v1/messages`) 协议。
- **超轻量化容器**：移除 Node.js 运行时，改用纯 Rust 原生二进制，内存占用低至 30MB。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `TUNNEL_TOKEN` | ✅ | Cloudflare Tunnel token |
| `UUID` | ❌ | 可覆盖，默认 `a29738e5-bee1-c0fc-b484-ae7c49cbc828` (`start.sh:5` `${UUID:-fixed}`) |
| `NEZHA_SERVER` / `NEZHA_KEY` / `NEZHA_TLS` | ❌ | 哪吒探针 |
| `PORT` | ❌ | Railway 注入但被忽略；proxy 固定 `4096`，`start.sh` 通过 `socat` 将 `$PORT` 转发至 `4096` 兼容健康检查。建议 `PORT=3000` |

## Cloudflare Tunnel 路由配置

1. `sg.yourdomain.com` `/ws-node` → `http://127.0.0.1:8080` (HTTP + Websockets Enabled) — 置顶
2. `sg.yourdomain.com` `/v1` → `http://127.0.0.1:4096` (HTTP) — 前缀匹配，覆盖 `/v1/*`
3. `sg.yourdomain.com` `` (空) → `http://127.0.0.1:8081` (HTTP) — 兜底

## 客户端配置

* **Claude Code / OpenCode**:
  ```bash
  export ANTHROPIC_BASE_URL="https://sg.yourdomain.com/v1"
  export ANTHROPIC_AUTH_TOKEN="not-needed"
  ```
* **VLESS 节点**:
  `vless://a29738e5-bee1-c0fc-b484-ae7c49cbc828@sg.yourdomain.com:443?encryption=none&security=tls&type=ws&host=sg.yourdomain.com&sni=sg.yourdomain.com&path=%2Fws-node#Remark`
