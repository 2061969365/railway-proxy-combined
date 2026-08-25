#!/bin/bash
set -e

# === 1. 固定 UUID (保留 railway-variation 锁定值) ===
export UUID="a29738e5-bee1-c0fc-b484-ae7c49cbc828"
echo "[init] UUID 锁定为: $UUID"

# === 2. 动态 IP/归属地探测 ===
echo "[init] 探测 Railway 出口 IP..."
REAL_IP=$(curl -s --max-time 3 ifconfig.me || true)
REAL_COUNTRY=$(curl -s --max-time 3 ipinfo.io/country || true)
[ -z "$REAL_IP" ] && REAL_IP="DynamicIP"
[ -z "$REAL_COUNTRY" ] && REAL_COUNTRY="Cloud"
NODE_REMARK="${REAL_COUNTRY}_${REAL_IP}"
echo "[init] 节点标识: $NODE_REMARK"

# 注入 UUID/remark 到 Xray 配置和伪装页 (使用临时副本避免污染镜像层)
cp /app/config.xray.json /tmp/xray.json
cp /app/www/index.html /tmp/index.html 2>/dev/null || true
sed -i "s/UUID_PLACEHOLDER/$UUID/g" /tmp/xray.json
if [ -f /tmp/index.html ]; then
  sed -i "s/UUID_PLACEHOLDER/$UUID/g" /tmp/index.html
  sed -i "s/NODE_REMARK_PLACEHOLDER/$NODE_REMARK/g" /tmp/index.html
  cp /tmp/index.html /app/www/index.html
fi

# === 3. 兼容 Proxy 配置 (host/notify) - 保持 4096 固定，不跟随 Railway PORT ===
node -e "
const fs=require('fs');
const p='/app/config/settings.json';
try{
  const j=JSON.parse(fs.readFileSync(p,'utf8'));
  let ch=false;
  if(j.host==='127.0.0.1'){ j.host='0.0.0.0'; ch=true; console.log('[proxy] host 127.0.0.1 -> 0.0.0.0'); }
  if(j.notify && (j.notify.enabled!==false || (j.notify.exe && j.notify.exe!==''))){
    j.notify.enabled=false; j.notify.exe=''; ch=true; console.log('[proxy] notify 已禁用 (容器环境)');
  }
  // 强制保持 4096，避免 Railway PORT 覆盖导致 Tunnel 502
  if(j.port!==4096){
    console.log('[proxy] 强制 port 4096 (原 '+j.port+' -> 4096)，忽略 Railway PORT='+ (process.env.PORT||'<empty>'));
    j.port=4096; ch=true;
  }
  if(ch) fs.writeFileSync(p, JSON.stringify(j,null,2));
}catch(e){ console.log('[proxy] settings patch 跳过:', e.message); }
"

# === 4. 启动各服务 ===
echo "[init] 启动 busybox httpd (8081)..."
httpd -p 8081 -h /app/www &
HTTP_PID=$!

echo "[init] 启动 Xray (8080)..."
/usr/bin/xray -config /tmp/xray.json &
XRAY_PID=$!

echo "[init] 启动 opencode-free-proxy (固定 4096)..."
# 启动并捕获日志
node --use-env-proxy server.js > /tmp/proxy.log 2>&1 &
PROXY_PID=$!
echo "[init] proxy PID=$PROXY_PID"
# 等待 proxy 就绪，最多 30s
for i in $(seq 1 15); do
  sleep 2
  if curl -s --max-time 3 http://127.0.0.1:4096/api/status >/dev/null 2>&1; then
    echo "[debug] proxy 就绪 (尝试 $i)"
    curl -s http://127.0.0.1:4096/api/status | head -c 500
    echo ""
    break
  else
    echo "[debug] 等待 proxy... ($i/15) pid $PROXY_PID alive? $(kill -0 $PROXY_PID 2>&1 && echo yes || echo no)"
    if ! kill -0 $PROXY_PID 2>/dev/null; then
      echo "[ERR] proxy 进程已退出，日志："
      cat /tmp/proxy.log 2>&1 || true
      echo "[ERR] netstat:"
      netstat -tln 2>&1 || ss -tln 2>&1 || true
      break
    fi
  fi
  if [ $i -eq 15 ]; then
    echo "[ERR] proxy 15次仍未就绪，最后日志："
    cat /tmp/proxy.log 2>&1 || true
    netstat -tln 2>&1 || ss -tln 2>&1 || true
  fi
done
echo "[debug] netstat after proxy start:"
netstat -tln 2>&1 || ss -tln 2>&1 || true
echo "[debug] cat settings.json:"
cat /app/config/settings.json 2>&1
echo "[debug] proxy log head:"
head -n 50 /tmp/proxy.log 2>&1 || true
# 若 Railway 注入 PORT 且不等于 4096，额外起一个 socat 转发以兼容 Railway 健康检查 (可选)
if [ -n "${PORT:-}" ] && [ "$PORT" != "4096" ]; then
  echo "[proxy] 检测到 Railway PORT=$PORT，额外监听该端口供平台健康检查"
  # 用 socat 或 nc 转发 PORT -> 4096 (alpine 无 socat 时用 busybox httpd 替代方案：忽略)
  if command -v socat >/dev/null 2>&1; then
    socat TCP-LISTEN:$PORT,fork TCP:127.0.0.1:4096 &
    echo "[proxy] socat 转发 $PORT -> 4096 已启动"
  else
    echo "[proxy] 未安装 socat，跳过 PORT 转发 (不影响 Tunnel)"
  fi
fi

# === 5. 哪吒探针 (可选) ===
NEZHA_PATH="/app/nezha-agent"
if [ ! -f "$NEZHA_PATH" ]; then
  echo "[nezha] 拉取 agent..."
  curl -sL -o /tmp/nezha-agent.zip "https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_amd64.zip" && \
    unzip -o /tmp/nezha-agent.zip -d /app/ && \
    chmod +x "$NEZHA_PATH" && \
    rm -f /tmp/nezha-agent.zip || echo "[nezha] 下载失败，跳过"
fi
if [ -f "$NEZHA_PATH" ] && [ -n "${NEZHA_SERVER:-}" ] && [ -n "${NEZHA_KEY:-}" ]; then
  cat > /app/nezha-config.yml <<EOF
client_secret: ${NEZHA_KEY}
server: ${NEZHA_SERVER}
tls: ${NEZHA_TLS:-true}
debug: false
disable_auto_update: true
disable_command_execute: true
report_delay: 3
EOF
  $NEZHA_PATH -c /app/nezha-config.yml &
  echo "[nezha] 已启动"
fi

# === 6. Cloudflare Tunnel ===
if [ -z "${TUNNEL_TOKEN:-}" ]; then
  echo "❌ TUNNEL_TOKEN 未设置，隧道无法建立！"
  exit 1
fi
echo "[tunnel] 通过 QUIC 建立隧道..."
/usr/local/bin/cloudflared tunnel --protocol quic --no-autoupdate run --token "$TUNNEL_TOKEN" > /tmp/cf.log 2>&1 &
CF_PID=$!
sleep 5
echo "[debug] cloudflared started PID=$CF_PID"
cat /tmp/cf.log 2>&1 | head -n 30 || true
echo "[debug] curl after cf start:"
curl -s --max-time 5 http://127.0.0.1:4096/api/status && echo " [tunnel debug] proxy still ok after cloudflared start" || echo " [tunnel debug] proxy unreachable after cloudflared start (proxy log):" && cat /tmp/proxy.log 2>&1 | head -n 30 || true

# === 7. 健康监控 (15s) - 仅监控关键端口，不过度敏感 ===
echo "[monitor] 进入健康监控循环..."
while true; do
  sleep 15
  PROXY_PORT=4096

  netstat -tln 2>/dev/null | grep -q :8080; VLESS_OK=$?
  netstat -tln 2>/dev/null | grep -q :8081; HTTP_OK=$?
  netstat -tln 2>/dev/null | grep -q :$PROXY_PORT; PROXY_OK=$?
  pidof cloudflared >/dev/null 2>&1; CF_OK=$?
  # 进程存活检查放宽：只要端口在即可，不强制 kill -0
  if [ $VLESS_OK -ne 0 ] || [ $HTTP_OK -ne 0 ] || [ $PROXY_OK -ne 0 ] || [ $CF_OK -ne 0 ]; then
    echo "🚨 断流警报 VLESS:$VLESS_OK HTTP:$HTTP_OK PROXY:$PROXY_OK CF:$CF_OK"
    # 不立即 exit 1，等待 30s 再试一次，避免瞬时抖动导致 Railway 重启风暴
    sleep 30
    netstat -tln 2>/dev/null | grep -q :$PROXY_PORT; PROXY_OK=$?
    pidof cloudflared >/dev/null 2>&1; CF_OK=$?
    if [ $PROXY_OK -ne 0 ] || [ $CF_OK -ne 0 ]; then
      echo "🚨 二次确认失败，退出触发重启"
      exit 1
    else
      echo "[monitor] 二次确认恢复，继续运行"
    fi
  fi
done
