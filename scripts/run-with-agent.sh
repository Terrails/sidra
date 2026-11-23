#!/bin/sh
# Run this Sidra checkout with playback through the Wine engine (the player service of
# wine-engine-for-apple-music, see README-agent.md) instead of the browser.
# Sidra starts the service when it is not running. Quitting Sidra stops playback and quits the
# service; with --keep-service (or AM_WEBUI_KEEP_SERVICE=1) it only stops playback and the
# service keeps running.
#
# usage: scripts/run-with-agent.sh [--keep-service] [Electron arguments]
#        npm run start:agent -- [--keep-service] [Electron arguments]
#        scripts/run-with-agent.sh --prepare-only   (download Electron, build dist/, then exit)
#
# Environment (README-agent.md has the full list):
#   AM_AGENT_DIR          checkout of wine-engine-for-apple-music (its bin/amd is started);
#                         without it an `amd` command on PATH is used
#   AM_PREFIX, AM_PORT, AM_STOREFRONT   passed on to the service (defaults: the agent's own
#                         prefix, 7654, us)
#   AM_WEBUI_PROFILE      Electron profile (default ${XDG_CONFIG_HOME:-~/.config}/sidra-wine-engine)
#   AM_WEBUI_DESKTOP_ID   desktop entry and Wayland app_id (default sidra-wine-engine)
#   AM_WEBUI_AGENT=0, AM_WEBUI_UNRESTRICT=1, AM_WEBUI_DEBUG=1, AM_WEBUI_HIDDEN=1,
#   AM_WEBUI_NO_SPAWN=1, AM_WEBUI_MIXED_QUEUE=1, AM_WEBUI_LIBRARY_SHUFFLE=0, AM_WEBUI_SEAMLESS=0
#   AM_WEBUI_CROSSFADE    0 (off) or 1 to 12 (seconds): the engine's crossfade
# The desktop entry keeps the settings of the run that wrote it (see below).
# Other arguments go to Electron (e.g. --remote-debugging-port=9342 --mute-audio).
PREPARE_ONLY=
for arg do
    shift
    case $arg in
        --keep-service) export AM_WEBUI_KEEP_SERVICE=1;;
        --prepare-only) PREPARE_ONLY=1;;
        *) set -- "$@" "$arg";;
    esac
done
# The script may be called through a symlink: resolve its real place.
SELF="$(readlink -f "$0")"
SIDRA="$(dirname "$(dirname "$SELF")")"
ELECTRON="$SIDRA/node_modules/electron/dist/electron"
if [ ! -x "$SIDRA/node_modules/.bin/tsc" ] || [ ! -f "$SIDRA/node_modules/electron/install.js" ]; then
    echo "Sidra's dependencies are not installed:" >&2
    echo "    cd \"$SIDRA\" && npm ci" >&2
    exit 1
fi
# This Electron has no postinstall step: npm leaves the binary out and the package downloads
# it on first use. Do that here (CastLabs build, ~120 MB, once).
if [ ! -x "$ELECTRON" ]; then
    echo "Downloading the Electron binary..." >&2
    (cd "$SIDRA" && node node_modules/electron/install.js) || exit 1
fi
# Rebuild when dist/ is missing or older than a source file. tsc never deletes stale output:
# when a source file moves or is removed, delete its old dist/*.js by hand (a stale
# dist/agent.js next to dist/agent/index.js shadows the module), or remove dist/ altogether.
if [ ! -f "$SIDRA/dist/main.js" ] || [ -n "$(find "$SIDRA/src" -newer "$SIDRA/dist/main.js" -name '*.ts' -print -quit)" ]; then
    (cd "$SIDRA" && node scripts/inject-lastfm-credentials.cjs && node_modules/.bin/tsc) || exit 1
fi
[ -z "$PREPARE_ONLY" ] || exit 0
# Desktop entry + icons under their own ID: on Wayland the window's app_id is this ID, and the
# taskbar takes the icon from the .desktop file of that name (without one: a generic icon).
# A menu start does not have this shell's environment, so Exec keeps the settings of this run:
# AM_AGENT_DIR (when unset: the checkout of the `amd` on PATH, if it is the agent's), AM_PREFIX,
# AM_PORT, AM_STOREFRONT and every AM_WEBUI_* that is set (not AM_WEBUI_HIDDEN, and
# AM_WEBUI_DESKTOP_ID only when it is not the default). Rewritten when the checkout moves or
# those settings change. To remove it, delete
# ${XDG_DATA_HOME:-~/.local/share}/applications/<ID>.desktop and
# ${XDG_DATA_HOME:-~/.local/share}/icons/hicolor/*/apps/<ID>.png.
export AM_WEBUI_DESKTOP_ID="${AM_WEBUI_DESKTOP_ID:-sidra-wine-engine}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DESKTOP="$DATA/applications/$AM_WEBUI_DESKTOP_ID.desktop"
# One quoted Exec argument (Desktop Entry spec): inside double quotes " ` $ \ take a backslash,
# and the string escapes apply first, so each such backslash is written twice; % is written %%.
desktop_quote() {
    printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\\\\\/g' -e 's/["`$]/\\\\&/g' -e 's/%/%%/g')"
}
ENTRY_ENV=
entry_env() {
    case $2 in *'
'*) echo "run-with-agent.sh: $1 contains a newline, the desktop entry leaves it out" >&2; return;; esac
    ENTRY_ENV="$ENTRY_ENV $(desktop_quote "$1=$2")"
}
if [ -n "$AM_AGENT_DIR" ]; then
    dir="$(readlink -f "$AM_AGENT_DIR")" || { echo "run-with-agent.sh: AM_AGENT_DIR=$AM_AGENT_DIR: its parent directory does not exist" >&2; exit 1; }
    entry_env AM_AGENT_DIR "$dir"
elif amd="$(command -v amd)" && amd="$(readlink -f "$amd")" && [ -f "$(dirname "$amd")/amd-env.sh" ]; then
    entry_env AM_AGENT_DIR "$(dirname "$(dirname "$amd")")"
fi
for name in AM_PREFIX AM_PORT AM_STOREFRONT $(env | sed -n 's/^\(AM_WEBUI_[A-Z0-9_]*\)=.*/\1/p' | LC_ALL=C sort -u); do
    eval "value=\${$name-}"
    [ -n "$value" ] || continue
    case $name in
        AM_WEBUI_HIDDEN) continue;;
        AM_WEBUI_DESKTOP_ID) [ "$value" != sidra-wine-engine ] || continue;;
        AM_PREFIX|AM_WEBUI_PROFILE) case $value in /*) ;; *) value="$PWD/$value";; esac;;
    esac
    entry_env "$name" "$value"
done
if [ -n "$ENTRY_ENV" ]; then EXEC="env$ENTRY_ENV $(desktop_quote "$SELF")"; else EXEC="$(desktop_quote "$SELF")"; fi
if [ "$(uname)" = Linux ] && ! grep -qxF "Exec=$EXEC" "$DESKTOP" 2>/dev/null; then
    for png in "$SIDRA"/build/icons/*x*.png; do
        size="$(basename "$png" .png)"
        mkdir -p "$DATA/icons/hicolor/$size/apps" && cp "$png" "$DATA/icons/hicolor/$size/apps/$AM_WEBUI_DESKTOP_ID.png"
    done
    mkdir -p "$DATA/applications"
    cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Sidra (Wine engine)
Comment=Sidra with playback through the Wine engine
Exec=$EXEC
Icon=$AM_WEBUI_DESKTOP_ID
Terminal=false
Categories=AudioVideo;Audio;Player;
StartupWMClass=$AM_WEBUI_DESKTOP_ID
EOF
    command -v update-desktop-database >/dev/null && update-desktop-database -q "$DATA/applications"
fi
# Own profile, so this does not share a session or the single-instance lock with a plain Sidra.
exec "$ELECTRON" "$SIDRA" --user-data-dir="${AM_WEBUI_PROFILE:-${XDG_CONFIG_HOME:-$HOME/.config}/sidra-wine-engine}" "$@"
