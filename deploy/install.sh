#!/bin/sh
# Build the client and (re)start HermesCity under systemd, sandboxed. Idempotent. Run as root after setup.sh passes.
# Settings (environment, all optional): APP_DIR APP_USER SERVICE DB_NAME STATE_DIR ENV_FILE NODE_BIN PORT
set -eu
APP_DIR=${APP_DIR:-/opt/hermescity}
APP_USER=${APP_USER:-hermescity}
SERVICE=${SERVICE:-hermescity}
DB_NAME=${DB_NAME:-hermescity}
STATE_DIR=${STATE_DIR:-/var/lib/hermescity}
ENV_FILE=${ENV_FILE:-/etc/hermescity.env}
NODE_BIN=${NODE_BIN:-$(dirname "$(command -v node)")}
PORT=${PORT:-8150}
export PATH="$NODE_BIN:$PATH"
cd "$APP_DIR"
as_app() { sudo -u "$APP_USER" env PATH="$PATH" HOME="$STATE_DIR" "$@"; }

# Secrets live in the env file, generated once and never printed.
if [ ! -f "$ENV_FILE" ]; then
  umask 027
  {
    echo "ADMIN_TOKEN=$(openssl rand -hex 24)"
    echo "DATABASE_URL=postgresql:///$DB_NAME?host=/var/run/postgresql"
    echo "PORT=$PORT"
    echo "HOST=127.0.0.1"
    echo "MEDIA_DIR=$STATE_DIR/media"
  } > "$ENV_FILE"
  chown "root:$APP_USER" "$ENV_FILE"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
(cd client && as_app npm install --no-audit --no-fund --loglevel=error && as_app npx vite build --logLevel warn)

HARDEN="NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$STATE_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0027"

cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=HermesCity (gateway, market, skills, chat, world server)
After=network.target postgresql.service
[Service]
User=$APP_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR/server
Environment=PATH=$NODE_BIN:/usr/bin:/bin
ExecStart=$NODE_BIN/npx tsx src/main.ts
Restart=always
RestartSec=3
MemoryMax=700M
$HARDEN
[Install]
WantedBy=multi-user.target
UNIT

cat > "/etc/systemd/system/$SERVICE-house.service" <<UNIT
[Unit]
Description=HermesCity residents (CityRunner)
After=$SERVICE.service
Requires=$SERVICE.service
[Service]
User=$APP_USER
EnvironmentFile=$ENV_FILE
Environment=EW_STATE=$STATE_DIR/house PYTHONUNBUFFERED=1
WorkingDirectory=$APP_DIR/agents
ExecStartPre=/bin/sleep 3
ExecStart=/usr/bin/python3 house.py
Restart=always
RestartSec=10
MemoryMax=300M
$HARDEN
[Install]
WantedBy=multi-user.target
UNIT

cat > "/etc/systemd/system/$SERVICE-reconcile.service" <<UNIT
[Unit]
Description=HermesCity nightly ledger reconciliation
[Service]
Type=oneshot
User=$APP_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR/server
Environment=PATH=$NODE_BIN:/usr/bin:/bin
ExecStart=$NODE_BIN/npx tsx src/reconcile.ts
StandardOutput=append:$STATE_DIR/reconcile.log
$HARDEN
UNIT
cat > "/etc/systemd/system/$SERVICE-reconcile.timer" <<UNIT
[Unit]
Description=HermesCity nightly ledger reconciliation
[Timer]
OnCalendar=*-*-* 04:10:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
UNIT

cat > "/etc/logrotate.d/$SERVICE" <<ROT
$STATE_DIR/house/receipts.jsonl $STATE_DIR/reconcile.log {
  daily
  rotate 14
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
ROT

systemctl daemon-reload
systemctl enable --now "$SERVICE-reconcile.timer" >/dev/null
systemctl enable "$SERVICE" "$SERVICE-house" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 4
curl -fsS "http://127.0.0.1:$PORT/api/health" && echo
systemctl restart "$SERVICE-house"
echo installed
