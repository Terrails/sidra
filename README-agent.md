# Sidra with the Wine engine (`wine-engine` branch)

**Unofficial. Not affiliated with, endorsed by or sponsored by Apple Inc.** This branch is also
not part of upstream [Sidra](https://github.com/wimpysworld/sidra); report problems with it here,
not upstream.

This branch is Sidra v1.3.2 with one change in purpose: **catalogue songs play through the Wine
engine** of [wine-engine-for-apple-music](#what-you-need) (the audio engine of Apple Music for
Windows, run under Wine behind a small local HTTP service) instead of through the browser.
Browsing, search, library, playlists, lyrics and the transport bar still come from
music.apple.com, exactly as in upstream Sidra. Everything else in this repository (the other
`README.md` sections, the wiki, the build) is upstream's and is described there.

## What this branch adds

- **Playback through the Wine engine.** A hook in the page hands every catalogue song to the
  player service. The hook works at the MusicKit level, so the page's queue, shuffle/repeat,
  autoplay and now-playing metadata keep working, and Sidra's integrations (MPRIS, tray,
  notifications) see the same MusicKit events as before (see [How it works](#how-it-works); the
  smoke test checks MusicKit's state, not each integration). Sidra starts the service itself when it is not running.
  Music videos, live radio and uploads without a catalogue ID still play in the page, as in
  upstream Sidra.
- **Seamless transitions** between two catalogue songs that MusicKit plays one after the other:
  gapless between songs of the same audio format (always so with AAC in the cases tried); between
  lossless songs of different formats the engine opens a new audio stream, which leaves about
  0.2-0.9 s of silence (what the songs themselves have included) instead of the 1-3 s of a new `/play`.
  Between 25 and 16 s before the end (plus the crossfade seconds) the next song
  is added to the engine's own queue ("Play Next", `POST /enqueue`), the engine goes on into it
  by itself, and MusicKit's next item takes over the track that is already playing instead of
  loading it again (see [How it works](#how-it-works)). A queue change, shuffle or repeat
  toggle, skip or new queue takes it out of the engine's queue again (`POST /dequeue`), except a
  skip to that very song: the engine then moves on into it (`POST /next`), and with crossfade the
  song after it stays queued, so the skipped-to song still crossfades into the next one. It
  needs a service with the queue API (`upNext` in its status); with an older one, with
  repeat-one, before a music video and after the last item, tracks are loaded one at a time as
  before. On by default, `AM_WEBUI_SEAMLESS=0` turns it off.
- **Crossfade** (`AM_WEBUI_CROSSFADE`, or the engine's own setting) with AAC only: the engine
  crossfades a song only when the next one was queued before it started (the agent's
  `docs/api.md`, "Queue and seamless playback"). With the quality set to AAC and crossfade on, Sidra therefore queues the next
  two songs early in a track, the second one with `at=end` ("Add to Queue"). A new `/play` (a pick
  from a list, a new queue) takes the next song along (`next=`): the engine queues it and pauses
  and plays the new song once, so its first change is crossfaded too; it starts about 1-3 s later.
  A skip to the next song is a `/next`, not a `/play`; when nothing is queued behind that song yet
  (a skip within about 3 s of a track's start), the `/next` takes the song after it along too. Only one song is queued when MusicKit's list does not
  show the one after it (end of the queue, repeat-all wrap) or it is the same song again, or when
  the next song is short. Songs of the same album are, by the engine's code, not crossfaded (not
  measured); they go on gaplessly.
- **Quality button** (AAC / Lossless / Hi-Res) in the player bar. It sets the floor the engine
  asks for (`POST /quality`), and its colour compares what is playing with that floor
  (AAC < Lossless < Hi-Res; Dolby Atmos, spatial and surround count as AAC): green when the
  floor is reached, yellow one step below, red two steps below, no colour while the format is not
  known yet (nothing playing, or the first seconds of a track before the stream switches). The
  tooltip shows bit depth and sample rate. A track that only exists as 24-bit/48 kHz stays
  yellow with Hi-Res chosen.
- **Engine badge** next to the quality button: a red "Engine not responding" while the service
  reports that an engine call has not returned within 5 s (`agentHung`; the tooltip names the
  call), gone again when it recovers; "Engine not found" when there is no service to start (the
  tooltip says what to set, see [Running it](#running-it)); "Engine failed to start" when the
  service Sidra started exited with an error (the tooltip gives the exit code).
- **Explicit-content override, opt-in** (`AM_WEBUI_UNRESTRICT=1`). The web session sometimes
  comes up with MusicKit's explicit-content restriction on although the account does not ask
  for it; explicit rows are then greyed out and dropped from the queue. With the setting, the
  hook turns the restriction off (`mk.restrictedEnabled = false`, MusicKit's own override,
  re-checked every 300 ms). It also overrides a restriction that is set on purpose (for example
  a child account's content setting), which is why it is off by default.
- **Shuffle the whole library**: a "Shuffle" button in the header of Library > Songs (signed in
  only). The page has Play/Shuffle only on albums and playlists, and a song started from the
  Songs list queues only the rows already loaded. The button fetches every library song and
  queues them with MusicKit's own shuffle on; the player bar's shuffle toggle shows it, and
  turning it off goes back to library order. On by default, `AM_WEBUI_LIBRARY_SHUFFLE=0` turns it
  off.
- **Mixed-kind queues, opt-in** (`AM_WEBUI_MIXED_QUEUE=1`). A list holding songs and music videos
  (a library playlist with a video in it) is refused by MusicKit ("Using multiple media kinds is
  not supported"), and the page shows "Not available on the web" for every track of it. With the
  option on, the hook takes the order from the album or playlist the page shows and queues the
  tracks as one ordered list; songs then play through the engine and videos in the page. It costs
  a second or two before the first track of a long list, and goes through unchanged (and fails as
  before) when the container is not known. Off by default.
- **Page reloads and quitting.** A page that is reloaded or replaced (reload, language change,
  any new document) loses its queue, but the engine would play on: Sidra pauses the engine, also
  a track that was still loading when the page went away (paused when it starts, within 20 s).
  Quitting Sidra (window closed, tray "Quit", SIGTERM/Ctrl+C; not close-to-tray) asks the
  service to quit (`POST /quit`, waiting at most 3 s so a hung engine does not keep Sidra open);
  `--keep-service` / `AM_WEBUI_KEEP_SERVICE=1` only stops playback (`POST /stop`) and leaves the
  service running for the next start.
- **Transfer-music tip freeze workaround.** music.apple.com stores when it first showed its
  "Transfer music" tip (localStorage `transfer-music-bubble-tip-first-view-*`). Once that
  timestamp is more than 7 days old, the page's renderer spins a few seconds after load and grows
  until the machine swaps; this is the page's own bug (it happens with every injection off). The
  hook resets the timestamp on every load, before the page reads it.
- Smaller changes: the Apple Music upsell banner is hidden (`assets/agent/style.css`);
  Sidra's wedge detector (which skips a track whose position stalls for 5 s) is off, because the
  engine's 1-3 s track loads would look like a wedge, and the hook handles stalls itself;
  `AM_WEBUI_DESKTOP_ID` overrides Sidra's desktop ID; `AM_WEBUI_HIDDEN=1` keeps every window
  hidden (for tests).

## What you need

- The agent repository
  **[wine-engine-for-apple-music](https://github.com/Terrails/wine-engine-for-apple-music)**,
  set up as its README describes. It runs
  the engine from **your own copy of Apple Music for Windows** (the MSIX package; nothing from
  the app is in either repository) and needs an **Apple Music subscription**, signed in to the
  engine once with its `bin/amd-signin`.
- Node.js and npm (the version in `.nvmrc`), and network access for `npm ci` and for the
  Electron binary (CastLabs build, ~120 MB, downloaded on first start).
- Linux with a Wayland or X11 session. The scripts are POSIX `sh`; the desktop entry is only
  installed on Linux.

Signing in to the web page inside Sidra is separate from the engine's sign-in and optional:
without it you can browse and search the catalogue and play full tracks through the engine; with
it you also get your library, playlists and recommendations.

## Running it

```sh
cd sidra                      # this checkout, branch wine-engine
npm ci
export AM_AGENT_DIR=/path/to/wine-engine-for-apple-music
scripts/run-with-agent.sh     # or: npm run start:agent
```

`scripts/run-with-agent.sh [--keep-service] [Electron arguments]`:

- downloads the Electron binary on first use (this Electron has no postinstall step);
- rebuilds `dist/` when it is missing or a `src/**/*.ts` is newer than `dist/main.js`. `tsc` never
  deletes stale output: when a source file moves or is removed, delete its old `dist/*.js` (a
  stale `dist/agent.js` next to `dist/agent/index.js` shadows the module), or delete `dist/`;
- installs a desktop entry "Sidra (Wine engine)" with ID `sidra-wine-engine`
  (`${XDG_DATA_HOME:-~/.local/share}/applications/sidra-wine-engine.desktop`, icons under
  `icons/hicolor/*/apps/`) so that on Wayland the window gets its own taskbar icon. Starting
  Sidra from it runs this script again, without the environment of your shell, so the entry
  keeps the settings of the run that wrote it: `AM_AGENT_DIR` (when it is unset, the checkout of
  the agent's `amd` found on `PATH`, because the menu's `PATH` often lacks `~/.local/bin`),
  `AM_PREFIX`, `AM_PORT`, `AM_STOREFRONT` and every `AM_WEBUI_*` that is set (except
  `AM_WEBUI_HIDDEN`). It is rewritten when the checkout moves or one of these changes, so the last
  run from a terminal decides what the menu entry uses. To remove it, delete that `.desktop`
  file and the `sidra-wine-engine.png` icons;
- runs Sidra with its own Electron profile, so it does not share a session or the
  single-instance lock with a plain Sidra.

The script resolves its own location (`readlink -f`), so it can be linked into `~/.local/bin`.
Other arguments go to Electron (for example `--remote-debugging-port=9342`).
`--prepare-only` downloads Electron and builds `dist/`, then exits (the smoke test uses it).

Sidra finds the service's start script as `$AM_AGENT_DIR/bin/amd` when `AM_AGENT_DIR` is set,
else as an `amd` command on `PATH` (the agent's `bin/` linked into `~/.local/bin`). Either one
counts only if `amd-env.sh` sits next to it (after following symlinks), so an unrelated `amd`
(the am-utils automounter is one) is never started. If there is none, nothing is started: the
reason, with the paths, is logged once (Sidra's log, `[agent]`), the badge in the player bar
says "Engine not found" (its tooltip names `AM_AGENT_DIR` and the agent repository, but no path:
the page is music.apple.com's), and catalogue songs do not play.

Sidra starts the service once and does not start it again while that process runs. Its own
output (for example "run setup-prefix.sh first") goes to `amd-start.log` in Sidra's log directory;
the service itself logs to `amd.log` in the agent's `AM_LOG_DIR`. If it exits with an error
before it answers, the badge says "Engine failed to start" (the tooltip gives the exit code), the
log names `amd-start.log`, and Sidra tries again every 25 s. A service that keeps rejecting
Sidra's API token (usually `AM_PREFIX` differs from the running service's) is logged once.

The service is started with `PULSE_PROP_OVERRIDE_application.process.id` set to Sidra's PID, so
the engine's audio stream claims to be Sidra's. Taskbars that match streams to windows by PID
(Plasma) then show the audio indicator, mute and volume on Sidra's entry; without it the stream
belongs to the agent, a Wine COM server whose parent is not Sidra. A service started some other
way (`AM_WEBUI_NO_SPAWN`, or one still running from an earlier Sidra) keeps its own PID.

### Settings

Sidra's own settings (environment variables of the Sidra process):

| Variable | Default | Effect |
|---|---|---|
| `AM_WEBUI_AGENT` | on | `0`: no engine at all; Sidra behaves as upstream (see [Without the agent](#without-the-agent)) |
| `AM_AGENT_DIR` | unset | checkout of wine-engine-for-apple-music; `$AM_AGENT_DIR/bin/amd` is started. Unset: `amd` on `PATH` |
| `AM_WEBUI_PROFILE` | `${XDG_CONFIG_HOME:-~/.config}/sidra-wine-engine` | Electron profile (`run-with-agent.sh` only) |
| `AM_WEBUI_DESKTOP_ID` | `sidra-wine-engine` (set by `run-with-agent.sh`; without the script Sidra's own ID) | desktop entry name, Wayland app_id, MPRIS and notification identity |
| `AM_WEBUI_KEEP_SERVICE` | unset | any value (= `--keep-service`): on quit only stop playback, keep the service running |
| `AM_WEBUI_SEAMLESS` | on | `0`: no seamless transitions, every queue item is loaded on its own and the engine paused at its end (above). On, while the engine's crossfade is on: also turns the engine's own autoplay off, once per connection (MusicKit's autoplay fills the queue; an engine that crossfades would fade into its own pick before Sidra can pause it). If Sidra turned it off, it turns it back on at quit (after `/stop`, before `/quit`; also with `AM_WEBUI_KEEP_SERVICE`; best effort within the 3 s quit budget); autoplay that was off already is left off. After a crash it stays off. A failed `/crossfade` or `/autoplay` is retried 5 s apart, three attempts per connection. A slow `/status` (a long `/enqueue` holds the engine) keeps the connection for up to 60 s |
| `AM_WEBUI_CROSSFADE` | unset (the engine's setting) | `0`: crossfade off; `1` to `12`: crossfade on, that many seconds. Set in the engine (`POST /crossfade`, which keeps it) once its playback settings exist, at start-up and whenever the service comes back; anything else is logged and ignored. Only between songs that go on seamlessly, and only with the quality set to AAC (above) |
| `AM_WEBUI_LIBRARY_SHUFFLE` | on | `0`: no Shuffle button on Library > Songs |
| `AM_WEBUI_MIXED_QUEUE` | off | any value: play lists that mix songs and music videos (above) |
| `AM_WEBUI_UNRESTRICT` | off | `1`: turn MusicKit's explicit-content restriction off (above) |
| `AM_WEBUI_DEBUG` | off | any value: the page hook logs to Sidra's log |
| `AM_WEBUI_HIDDEN` | off | any value: no windows are shown (headless tests over the DevTools protocol) |
| `AM_WEBUI_NO_SPAWN` | off | any value: never start the service (it is run some other way, or a mock is used) |

Settings of the agent that Sidra reads (see the agent's configuration documentation):

| Variable | Default | Used for |
|---|---|---|
| `AM_PREFIX` | `${XDG_DATA_HOME:-~/.local/share}/wine-engine-for-apple-music/prefix` | where Sidra reads the API token (`drive_c/users/*/AppData/Local/AppleMusicWrapper/token`); passed on to `bin/amd` |
| `AM_PORT` | `7654` | the service's port on `127.0.0.1` (1 to 65535; anything else is logged and the default used); passed to `bin/amd` as its argument |
| `AM_STOREFRONT` | `us` | two-letter country code (any case) for album links when neither the song link nor the page's MusicKit names one (in practice the page's storefront is used); an invalid value is logged and `us` used. `bin/amd` gets the variable unchanged |

`WINEPREFIX` is not used.

## How it works

The hook runs in the page's own world on music.apple.com (`assets/agent/`, assembled into one
closure by `src/agent/index.ts` and injected before Sidra's own MusicKit hook). MusicKit JS keeps
everything it normally does; only the last step, turning a queue item into sound, is replaced:

1. `mk._mediaItemPlayback.services.assetResolver.resolveAsset` returns, for a catalogue song, an
   "unencrypted progressive audio" asset whose URL describes the song (song ID, album ID,
   storefront, title, duration). No request goes to Apple's playback servers from the page. The
   album ID comes from the song's URL, else from the public iTunes lookup
   (`src/agent/commands.ts`).
2. `playerManager.createAudioPlayer` returns, for those assets, a second instance of MusicKit's
   own `HTMLAudioPlayer` whose media element is `AgentMedia` (`assets/agent/media.js`): an object
   that looks like an `<audio>` element, turns `src`, `play()`, `pause()`, `currentTime` and
   `volume` into service commands, and fires `playing`, `pause`, `timeupdate`, `ended` from the
   service's status, so MusicKit's state machine runs unchanged.
3. `playAsset` turns MusicKit's preview mode off for these assets (the page is in preview mode
   while signed out), so full tracks play.

The page only gets a narrow bridge (`window.amAgent` in `src/preload.ts`, top frame of
music.apple.com only): commands are validated in the main process (`src/agent/commands.ts`), and
the service's API token stays in the main process. The main process polls the service's status
every 250 ms and forwards it to the page.

Each queue item is one `/play` request for that song alone; MusicKit keeps the queue. The end of
a track is predicted from the status: `ended` fires 200 ms early and the engine is paused, so the
engine's own autoplay never sounds and MusicKit starts the next item. If the engine shows another
track (or none) for three statuses, the item is treated as ended. The service's volume wins at
start-up; afterwards the page's slider sets it.

Seamless transitions (`assets/agent/seamless.js`) change the end of a track when the service has
a queue API. While a catalogue song plays, MusicKit's next item (`mk.queue.nextPlayableItem`, so
repeat-all, shuffle order and MusicKit's autoplay items count; not with repeat-one or when
MusicKit stops after the item) is added to the engine's queue once, 25 s before the end plus the
crossfade seconds (earlier with AAC and crossfade, see below; `POST /enqueue`, song and album as for `/play`); not later than 16 s before
it, or a slow `/enqueue` could outlast the track. Once the engine's
status shows it first in `upNext`, the track is not paused at the end: the engine goes on by
itself, and when its status shows the new song (`songId`, `queueItemId`), the item ends. That is
at the nominal end (an engine that crossfades switches up to the crossfade seconds earlier, which
also ends the item; the list of queued songs then moves on by one). MusicKit then loads its next
item, and `play()` takes over the track the engine already plays, with position and duration from
the status, instead of sending `/play`. On every status the item is checked against MusicKit's
next item again; when that changes (a queue edit, shuffle or repeat toggle, a skip, a new queue)
it leaves the engine's queue (`POST /dequeue`, sent once no `/play` is running, and after
MusicKit's `play()` of a new item) and the new next item is added if there is still time; the
pause at the end applies again. An item whose `/enqueue` answered without a
`queueItemId` is found in `upNext` by its song. A skip to the queued item itself is an ordinary
`/play`.
Without a confirmed next item (the last one, a music video next, an older service, a failed
`/enqueue`), the old pause at the end applies; with one, the pause stays as a fallback 4 s past
the end, and twelve statuses (instead of three) without the track count as its end. `/enqueue`
takes about 0.7-2.6 s (about 11-13 s for a song the album page does not have, about 20 s at worst)
and holds up the other commands (an older service also its status); statuses are not acted on while a command runs, and it is sent
well before the end. A failed `/enqueue` is not retried for that track.

With AAC and crossfade on, the next song is added once the track has played for the crossfade
seconds plus 3 s, at least 3 s after the last command, and the one after it once `upNext` lists the
first. A pause or skip can wait behind such an `/enqueue`. When the first leaves the engine's queue,
so does the second. Without "Add to Queue" in the app (500 `80004001`), only one song is queued from
then on, near the end as above.

## Testing with the mock

`test/agent-smoke.sh` (or `npm run test:agent`) runs this branch silently against the agent's mock
service (`$AM_AGENT_DIR/test/mock-daemon.mjs`: the same API with a clock instead of audio; no
Wine, no sound, no sign-in). It uses temporary profiles and a temporary `XDG_DATA_HOME`, so it
does not touch a running service, your Sidra profiles or your desktop entries.

```sh
npm ci
AM_AGENT_DIR=/path/to/wine-engine-for-apple-music npm run test:agent
```

It checks: the hook attaches and the quality button appears; play, pause, seek + resume, next;
seamless transitions (crossfade and then the engine's autoplay set at start-up; with crossfade on,
which the mock ignores, and off, the next song takes over at the end without
`/play` or `/pause`; a skip while the next song is queued; the old pause at the end with a mock
without the queue API);
the "Engine not responding" badge shows and clears; a page reload pauses playback, also a track
that is still loading; quitting Sidra sends `/stop`, `/autoplay?on=1` and `POST /quit`; without a service to start, the badge
says "Engine not found" (no path in the page) and the reason is logged; with a stand-in `bin/amd`
that exits 1, the badge says "Engine failed to start" and its output is in `amd-start.log`; and
with `AM_WEBUI_AGENT=0` the page runs without the hook and without `window.amAgent` (upstream
playback). It first runs `scripts/run-with-agent.sh --prepare-only`, and stops waiting for a
phase as soon as that Sidra has exited. It needs network (music.apple.com and the iTunes
lookup), `node`, `curl`, `timeout` (coreutils) and a Wayland or X11 session (the windows stay
hidden; Electron's headless ozone platform does not lay out the player bar). `SMOKE_PORT`, `SMOKE_CDP_PORT`, `SMOKE_SONGS` and
`SMOKE_ELECTRON_ARGS` are described at the top of the script. On failure the logs are kept and
their directory is printed.

By hand, against a mock on port 7699:

```sh
node "$AM_AGENT_DIR/test/mock-daemon.mjs" 7699 &
mkdir -p /tmp/am-mock/drive_c/users/x/AppData/Local/AppleMusicWrapper
printf mocktoken > /tmp/am-mock/drive_c/users/x/AppData/Local/AppleMusicWrapper/token
AM_PREFIX=/tmp/am-mock AM_PORT=7699 AM_WEBUI_NO_SPAWN=1 AM_WEBUI_DEBUG=1 \
  AM_WEBUI_PROFILE=/tmp/am-mock/profile scripts/run-with-agent.sh --remote-debugging-port=9342 --mute-audio
node test/cdp.mjs 9342 -e 'document.querySelector(".amagent-quality")?.textContent'
```

Upstream's tests (`npm test`) cover Sidra's own code; `test/main.test.ts` replaces `src/agent`
with a stand-in that has the agent off.

## Without the agent

By default this branch plays catalogue songs through the engine: the hook is injected into every
music.apple.com page and Sidra's wedge detector is off. When no service can be found, the badge
says "Engine not found" and catalogue songs do not play (music videos and radio still play in
the page).

`AM_WEBUI_AGENT=0` switches all of that off: no hook, no agent styles, no `window.amAgent`
bridge and no agent IPC handlers, the wedge detector on and no service started, so Sidra plays in
the page as upstream Sidra does. Upstream code paths
that do not touch playback (themes, scrobbling, Discord, notifications, controller navigation)
are unchanged in either case.

## Limitations

- **Fragile by nature.** The hook depends on private MusicKit members (`_mediaItemPlayback`,
  `services.assetResolver`, `playerManager.createAudioPlayer`, `hasMediaElement`,
  `_playbackController`). If music.apple.com renames them, the debug log shows no
  `hooked MusicKit` line and the page falls back to its own behaviour (30 s previews while signed
  out, or browser playback).
- **Gapless only with the queue API.** With a service without it, and wherever seamless
  transitions do not apply (above), every track is loaded on its own: the gap between tracks is
  the engine's load time, about 1-3 s. Between lossless songs of different formats a seamless transition still has
  about 0.2-0.9 s of silence, and crossfade only has an effect with AAC (above).
- **One player at a time.** Whatever the engine plays is taken to be this page's: a reload pauses
  it, quitting Sidra stops it, also when another client (for example the agent's `bin/amctl`)
  started it. Changes made by another client while Sidra plays (track, volume) are not followed.
- A service that Sidra started and that is still starting up when Sidra quits keeps running
  (stop it with the agent's `bin/amctl quit`).
- Not verified: whether MusicKit in the page also reports play activity for plays that the
  engine reports.

## Licence and credits

Sidra is by Martin Wimpress and contributors; upstream's credits and its
[Blue Oak Model License 1.0.0](LICENSE) apply to this branch, including the changes it adds.
The agent repository is a separate project under its own licence.
