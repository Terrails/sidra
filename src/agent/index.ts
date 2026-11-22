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
import { commandPath } from "./commands";
import { isRefused, PORT, request, startService, STOREFRONT } from "./service";

const agentLog = log.scope("agent");
const DEBUG = Boolean(process.env.AM_WEBUI_DEBUG);
const POLL_MS = 250;

/** Playback always goes through the wrapper service in this build. */
export const AGENT_ENABLED = true;

/** The parts of the page hook, in the order they run (see assets/agent/hook.js). */
const AGENT_PARTS = ["link", "media", "musickit", "quality", "start"];

/**
 * The page hook (assets/agent/hook.js with its parts in place of the token, plus the
 * call that starts it) and its stylesheet. Every file belongs in asarUnpack.
 */
export function loadAgentAssets(): { css: string; script: string } {
  const read = (name: string): string =>
    fs.readFileSync(getAssetPath("assets", "agent", name), "utf-8");
  const parts = AGENT_PARTS.map((p) => read(`${p}.js`)).join("\n");
  const config = JSON.stringify({ storefront: STOREFRONT, debug: DEBUG });
  const script = `${read("hook.js").replace("__AGENT_PARTS__", () => parts)}
;window.__amAgentInit && window.__amAgentInit(${config});`;
  return { css: read("style.css"), script };
}

let getWindow: () => BrowserWindow | null = () => null;
let polling = false;

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  let state: Record<string, unknown> = { engine: "starting" };
  try {
    const reply = await request("GET", "/status", 15_000);
    if (reply.status === 200 && reply.json)
      state = { engine: "ready", ...reply.json };
  } catch (err: unknown) {
    if (isRefused(err)) startService();
  }
  polling = false;
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
 * Register the amAgent IPC and start polling the service. Call once, after the
 * main window exists. The service is left running on quit (wrapper/amctl quit stops it).
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
    try {
      return await playerCommand(String(cmd), arg);
    } catch (err: unknown) {
      return {
        ok: false,
        error: isRefused(err)
          ? "The player engine is not running yet."
          : errorMessage(err),
      };
    }
  });

  const onLog = (event: Electron.IpcMainEvent, line: unknown): void => {
    if (DEBUG && event.sender === liveWebContents(getWindow()))
      agentLog.info(`[hook] ${String(line).slice(0, 2000)}`);
  };
  ipcMain.on("agent:log", onLog);

  const timer = setInterval(() => void poll(), POLL_MS);
  app.on("will-quit", () => {
    clearInterval(timer);
    ipcMain.removeHandler("agent:cmd");
    ipcMain.removeListener("agent:log", onLog);
  });
  agentLog.info(`player service on 127.0.0.1:${PORT}`);
}
