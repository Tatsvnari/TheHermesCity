#!/bin/sh
# Idempotent host setup + test gate for HermesCity. Run as root from the app directory.
# Settings (environment, all optional): APP_DIR APP_USER DB_NAME STATE_DIR NODE_BIN
set -eu
APP_DIR=${APP_DIR:-/opt/hermescity}
APP_USER=${APP_USER:-hermescity}
DB_NAME=${DB_NAME:-hermescity}
STATE_DIR=${STATE_DIR:-/var/lib/hermescity}
NODE_BIN=${NODE_BIN:-$(dirname "$(command -v node)")}
export PATH="$NODE_BIN:$PATH"
cd "$APP_DIR"

id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='$APP_USER'" | grep -q 1 || sudo -u postgres createuser "$APP_USER"
for db in "$DB_NAME" "${DB_NAME}_test"; do
  sudo -u postgres psql -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 || sudo -u postgres createdb -O "$APP_USER" "$db"
done
mkdir -p "$STATE_DIR/media" "$STATE_DIR/house"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$STATE_DIR"

as_app() { sudo -u "$APP_USER" env PATH="$PATH" HOME="$STATE_DIR" "$@"; }
cd server
as_app npm install --no-audit --no-fund --loglevel=error
as_app npx tsc --noEmit
as_app env TEST_DATABASE_URL="postgresql:///${DB_NAME}_test?host=/var/run/postgresql" npm test 2>&1 | tail -25
