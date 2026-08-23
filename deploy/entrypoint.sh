#!/bin/sh
# git-entrypoint.sh — pulls the buraco repo from git at container start, keeps it
# updated by polling, and runs the app. The image contains NO app code; everything
# comes from git so pushing to the remote auto-deploys.
#
# Usage: git-entrypoint.sh <role>   where role is one of: server | bot | client
#
# Env:
#   GIT_URL        clone URL (default: http://10.0.0.2:3000/Rafael/buraco.git)
#   GIT_REF        branch/tag to track (default: main)
#   GIT_TOKEN      Gitea token for private repos (stays in env, never on disk)
#   GIT_POLL_SECS  poll interval in seconds; 0 = pull once then run (default: 60)

set -eu

ROLE="${1:-server}"
: "${GIT_REF:=main}"
: "${GIT_POLL_SECS:=60}"
: "${GIT_URL:=http://10.0.0.2:3000/Rafael/buraco.git}"
: "${GIT_APP_DIR:=/app}"
: "${GIT_DATA_DIR:=/data}"

APP_DIR="$GIT_APP_DIR"
APP_BIN="$APP_DIR/buraco-server"
APP_CLIENT="$APP_DIR/buraco-client"

log() { echo "[git-entrypoint] $*"; }

# Keep the token out of the stored remote URL: use GIT_ASKPASS instead.
if [ -n "${GIT_TOKEN:-}" ]; then
    cat > /tmp/git-askpass.sh <<'ASKPASS'
#!/bin/sh
case "$1" in
  *Username*) echo "oauth2" ;;
  *Password*) echo "${GIT_TOKEN}" ;;
esac
ASKPASS
    chmod +x /tmp/git-askpass.sh
    export GIT_ASKPASS=/tmp/git-askpass.sh
    export GIT_TERMINAL_PROMPT=0
fi

head_of() { git -C "$APP_DIR" rev-parse "$1" 2>/dev/null || echo ""; }

fetch_or_clone() {
    if [ ! -d "$APP_DIR/.git" ]; then
        log "cloning $GIT_URL ($GIT_REF)"
        git clone --depth 1 --branch "$GIT_REF" "$GIT_URL" "$APP_DIR"
    else
        log "pulling $GIT_REF"
        git -C "$APP_DIR" fetch origin "$GIT_REF" >/dev/null
        git -C "$APP_DIR" reset --hard "origin/$GIT_REF" >/dev/null
    fi
}

link_data() {
    # Persistent data is mounted at /data/{db,bots} (outside the repo). The app
    # resolves process.cwd()/db and /bots, so symlink them into buraco-server/.
    for d in db bots; do
        if [ -d "$GIT_DATA_DIR/$d" ]; then
            if [ "$d" = bots ] && [ -z "$(ls -A "$GIT_DATA_DIR/bots")" ]; then
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

prepare() {
    # npm workspaces: all @buraco/* packages resolve automatically from repo root
    link_data

    case "$ROLE" in
        server|bot)
            npm --prefix "$APP_DIR" ci --no-audit --no-fund
            ;;
        client)
            npm --prefix "$APP_CLIENT" ci --no-audit --no-fund
            log "building client"
            npm --prefix "$APP_CLIENT" run build
            ;;
    esac
}

start_app() {
    # The app resolves db/ and bots/ from process.cwd(), so server/bot must run
    # with cwd inside buraco-server (where link_data placed the symlinks).
    case "$ROLE" in
        client) cd "$APP_CLIENT" ;;
        *)      cd "$APP_BIN" ;;
    esac
case "$ROLE" in
        server) node server.js & ;;
        bot)    node bot.js & ;;
        client) npm run preview -- --host & ;;
    esac
    APP_PID=$!
    log "started $ROLE (pid $APP_PID)"
}

stop_app() {
    if [ -n "${APP_PID:-}" ]; then
        kill "$APP_PID" 2>/dev/null || true
        wait "$APP_PID" 2>/dev/null || true
    fi
}

run_foreground() {
    case "$ROLE" in
        client) cd "$APP_CLIENT" && exec npm run preview -- --host ;;
        *)      cd "$APP_BIN" && exec node "$ROLE.js" ;;
    esac
}

trap 'stop_app; exit 0' TERM INT

if [ "$GIT_POLL_SECS" -le 0 ]; then
    fetch_or_clone
    prepare
    run_foreground
fi

fetch_or_clone
prepare
start_app

while :; do
    sleep "$GIT_POLL_SECS"
    log "Checking for updates..."
    git -C "$APP_DIR" fetch origin "$GIT_REF" >/dev/null 2>&1 || continue
    log "local Head=$(head_of HEAD) remote=$(head_of "origin/$GIT_REF")"
    if [ "$(head_of HEAD)" != "$(head_of "origin/$GIT_REF")" ]; then
        log "update detected, redeploying"
        stop_app
        fetch_or_clone
        prepare
        start_app
    fi
done
