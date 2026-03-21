#!/usr/bin/env bash
# TR Relay — one-click deploy on Mac
# Usage: cd morph/relay && bash deploy-tr.sh
set -euo pipefail

RELAY_DIR="$(cd "$(dirname "$0")" && pwd)"
DOMAIN="tr.mkyang.ai"
TUNNEL_NAME="tr-relay"
PORT=3001

echo "=== TR Relay Deploy ==="
echo "Dir: $RELAY_DIR"

# 1. Install deps
echo "[1/5] npm install..."
cd "$RELAY_DIR" && npm install --quiet 2>/dev/null

# 2. Create .env if missing
if [ ! -f "$RELAY_DIR/.env" ]; then
  cat > "$RELAY_DIR/.env" << 'EOF'
PORT=3001
JWT_SECRET=morph-relay-secret-2026
STATIC_TOKEN=morph-tensor-2026
DB_PATH=./data/relay.db
ALLOWED_ACCOUNTS=cmlfo4dakkaj31w14k0cew5ru,static-user
DEFAULT_CWD=/Users/michaelyang/Documents/Tensor_revive
ANTHROPIC_API_KEY=YOUR_KEY_HERE
EOF
  echo "  Created .env — fill in ANTHROPIC_API_KEY then re-run."
  exit 1
fi

if grep -q "YOUR_KEY_HERE" "$RELAY_DIR/.env" 2>/dev/null; then
  echo "  Set ANTHROPIC_API_KEY in .env first."
  exit 1
fi

# 3. Cloudflared named tunnel
echo "[2/5] Cloudflared tunnel..."
if ! cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  cloudflared tunnel create "$TUNNEL_NAME"
  cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN"
  echo "  Tunnel created and DNS routed to $DOMAIN"
else
  echo "  Tunnel '$TUNNEL_NAME' already exists"
fi

TUNNEL_ID=$(cloudflared tunnel info "$TUNNEL_NAME" 2>/dev/null | grep "^ID" | awk '{print $NF}')
if [ -z "$TUNNEL_ID" ]; then
  TUNNEL_ID=$(cloudflared tunnel list --output json 2>/dev/null | \
    python3 -c "import sys,json; ts=[t['id'] for t in json.load(sys.stdin) if t.get('Name','')=='$TUNNEL_NAME']; print(ts[0] if ts else '')" 2>/dev/null || echo "")
fi

if [ -z "$TUNNEL_ID" ]; then
  echo "  ERROR: could not get tunnel ID. Run: cloudflared tunnel list"
  exit 1
fi

mkdir -p ~/.cloudflared
cat > ~/.cloudflared/tr-relay.yml << EOF
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json
ingress:
  - hostname: $DOMAIN
    service: http://localhost:$PORT
  - service: http_status:404
EOF
echo "  Config: ~/.cloudflared/tr-relay.yml"

# 4. PM2 ecosystem
echo "[3/5] PM2 ecosystem..."
cat > "$RELAY_DIR/ecosystem.config.cjs" << EOF
module.exports = {
  apps: [
    {
      name: 'tr-relay',
      script: 'index.js',
      cwd: '$RELAY_DIR',
      restart_delay: 3000,
      max_restarts: 20,
      watch: false,
    },
    {
      name: 'tr-tunnel',
      script: 'cloudflared',
      args: 'tunnel --config $HOME/.cloudflared/tr-relay.yml run',
      interpreter: 'none',
      restart_delay: 5000,
      max_restarts: 50,
    }
  ]
}
EOF

# 5. Start / restart PM2
echo "[4/5] PM2 start..."
if pm2 list 2>/dev/null | grep -q "tr-relay"; then
  pm2 restart tr-relay tr-tunnel
else
  pm2 start "$RELAY_DIR/ecosystem.config.cjs"
fi
pm2 save
pm2 startup 2>/dev/null | tail -1 || true

# 6. Health check
echo "[5/5] Health check..."
sleep 3
if curl -sf "http://localhost:$PORT/health" > /dev/null; then
  echo ""
  echo "✅ TR relay live"
  echo "   Local:  http://localhost:$PORT"
  echo "   Public: https://$DOMAIN"
  echo ""
  echo "   pm2 status        — process status"
  echo "   pm2 logs tr-relay — live logs"
else
  echo "❌ Relay not responding. Check: pm2 logs tr-relay"
  exit 1
fi
