#!/bin/sh
# Silent end-to-end check of the Wine-engine playback path against the agent's mock service:
# no Wine, no sound, no sign-in, temporary profiles; does not touch a running service, your
# Sidra profiles or your desktop entries.
#   hook     the MusicKit hook attaches and the quality button appears
#   player   play, pause, seek + resume, next                    (test/agent-smoke.js)
#   seamless two consecutive engine songs (test/agent-smoke-seamless.js): AM_WEBUI_CROSSFADE and
#            then the engine's autoplay set at start-up; with crossfade on (which the mock ignores:
#            the next song starts at the end) and off, the second song takes over at the end
#            without /play or /pause (with AAC and crossfade the /play takes the second song
#            along, next=, instead of an /enqueue); a skip while the second is queued moves the engine on into
#            it with /next (no /play or /dequeue); a mock without the queue API (POST /mock/seamless?on=0)
#            gets the old pause at the end and /play
#   badge    the "engine not responding" badge (the mock's POST /mock/hang) shows and clears
#   reload   a page reload pauses playback, also a track that is still loading
#   quit     quitting Sidra (SIGTERM) sends POST /quit to the service, after a /stop and the
#            engine's autoplay turned back on (Sidra turned it off at start-up)
#   missing  without a service to start, the badge says "Engine not found" (no path in the page)
#   failed   a service whose bin/amd exits at once: the badge says "Engine failed to start" and
#            its output is in Sidra's log directory (amd-start.log)
#   upstream with AM_WEBUI_AGENT=0 MusicKit runs without the hook and without window.amAgent
#
# usage: AM_AGENT_DIR=<checkout of wine-engine-for-apple-music> test/agent-smoke.sh
#        (or: npm run test:agent)
# Needs network (music.apple.com, iTunes lookups), node, curl, timeout (coreutils), `npm ci` done
# in this checkout, and a Wayland or X11 session (the windows stay hidden;
# --ozone-platform=headless does not work: the page never lays out its player bar there). The
# Electron binary and dist/ are fetched/built first (scripts/run-with-agent.sh --prepare-only).
# The mock is $AM_AGENT_DIR/test/mock-daemon.mjs; the real service is never started (the
# "failed" phase starts a stand-in bin/amd that only prints a line and exits 1).
# SMOKE_PORT (default 7699) is the mock's port, SMOKE_CDP_PORT (default 9362) the first of the
# four DevTools ports. SMOKE_ELECTRON_ARGS (default none) are extra Electron arguments.
# SMOKE_SONGS (default "617154353 617154366") are two consecutive catalogue song IDs of one album
# that the page plays; the mock looks their titles up in the public iTunes lookup API.
SELF="$(readlink -f "$0")"
T="$(dirname "$SELF")"
SIDRA="$(dirname "$T")"
RUN="$SIDRA/scripts/run-with-agent.sh"
if [ -z "$AM_AGENT_DIR" ]; then
    echo "agent-smoke: set AM_AGENT_DIR to a checkout of wine-engine-for-apple-music" >&2
    echo "             (the mock service is its test/mock-daemon.mjs)" >&2
    exit 2
fi
MOCK_JS="$AM_AGENT_DIR/test/mock-daemon.mjs"
if [ ! -f "$MOCK_JS" ]; then
    echo "agent-smoke: $MOCK_JS not found: is AM_AGENT_DIR a checkout of wine-engine-for-apple-music?" >&2
    exit 2
fi
# shellcheck disable=SC2086 # split SMOKE_SONGS into two IDs
set -- ${SMOKE_SONGS:-617154353 617154366}
is_id() { case $1 in ''|*[!0-9]*) return 1;; esac; }
if [ $# != 2 ] || ! is_id "$1" || ! is_id "$2"; then
    echo "agent-smoke: SMOKE_SONGS must be two numeric song IDs" >&2; exit 2
fi
SONG1=$1 SONG2=$2
for tool in node curl timeout; do
    command -v "$tool" > /dev/null || { echo "agent-smoke: $tool is needed" >&2; exit 2; }
done
# Electron binary and dist/ now, so that the first wait below does not include a download or build.
"$RUN" --prepare-only || { echo "agent-smoke: scripts/run-with-agent.sh --prepare-only failed" >&2; exit 1; }
TMP="$(mktemp -d "${TMPDIR:-/tmp}/sidra-agent-smoke.XXXXXX")"
PORT=${SMOKE_PORT:-7699}
CDP=${SMOKE_CDP_PORT:-9362}
CDP_MISSING=$((CDP + 1))
CDP_UPSTREAM=$((CDP + 2))
CDP_FAILED=$((CDP + 3))
ELECTRON_ARGS=${SMOKE_ELECTRON_ARGS-}
FAIL=0

# On failure the logs stay in $TMP.
cleanup() {
    pkill -f "$TMP" 2>/dev/null; kill "$MOCK" 2>/dev/null; sleep 0.5
    if [ "$FAIL" = 0 ]; then rm -rf "$TMP"; else echo "agent-smoke: logs kept in $TMP" >&2; fi
}
trap cleanup EXIT
trap 'FAIL=1; exit 130' INT TERM
for f in agent-smoke.js agent-smoke-seamless.js; do
    sed -e "s/__SONG1__/$SONG1/g" -e "s/__SONG2__/$SONG2/g" "$T/$f" > "$TMP/$f"
done

# The service writes its API token into the prefix; the mock accepts "mocktoken".
mkdir -p "$TMP/prefix/drive_c/users/x/AppData/Local/AppleMusicWrapper"
printf mocktoken > "$TMP/prefix/drive_c/users/x/AppData/Local/AppleMusicWrapper/token"
# MOCK_AUTOPLAY=1: with crossfade on, Sidra must turn the engine's autoplay off (seamless phase)
MOCK_AUTOPLAY=1 node "$MOCK_JS" "$PORT" > "$TMP/mock.log" 2>&1 &
MOCK=$!
sleep 0.5
kill -0 "$MOCK" 2>/dev/null || { head -5 "$TMP/mock.log"; echo "agent-smoke: mock service did not start (port $PORT busy? SMOKE_PORT=...)"; exit 1; }

# Sidra through scripts/run-with-agent.sh, with everything it writes kept in $TMP: the profile,
# the desktop entry and icons (XDG_DATA_HOME). AM_AGENT_DIR is dropped so that nothing can
# start the real service. usage: sidra <profile> <DevTools port> <log> [VAR=value...]
# When it exits, its exit code goes to $SIDRA_DONE (wait_page then stops waiting).
sidra() {
    profile=$1 cdp=$2 log=$3; shift 3
    SIDRA_DONE="$TMP/$profile.exited"
    # shellcheck disable=SC2086 # ELECTRON_ARGS is a list of arguments
    { env -u AM_AGENT_DIR -u WINEPREFIX XDG_DATA_HOME="$TMP/xdg-data" AM_PREFIX="$TMP/prefix" \
        AM_WEBUI_HIDDEN=1 AM_WEBUI_PROFILE="$TMP/$profile" "$@" \
        "$RUN" --remote-debugging-port="$cdp" --mute-audio $ELECTRON_ARGS > "$TMP/$log" 2>&1
      echo $? > "$SIDRA_DONE"; } 2>/dev/null &
}

# wait until the page on DevTools port $1 answers expression $2 with "true" (up to $3 s, or
# until the Sidra started last has exited)
wait_page() {
    i=0
    while [ $i -lt "$3" ]; do
        [ "$(timeout 10 node "$T/cdp.mjs" "$1" -e "$2" 2>/dev/null)" = "true" ] && return 0
        if [ -f "$SIDRA_DONE" ]; then echo "  Sidra exited (code $(cat "$SIDRA_DONE"))"; return 1; fi
        sleep 1; i=$((i + 1))
    done
    return 1
}

# wait until the page on DevTools port $1 has settled (up to $2 s): the hook is attached, the
# player usable (MusicKit.getInstance()) and the same document at the same URL for SETTLE_SECS
# consecutive seconds. The page navigates again shortly after the hook first shows (us to ie),
# which replaces the document and the hook with it. Prints why on failure.
SETTLE_SECS=${SMOKE_SETTLE_SECS:-4}
SETTLED='(() => { try { if (!(HOOKED_EXPR && MusicKit.getInstance())) return "not ready"; return "ready " + (window.__smokeDoc ||= Math.random().toString(36).slice(2)) + " " + location.href; } catch (e) { return "not ready"; } })()'
wait_settled() {
    expr=$(printf '%s' "$SETTLED" | sed "s/HOOKED_EXPR/$(printf '%s' "$HOOKED" | sed 's/[&|\\]/\\&/g')/")
    i=0 same=0 last=
    while [ $i -lt "$2" ]; do
        cur=$(timeout 10 node "$T/cdp.mjs" "$1" -e "$expr" 2>/dev/null)
        case $cur in
        ready*) if [ "$cur" = "$last" ]; then same=$((same + 1)); else same=1; [ -n "$last" ] && echo "  page changed while settling: $cur"; fi
                last=$cur
                [ $same -ge "$SETTLE_SECS" ] && return 0;;
        *) same=0 last=;;
        esac
        if [ -f "$SIDRA_DONE" ]; then echo "  Sidra exited (code $(cat "$SIDRA_DONE"))"; return 1; fi
        sleep 1; i=$((i + 1))
    done
    echo "  page did not settle within $2 s (last: ${cur:-no answer}; needed $SETTLE_SECS s of the same document)"
    return 1
}

# the mock's agent watchdog: hang (call name $1) or recover (no argument)
mock_hang() { curl -s -m 5 -X POST -H "Authorization: Bearer mocktoken" "http://127.0.0.1:$PORT/mock/hang?call=$1" > /dev/null; }

# a POST to the mock ($1: path and query)
mock_post() { curl -s -m 5 -X POST -H "Authorization: Bearer mocktoken" "http://127.0.0.1:$PORT$1" > /dev/null; }

# the mock's playing/paused state and song ID
mock_state() { curl -s -m 5 -H "Authorization: Bearer mocktoken" "http://127.0.0.1:$PORT/status" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d);console.log(s.playing?"playing":s.paused?"paused":"stopped",s.nowPlaying?.songId??"-")})'; }

# run page script $2 on DevTools port $1 and check that every pattern after it appears
check() {
    port=$1 script=$2 name=$3; shift 3
    out=$(timeout 60 node "$T/cdp.mjs" "$port" "$script" 2>&1)
    echo "$out" | sed "s/^/  $name: /"
    for pat in "$@"; do
        echo "$out" | grep -q -- "$pat" || { echo "  $name: FAILED, missing: $pat"; FAIL=1; }
    done
}

# a seamless-transition scenario on DevTools port $1 (test/agent-smoke-seamless.js in mode $2,
# reported as $3). Each pattern after them must appear in the page's report, or with a leading
# + in what the mock saw after the scenario's first /play, or with a leading - must not.
check_seam() {
    port=$1 mode=$2 name=$3; shift 3
    sed "s/__MODE__/$mode/g" "$TMP/agent-smoke-seamless.js" > "$TMP/seam-$name.js"
    mark=$(wc -l < "$TMP/mock.log")
    out=$(timeout 90 node "$T/cdp.mjs" "$port" "$TMP/seam-$name.js" 2>&1)
    echo "  $name: $out"
    saw=$(tail -n +$((mark + 1)) "$TMP/mock.log" | sed -n "/POST \/play?.*song=$SONG1/,\$p" | tail -n +2)
    for pat in "$@"; do
        case $pat in
        +*) echo "$saw" | grep -q -- "${pat#+}" || { echo "  $name: FAILED, the service did not see: ${pat#+}"; FAIL=1; };;
        -*) ! echo "$saw" | grep -q -- "${pat#-}" || { echo "  $name: FAILED, the service saw: ${pat#-}"; FAIL=1; };;
        *) echo "$out" | grep -q -- "$pat" || { echo "  $name: FAILED, missing: $pat"; FAIL=1; };;
        esac
    done
    node "$T/cdp.mjs" "$port" -e 'MusicKit.getInstance().stop().then(() => 1)' > /dev/null; sleep 1
}

check_seamless() {
    if grep -q "POST /crossfade?on=1&s=6" "$TMP/mock.log" && grep -q "POST /autoplay?on=0" "$TMP/mock.log"; then
        echo "  seamless: crossfade set from AM_WEBUI_CROSSFADE, the engine's autoplay turned off"
    else echo "  seamless: FAILED, no POST /crossfade?on=1&s=6 or /autoplay?on=0 at start-up"; FAIL=1; fi
    check_seam "$1" end crossfade 'item=second state=2' 'left=[01]\.' '+POST /enqueue?.*song='"$SONG2" '+crossfade on, no effect) into' '-POST /play' '-POST /pause'
    # AAC: the /play takes the second song along (next=), the service queues it, no /enqueue
    mock_post "/quality?q=aac"; sleep 1
    check_seam "$1" end crossfade-aac 'item=second state=2' 'left=[01]\.' '+now playing .* next ' '-POST /enqueue?.*song='"$SONG2" '+crossfade on, no effect) into' '-POST /play' '-POST /pause'
    mock_post "/quality?q=lossless"
    mock_post "/crossfade?on=0"
    check_seam "$1" end gapless 'item=second state=2' 'left=[01]\.' '+POST /enqueue?.*song='"$SONG2" '+end, gapless into' '-POST /play' '-POST /pause'
    check_seam "$1" skip skip 'item=second state=2' '+POST /enqueue' '+POST /next' '-POST /play' '-POST /dequeue'
    mock_post "/mock/seamless?on=0"
    check_seam "$1" end fallback 'item=second state=2' '+POST /pause' '+POST /play?.*song='"$SONG2" '-POST /enqueue'
    mock_post "/mock/seamless?on=1"
}

# the page on DevTools port $1 shows a hung engine (expression $2 true) and clears it again
check_hung() {
    mock_hang 'MediaAppExecAgentCommandAsync(5013)'
    if wait_page "$1" "$2" 10; then
        mock_hang
        if wait_page "$1" "!($2)" 10; then echo "  badge: engine stuck shown and cleared"
        else echo "  badge: FAILED, engine stuck not cleared"; FAIL=1; fi
    else mock_hang; echo "  badge: FAILED, engine stuck not shown"; FAIL=1; fi
}

# a reload pauses what the page plays, and a track still loading when the page goes away is
# paused once it starts
HOOKED='!!window.__amAgentHooked && !!document.querySelector(".amagent-quality")'
settle_reload() { sleep 1; wait_settled "$1" 60 || { echo "  reload: FAILED, page did not come back"; FAIL=1; }; }
reload_page() { node "$T/cdp.mjs" "$1" -e 'setTimeout(() => location.reload(), 50), 1' > /dev/null; settle_reload "$1"; }
expect_state() {
    sleep "$2"; got=$(mock_state)
    case "$got" in "$3"*) echo "  reload: $4: $got";; *) echo "  reload: FAILED, $4: $got, expected $3"; FAIL=1;; esac
}
check_reload() {
    node "$T/cdp.mjs" "$1" -e '(async () => { const mk = MusicKit.getInstance(); await mk.setQueue({ songs: ["'"$SONG1"'", "'"$SONG2"'"] }); await mk.play(); return 1; })()' > /dev/null
    expect_state "$1" 3 playing "page playing"
    reload_page "$1"; expect_state "$1" 1 paused "page reloaded"
    node "$T/cdp.mjs" "$1" -e '(async () => { const mk = MusicKit.getInstance(); await mk.setQueue({ songs: ["'"$SONG1"'"] }); mk.play(); setTimeout(() => location.reload(), 300); return 1; })()' > /dev/null
    settle_reload "$1"; expect_state "$1" 2 "paused $SONG1" "reloaded while loading"
}

# quit Sidra's main process like a session logout or Ctrl+C would: the service gets POST /quit
check_quit() {
    pkill -TERM -o -f -- "--user-data-dir=$TMP/$1"
    i=0; while [ $i -lt 10 ] && pgrep -f "$TMP/$1" > /dev/null; do sleep 1; i=$((i + 1)); done
    if pgrep -f "$TMP/$1" > /dev/null; then echo "  quit: FAILED, still running"; FAIL=1
    elif ! tail -n 3 "$TMP/mock.log" | grep -q "POST /quit"; then echo "  quit: FAILED, no POST /quit"; FAIL=1
    # Sidra turned the engine's autoplay off (seamless phase): back on between the stop and the quit
    elif [ "$(tail -n 3 "$TMP/mock.log" | sed 's/^.* POST //' | tr '\n' ' ')" = "/stop /autoplay?on=1 /quit " ]; then
        echo "  quit: autoplay turned back on after the stop, service asked to quit"
    else echo "  quit: FAILED, expected /stop, /autoplay?on=1, /quit at the end"; FAIL=1; fi
}

echo "Sidra against the mock service:"
sidra sidra-profile "$CDP" sidra.log AM_PORT="$PORT" AM_WEBUI_NO_SPAWN=1 AM_WEBUI_CROSSFADE=6
if wait_page "$CDP" "$HOOKED" 120 && wait_settled "$CDP" 60; then
    echo "  hook: attached, quality button shown, page settled"
    check "$CDP" "$TMP/agent-smoke.js" player 'state=2 item=' 'paused state=3' 'after seek t=6' 'next item='
    check_seamless "$CDP"
    check_hung "$CDP" '!!document.querySelector(".amagent-stuck:not([hidden])")?.offsetParent'
    check_reload "$CDP"
    check_quit sidra-profile
else echo "  hook: FAILED, not attached (log: $TMP/sidra.log)"; FAIL=1; tail -n 20 "$TMP/sidra.log"; fi
pkill -f "$TMP/sidra-profile"

echo "Sidra without a service to start:"
# AM_AGENT_DIR names an empty directory and nothing listens on the port: the badge must say so.
mkdir -p "$TMP/no-agent"
sidra missing-profile "$CDP_MISSING" missing.log AM_PORT=$((PORT + 1)) AM_AGENT_DIR="$TMP/no-agent"
# The tooltip names AM_AGENT_DIR and the agent repository but no path (the page is Apple's).
MISSING='(() => { const b = document.querySelector(".amagent-stuck:not([hidden])"); return !!b && b.textContent === "Engine not found" && b.title.includes("AM_AGENT_DIR") && b.title.includes("wine-engine-for-apple-music") && !b.title.includes("no-agent"); })()'
if wait_page "$CDP_MISSING" "$MISSING" 120; then echo "  missing: badge says the engine was not found"
else echo "  missing: FAILED, no \"Engine not found\" badge (log: $TMP/missing.log)"; FAIL=1; fi
if grep "player service was not found" "$TMP/missing.log" "$TMP/missing-profile/logs/"*.log 2>/dev/null | grep -q "no-agent/bin/amd"; then echo "  missing: logged with the path"
else echo "  missing: FAILED, not logged"; FAIL=1; fi
pkill -f "$TMP/missing-profile"

echo "Sidra with a service that fails to start:"
# A stand-in checkout whose bin/amd exits 1 at once, as the real one does before setup-prefix.sh.
mkdir -p "$TMP/bad-agent/bin"
printf '#!/bin/sh\necho "stand-in amd: not set up" >&2\nexit 1\n' > "$TMP/bad-agent/bin/amd"
: > "$TMP/bad-agent/bin/amd-env.sh"
chmod +x "$TMP/bad-agent/bin/amd"
sidra failed-profile "$CDP_FAILED" failed.log AM_PORT=$((PORT + 3)) AM_AGENT_DIR="$TMP/bad-agent"
FAILED='(() => { const b = document.querySelector(".amagent-stuck:not([hidden])"); return !!b && b.textContent === "Engine failed to start" && b.title.includes("code 1") && !b.title.includes("/"); })()'
if wait_page "$CDP_FAILED" "$FAILED" 120; then echo "  failed: badge says the engine failed to start"
else echo "  failed: FAILED, no \"Engine failed to start\" badge (log: $TMP/failed.log)"; FAIL=1; fi
if grep -q "exited with code 1" "$TMP/failed.log" "$TMP/failed-profile/logs/"*.log 2>/dev/null &&
    grep -q "stand-in amd: not set up" "$TMP/failed-profile/logs/amd-start.log" 2>/dev/null; then echo "  failed: logged, output in amd-start.log"
else echo "  failed: FAILED, not logged or no amd-start.log"; FAIL=1; fi
pkill -f "$TMP/failed-profile"

echo "Sidra with the agent switched off (AM_WEBUI_AGENT=0):"
sidra upstream-profile "$CDP_UPSTREAM" upstream.log AM_PORT=$((PORT + 2)) AM_WEBUI_AGENT=0 AM_WEBUI_NO_SPAWN=1
MK_READY='(() => { try { return !!(window.MusicKit && MusicKit.getInstance && MusicKit.getInstance()); } catch { return false; } })()'
if wait_page "$CDP_UPSTREAM" "$MK_READY" 120; then
    sleep 3   # the hook would attach within a few 300 ms ticks
    if [ "$(node "$T/cdp.mjs" "$CDP_UPSTREAM" -e '!window.__amAgentHooked && !document.querySelector(".amagent-quality") && typeof window.amAgent === "undefined"' 2>/dev/null)" = true ]; then
        echo "  upstream: MusicKit configured, no hook, no quality button, no amAgent bridge"
    else echo "  upstream: FAILED, the hook or the bridge is present (log: $TMP/upstream.log)"; FAIL=1; fi
else echo "  upstream: FAILED, MusicKit never configured (log: $TMP/upstream.log)"; FAIL=1; fi
pkill -f "$TMP/upstream-profile"
if grep -q "player service on" "$TMP/upstream.log" "$TMP/upstream-profile/logs/"*.log 2>/dev/null; then
    echo "  upstream: FAILED, the agent was started"; FAIL=1
else echo "  upstream: agent not started"; fi

echo "mock service saw:"; grep -v "mock on" "$TMP/mock.log" | sed 's/^/  /'
[ $FAIL = 0 ] && echo "agent-smoke: OK" || echo "agent-smoke: FAILED"
exit $FAIL
