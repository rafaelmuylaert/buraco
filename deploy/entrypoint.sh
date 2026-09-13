#!/bin/sh
set -eu

ROLE="${1:-server}"
: "${GIT_APP_DIR:=/app}"
: "${GIT_DATA_DIR:=/data}"

APP_DIR="$GIT_APP_DIR"
APP_BIN="$APP_DIR/buraco-server"
APP_CLIENT="$APP_DIR/buraco-client"

log() { echo "[entrypoint] $*"; }

link_data() {
    log "Linking persistent data..."
    # Persistent data is mounted at /data/{db,bots} (outside the container app folder).
    for d in db bots; do
        if [ -d "$GIT_DATA_DIR/$d" ]; then
            if [ "$d" = "bots" ] && [ -z "$(ls -A "$GIT_DATA_DIR/bots")" ]; then
                cp "$APP_BIN/bots/"* "$GIT_DATA_DIR/bots/" 2>/dev/null || true
                log "seeded /data/bots from tracked BotRafa snapshots"
            fi
            if [ -e "$APP_BIN/$d" ] && [ ! -L "$APP_BIN/$d" ]; then
                rm -rf "$APP_BIN/$d"
            fi
            if [ ! -e "$APP_BIN/$d" ]; then
                ln -s "$GIT_DATA_DIR/$d" "$APP_BIN/$d"
                log "linked $GIT_DATA_DIR/$d -> buraco-server/$d"
            fi
        fi
    done
}

# Link runtime symlinks
link_data

# Execute application directly in the foreground (PID 1)
log "Starting $ROLE..."
case "$ROLE" in
    client)
        cd "$APP_CLIENT"
        exec npm run preview -- --host
        ;;
    server)
        cd "$APP_BIN"
        exec node server.js
        ;;
    bot)
        cd "$APP_BIN"
        exec node bot.js
        ;;
    *)
        log "Unknown role: $ROLE"
        exit 1
        ;;
esac