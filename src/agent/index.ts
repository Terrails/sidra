/**
 * Playback through the wrapper service (bin/amd of wine-engine-for-apple-music,
 * AMPLibraryAgent under Wine) instead of the browser. The page hook (assets/agent/)
 * swaps MusicKit's audio element for one that forwards to this module, so the queue,
 * the transport bar and every Sidra integration keep working at the MusicKit level.
 * The page only gets the narrow amAgent bridge (src/preload.ts).
 *
 *   service.ts   token, starting the service, API requests
 *   commands.ts  page commands -> API paths (validated)
 *   index.ts     IPC, status polling, the page script
 */
import { app, ipcMain, type BrowserWindow } from "electron";
import log from "electron-log/main";
import fs from "fs";
import { isAllowedNavigationUrl } from "../musicService";
import { getAssetPath } from "../paths";
import { errorMessage, liveWebContents } from "../utils";
import { commandPath, crossfadeSetting } from "./commands";
import {
  agentMissing,
  findAgent,
  isRefused,
  PORT,
  request,
  startFailure,
  startService,
  STOREFRONT,
} from "./service";

const agentLog = log.scope("agent");
const DEBUG = Boolean(process.env.AM_WEBUI_DEBUG);
const POLL_MS = 250;
/** AM_WEBUI_KEEP_SERVICE=1 (scripts/run-with-agent.sh --keep-service): on quit only stop playback. */
const KEEP_SERVICE = Boolean(process.env.AM_WEBUI_KEEP_SERVICE);
/** AM_WEBUI_MIXED_QUEUE=1: queue lists of songs and music videos in order (mixedQueueFix()). */
const MIXED_QUEUE = Boolean(process.env.AM_WEBUI_MIXED_QUEUE);
/** AM_WEBUI_UNRESTRICT=1: turn MusicKit's explicit-content restriction off (unrestrict()). */
const UNRESTRICT = process.env.AM_WEBUI_UNRESTRICT === "1";
/** A Shuffle button on Library > Songs for the whole library (shuffle.js); AM_WEBUI_LIBRARY_SHUFFLE=0 turns it off. */
const LIBRARY_SHUFFLE = process.env.AM_WEBUI_LIBRARY_SHUFFLE !== "0";
/**
 * Seamless transitions (seamless.js): MusicKit's next song is queued in the engine before the
 * end, so the engine goes on gapless (or with crossfade). Only with a service that has the
 * queue API (status.upNext); AM_WEBUI_SEAMLESS=0 turns it off.
 */
const SEAMLESS = process.env.AM_WEBUI_SEAMLESS !== "0";
/** AM_WEBUI_CROSSFADE: unset leaves the engine's setting, 0 off, 1 to 12 seconds (crossfadeSetting()). */
const CROSSFADE = ((): ReturnType<typeof crossfadeSetting> => {
  try {
    return crossfadeSetting(process.env.AM_WEBUI_CROSSFADE);
  } catch (err: unknown) {
    agentLog.warn(`${errorMessage(err)}: leaving the engine's setting`);
    return null;
  }
})();
const QUIT_WAIT_MS = 3000;

/**
 * Playback goes through the Wine engine's service unless AM_WEBUI_AGENT=0: then no hook is
 * injected, the wedge detector stays on and no service is started, as in upstream Sidra.
 */
export const AGENT_ENABLED = process.env.AM_WEBUI_AGENT !== "0";

/** The parts of the page hook, in the order they run (see assets/agent/hook.js). */
const AGENT_PARTS = ["link", "media", "musickit", "seamless", "quality", "shuffle", "start"];

/**
 * The page hook (assets/agent/hook.js with its parts in place of the token, plus the
 * call that starts it) and its stylesheet. Every file belongs in asarUnpack.
 */
export function loadAgentAssets(): { css: string; script: string } {
  const read = (name: string): string =>
    fs.readFileSync(getAssetPath("assets", "agent", name), "utf-8");
  const parts = AGENT_PARTS.map((p) => read(`${p}.js`)).join("\n");
  const config = JSON.stringify({ storefront: STOREFRONT, debug: DEBUG, unrestrict: UNRESTRICT, mixedQueue: MIXED_QUEUE, libraryShuffle: LIBRARY_SHUFFLE, seamless: SEAMLESS });
  const script = `${read("hook.js").replace("__AGENT_PARTS__", () => parts)}
;window.__amAgentInit && window.__amAgentInit(${config});`;
  return { css: read("style.css"), script };
}

let getWindow: () => BrowserWindow | null = () => null;
let polling = false;
let quitting = false;
let lastStatus: Record<string, unknown> = {};

/**
 * A page that is reloaded or replaced loses its queue and its AgentMedia, but the
 * engine would play on (and continue with its own autoplay), so onDocumentReplaced()
 * pauses it. One player at a time is assumed: whatever the engine plays is the page's.
 *   loading    the last song the page started while the engine has not shown it playing
 *   abandoned  a song that was still loading when its document went away (or whose
 *              play succeeded only afterwards): it starts after the page is gone, so
 *              it is paused when it does (once, within ABANDON_MS)
 */
const ABANDON_MS = 20_000;
let documentGen = 0;
let loading: string | null = null;
let abandoned: { song: string; until: number; pausedAt: number } | null = null;

const songIdOf = (state: Record<string, unknown>): string | null => {
  const np = state.nowPlaying as Record<string, unknown> | null | undefined;
  return np?.songId ? String(np.songId) : null;
};

function pauseAbandoned(song: string | null): void {
  agentLog.info(`page replaced: pausing the track it started (${song ?? "?"})`);
  request("POST", "/pause", 10_000).catch((err: unknown) =>
    agentLog.warn(`pause after page replacement failed: ${errorMessage(err)}`),
  );
}

function checkAbandoned(state: Record<string, unknown>): void {
  const a = abandoned;
  if (!a) return;
  const now = Date.now();
  if (now > a.until) {
    abandoned = null;
    return;
  }
  if (state.engine !== "ready") return;
  const id = songIdOf(state);
  if (id && id !== a.song) return; // still the previous track
  if (state.playing !== true) {
    if (a.pausedAt) abandoned = null; // our pause arrived: done
    return;
  }
  if (now - a.pausedAt < 1500) return; // the last pause has not shown up yet
  a.pausedAt = now;
  pauseAbandoned(a.song);
}

function abandon(song: string): void {
  abandoned = { song, until: Date.now() + ABANDON_MS, pausedAt: 0 };
  checkAbandoned(lastStatus);
}

/**
 * Call on a committed main-frame navigation (did-navigate: a new document, not an
 * in-page one). Pauses the engine, also a track that is still loading.
 */
export function onDocumentReplaced(): void {
  documentGen += 1;
  const pending = loading;
  loading = null;
  if (lastStatus.playing === true) pauseAbandoned(songIdOf(lastStatus));
  if (pending) abandon(pending);
}

/**
 * Once the service is ready (at start-up and after it was restarted): crossfade as
 * AM_WEBUI_CROSSFADE says, once the engine's playback settings exist (seconds 0 before),
 * and with seamless transitions plus crossfade on, the engine's own autoplay off (MusicKit's
 * autoplay fills the queue; an engine that crossfades would fade into an unrelated track
 * before Sidra can pause it). Each at most once per connection. A service without these
 * settings (no crossfade / autoplay in its status) is left alone.
 */
const configured = { crossfade: false, autoplay: false };

function configure(state: Record<string, unknown>): void {
  if (state.engine !== "ready" || state.ready !== true) {
    configured.crossfade = configured.autoplay = false;
    return;
  }
  const want: string[] = [];
  const xf = state.crossfade as { on?: unknown; seconds?: unknown } | undefined;
  const settings = !!xf && typeof xf === "object" && typeof xf.seconds === "number" && xf.seconds > 0;
  if (CROSSFADE && settings && !configured.crossfade) {
    configured.crossfade = true;
    if (
      xf.on !== CROSSFADE.on ||
      (CROSSFADE.seconds !== null && xf.seconds !== CROSSFADE.seconds)
    )
      want.push(
        `/crossfade?on=${CROSSFADE.on ? 1 : 0}${CROSSFADE.seconds !== null ? `&s=${CROSSFADE.seconds}` : ""}`,
      );
  }
  // the crossfade as it is about to be: what was just asked for, else the engine's
  const fadeOn = CROSSFADE ? CROSSFADE.on : xf?.on === true;
  if (
    SEAMLESS &&
    !configured.autoplay &&
    settings &&
    fadeOn &&
    state.autoplay === true &&
    Array.isArray(state.upNext)
  ) {
    configured.autoplay = true;
    want.push("/autoplay?on=0");
  }
  for (const p of want)
    request("POST", p, 10_000)
      .then((reply) =>
        agentLog.info(`POST ${p} -> HTTP ${reply.status}`),
      )
      .catch((err: unknown) =>
        agentLog.warn(`POST ${p} failed: ${errorMessage(err)}`),
      );
}

async function poll(): Promise<void> {
  if (polling || quitting) return;
  polling = true;
  let state: Record<string, unknown> = { engine: "starting" };
  try {
    const reply = await request("GET", "/status", 15_000);
    if (reply.status === 200 && reply.json)
      state = { engine: "ready", ...reply.json };
  } catch (err: unknown) {
    // No service to start, or its start failed: the page shows why (the badge next to
    // the quality button).
    if (isRefused(err) && !quitting) {
      if (!startService()) state = { engine: "missing", error: agentMissing() };
      else if (startFailure())
        state = { engine: "failed", error: startFailure() };
    }
  }
  polling = false;
  if (quitting) return;
  lastStatus = state;
  if (loading && state.playing === true) {
    const id = songIdOf(state);
    if (!id || id === loading) loading = null;
  }
  checkAbandoned(state);
  configure(state);
  liveWebContents(getWindow())?.send("agent:status", state);
}

async function playerCommand(
  cmd: string,
  arg: unknown,
): Promise<Record<string, unknown>> {
  const fields =
    arg && typeof arg === "object" ? (arg as Record<string, unknown>) : {};
  const reply = await request("POST", await commandPath(cmd, fields), 70_000);
  setTimeout(() => void poll(), 100);
  return reply.json ?? { ok: false, error: `HTTP ${reply.status}` };
}

/**
 * On quit, playback ends with Sidra: the service is asked to quit (it stops the
 * engine first), or with AM_WEBUI_KEEP_SERVICE only to stop. One player at a time
 * is assumed: this also stops what amctl or another client started.
 * Waits up to QUIT_WAIT_MS (a hung engine does not keep Sidra open).
 */
async function stopEngine(): Promise<void> {
  const what = KEEP_SERVICE ? "/stop" : "/quit";
  try {
    const reply = await request("POST", what, QUIT_WAIT_MS);
    agentLog.info(`quit: POST ${what} -> HTTP ${reply.status}`);
  } catch (err: unknown) {
    if (!isRefused(err))
      agentLog.warn(`quit: POST ${what} failed: ${errorMessage(err)}`);
  }
}

/**
 * Register the amAgent IPC and start polling the service. Call once, after the
 * main window exists. Quitting Sidra stops playback and the service (stopEngine()).
 */
export function initAgent(getMainWindow: () => BrowserWindow | null): void {
  getWindow = getMainWindow;

  ipcMain.handle("agent:cmd", async (event, cmd: unknown, arg: unknown) => {
    const contents = liveWebContents(getWindow());
    if (
      !contents ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      !isAllowedNavigationUrl(event.senderFrame.url)
    ) {
      return { ok: false, error: "not allowed" };
    }
    const name = String(cmd);
    const gen = documentGen;
    try {
      const reply = await playerCommand(name, arg);
      if (name === "play" && reply.ok) {
        const song = String((arg as { song?: unknown }).song);
        if (gen !== documentGen) {
          abandon(song); // its document is gone already
        } else {
          loading = song;
          abandoned = null; // the new page plays: leave the engine to it
        }
      }
      return reply;
    } catch (err: unknown) {
      return {
        ok: false,
        error: !isRefused(err)
          ? errorMessage(err)
          : !process.env.AM_WEBUI_NO_SPAWN && !findAgent()
            ? agentMissing()
            : (startFailure() ?? "The player engine is not running yet."),
      };
    }
  });

  const onLog = (event: Electron.IpcMainEvent, line: unknown): void => {
    if (DEBUG && event.sender === liveWebContents(getWindow()))
      agentLog.info(`[hook] ${String(line).slice(0, 2000)}`);
  };
  ipcMain.on("agent:log", onLog);

  const timer = setInterval(() => void poll(), POLL_MS);
  let engineStopped = false;
  app.on("before-quit", (event) => {
    if (engineStopped) return;
    event.preventDefault(); // quit again once the engine is stopped
    if (quitting) return;
    quitting = true;
    clearInterval(timer);
    void stopEngine().finally(() => {
      engineStopped = true;
      app.quit();
    });
  });
  app.on("will-quit", () => {
    clearInterval(timer);
    ipcMain.removeHandler("agent:cmd");
    ipcMain.removeListener("agent:log", onLog);
  });
  agentLog.info(`player service on 127.0.0.1:${PORT}`);
}
