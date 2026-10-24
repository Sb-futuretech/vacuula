#!/usr/bin/env bash
# Update the self-built Vacuula on the Pi: pull, build the image, restart it with docker compose.
#
#   ./deploy.sh                 pull the branch, build, restart
#   ./deploy.sh --no-pull       build and restart what is checked out
#   ./deploy.sh --list          show the builds kept for rollback
#   ./deploy.sh --rollback ID   run an earlier build again (ID from --list)
#
# Every build is tagged twice: IMAGE:LIVE_TAG (what docker-compose.yaml runs) and IMAGE:<commit>,
# so an earlier build can be switched back to. The KEEP newest commit builds are kept.
set -euo pipefail

# ---- adjust to your Pi (or set them when calling: REPO_DIR=... ./deploy.sh) ------------------
REPO_DIR="${REPO_DIR:-$HOME/vacuula}"        # git clone of the fork
COMPOSE_DIR="${COMPOSE_DIR:-$HOME/vacuula-run}" # folder with docker-compose.yaml
BRANCH="${BRANCH:-main}"
IMAGE="${IMAGE:-vacuula}"
LIVE_TAG="${LIVE_TAG:-sb}"                   # must match `image:` in docker-compose.yaml
KEEP="${KEEP:-3}"
DOCKER="${DOCKER:-docker}"                 # "sudo docker" if your user is not in the docker group
# ------------------------------------------------------------------------------------------------

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

restart() {
    log "Restarting with docker compose"
    (cd "$COMPOSE_DIR" && $DOCKER compose up -d)
    log "Server start (waiting ${STARTUP_WAIT:-15} s)"
    sleep "${STARTUP_WAIT:-15}"
    local startup
    startup="$(cd "$COMPOSE_DIR" && $DOCKER compose logs --since 1m 2>&1 \
        | grep -E 'Starting Vacuula Server|listening on|connected' || true)"
    printf '%s\n' "$startup"
    grep -q 'listening on http://[^ ]*:8050' <<<"$startup" \
        && die "web app is on port 8050: set VACUULA_PORT=80 in docker-compose.yaml (the robot uploads maps to that port)"
    return 0
}

list_builds() {
    $DOCKER images "$IMAGE" --format '{{.Tag}}\t{{.CreatedSince}}\t{{.ID}}' | grep -v '^<none>' || true
}

case "${1:-}" in
    --list)
        list_builds
        exit 0
        ;;
    --rollback)
        id="${2:-}"
        [ -n "$id" ] || die "usage: $0 --rollback <tag from --list>"
        $DOCKER image inspect "$IMAGE:$id" >/dev/null 2>&1 || die "no image $IMAGE:$id (see $0 --list)"
        log "Rolling back: $IMAGE:$LIVE_TAG -> $IMAGE:$id"
        $DOCKER tag "$IMAGE:$id" "$IMAGE:$LIVE_TAG"
        restart
        exit 0
        ;;
    --no-pull|"")
        ;;
    *)
        die "unknown option $1 (see the top of $0)"
        ;;
esac

[ -d "$REPO_DIR/.git" ] || die "REPO_DIR $REPO_DIR is not a git clone"
[ -f "$COMPOSE_DIR/docker-compose.yaml" ] || [ -f "$COMPOSE_DIR/docker-compose.yml" ] \
    || die "no docker-compose.yaml in COMPOSE_DIR $COMPOSE_DIR"
cd "$REPO_DIR"

if [ "${1:-}" != "--no-pull" ]; then
    [ -z "$(git status --porcelain --untracked-files=no)" ] \
        || die "local changes in $REPO_DIR, commit or discard them first (git status)"
    log "Pulling $BRANCH"
    git fetch origin
    git checkout -q "$BRANCH"
    git pull --ff-only origin "$BRANCH"
fi

commit="$(git rev-parse --short HEAD)"
log "Building $IMAGE:$LIVE_TAG and $IMAGE:$commit ($(git log -1 --format='%s'))"
$DOCKER build -f build/docker/Dockerfile -t "$IMAGE:$LIVE_TAG" -t "$IMAGE:$commit" .

restart

# keep the KEEP newest commit builds (and whatever the live tag points at)
live_id="$($DOCKER image inspect --format '{{.Id}}' "$IMAGE:$LIVE_TAG")"
$DOCKER images "$IMAGE" --format '{{.Tag}} {{.ID}}' \
    | { grep -Ev "^($LIVE_TAG|<none>) " || true; } \
    | tail -n +"$((KEEP + 1))" \
    | while read -r tag id; do
        if [ "$($DOCKER image inspect --format '{{.Id}}' "$IMAGE:$tag")" = "$live_id" ]; then continue; fi
        log "Removing old build $IMAGE:$tag"
        $DOCKER image rm "$IMAGE:$tag" >/dev/null || true
    done

log "Done: $IMAGE:$LIVE_TAG = $commit. Earlier builds: $0 --list, back: $0 --rollback <tag>"
