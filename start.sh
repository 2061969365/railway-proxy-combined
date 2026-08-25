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

# === 3. 兼容 Proxy 配置 (host/notify + Railway PORT) ===
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
  const portEnv=process.env.PORT;
  if(portEnv && Number(portEnv)!==j.port){
    console.log('[proxy] Railway PORT='+portEnv+' 覆盖 settings.port '+j.port+' -> '+portEnv);
    j.port=Number(portEnv); ch=true;
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

echo "[init] 启动 opencode-free-proxy (4096 or \$PORT)..."
node --use-env-proxy server.js &
PROXY_PID=$!
echo "[init] proxy PID=$PROXY_PID"

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
/usr/local/bin/cloudflared tunnel --protocol quic --no-autoupdate run --token "$TUNNEL_TOKEN" &
CF_PID=$!

# === 7. 健康监控 (15s) ===
echo "[monitor] 进入健康监控循环..."
while true; do
  sleep 15
  # 获取实际 proxy 端口
  PROXY_PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('/app/config/settings.json','utf8')).port)}catch(e){console.log(4096)}" 2>/dev/null || echo 4096)

  netstat -tln 2>/dev/null | grep -q :8080; VLESS_OK=$?
  netstat -tln 2>/dev/null | grep -q :8081; HTTP_OK=$?
  netstat -tln 2>/dev/null | grep -q :$PROXY_PORT; PROXY_OK=$?
  pidof cloudflared >/dev/null 2>&1; CF_OK=$?
  kill -0 $XRAY_PID 2>/dev/null; XRAY_ALIVE=$?
  kill -0 $PROXY_PID 2>/dev/null; PROXY_ALIVE=$?

  if [ $VLESS_OK -ne 0 ] || [ $HTTP_OK -ne 0 ] || [ $PROXY_OK -ne 0 ] || [ $CF_OK -ne 0 ] || [ $XRAY_ALIVE -ne 0 ] || [ $PROXY_ALIVE -ne 0 ]; then
    echo "🚨 断流警报 VLESS:$VLESS_OK HTTP:$HTTP_OK PROXY:$PROXY_OK/$PROXY_ALIVE CF:$CF_OK XRAY:$XRAY_ALIVE"
    exit 1
  fi
done
