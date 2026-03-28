#!/bin/bash
# Sync morph code to Docker and restart relay
set -e

DOCKER_WS="/Users/michaelyang/docker-claude-workspace/morph"
SRC="/Users/michaelyang/Documents/Workspace/morph"

echo "[sync] Copying relay/claude.js → Docker..."
cp "$SRC/relay/claude.js" "$DOCKER_WS/relay/claude.js"

echo "[sync] Restarting Docker relay..."
docker exec claude-sandbox bash -c '
  PID=$(fuser 3001/tcp 2>/dev/null | tr -d " ")
  kill $PID 2>/dev/null
  sleep 2
  cd /workspace/morph/relay && nohup node index.js > /tmp/relay.log 2>&1 &
  sleep 2
  tail -3 /tmp/relay.log
'

echo "[sync] Done."
