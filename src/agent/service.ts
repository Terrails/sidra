/**
 * Connection to the wrapper service (bin/amd of wine-engine-for-apple-music,
 * AMPLibraryAgent under Wine): the token, starting the service, and requests to its
 * local API. The token stays in this process; the page never sees it.
 */
import { spawn, type ChildProcess } from "child_process";
import { app } from "electron";
import log from "electron-log/main";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { errorMessage } from "../utils";

const agentLog = log.scope("agent");

const AGENT_REPO = "wine-engine-for-apple-music";
// The agent's own default (bin/amd-env.sh): its Wine prefix under XDG_DATA_HOME.
const PREFIX =
  process.env.AM_PREFIX ||
  path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    AGENT_REPO,
    "prefix",
  );
const DEFAULT_PORT = 7654;
const DEFAULT_STOREFRONT = "us";

/** AM_PORT: an integer from 1 to 65535, else the default (with a warning). */
function portSetting(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const port = /^\d{1,5}$/.test(raw.trim()) ? Number(raw.trim()) : 0;
  if (port >= 1 && port <= 65535) return port;
  agentLog.warn(
    `AM_PORT=${JSON.stringify(raw.slice(0, 40))} is not a port from 1 to 65535: using ${DEFAULT_PORT}`,
  );
  return DEFAULT_PORT;
}

/**
 * AM_STOREFRONT: a two-letter country code (any case), else the default (with a warning).
 * Only Sidra's own fallback for album links; the service gets the environment unchanged.
 */
function storefrontSetting(raw: string | undefined): string {
  if (!raw) return DEFAULT_STOREFRONT;
  const code = raw.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(code)) return code;
  agentLog.warn(
    `AM_STOREFRONT=${JSON.stringify(raw.slice(0, 40))} is not a two-letter country code: album links use "${DEFAULT_STOREFRONT}"`,
  );
  return DEFAULT_STOREFRONT;
}

export const PORT = portSetting(process.env.AM_PORT);
export const STOREFRONT = storefrontSetting(process.env.AM_STOREFRONT);
/** After a start that failed, the next attempt waits this long. */
const RETRY_MS = 25_000;

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Why an executable `amd` is not the agent's bin/amd ("" when it is): the agent's start
 * script has bin/amd-env.sh next to it (after symlinks), an unrelated `amd` (the
 * am-utils automounter, say) does not.
 */
function notTheAgent(file: string): string {
  try {
    const real = fs.realpathSync(file);
    if (fs.statSync(path.join(path.dirname(real), "amd-env.sh")).isFile())
      return "";
    return `${real} has no amd-env.sh next to it, so it is not the bin/amd of ${AGENT_REPO}`;
  } catch {
    return `${file} has no amd-env.sh next to it, so it is not the bin/amd of ${AGENT_REPO}`;
  }
}

/** findAgent() with the reasons why candidates were left out (for Sidra's log only). */
function lookupAgent(): { file: string | null; why: string[] } {
  const dir = process.env.AM_AGENT_DIR;
  if (dir) {
    const file = path.join(dir, "bin", "amd");
    if (!isExecutable(file))
      return { file: null, why: [`${file} does not exist or is not executable`] };
    const why = notTheAgent(file);
    return why ? { file: null, why: [why] } : { file, why: [] };
  }
  const why: string[] = [];
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const file = path.join(entry, "amd");
    if (!isExecutable(file)) continue;
    const reason = notTheAgent(file);
    if (!reason) return { file, why };
    why.push(reason);
  }
  return { file: null, why };
}

/**
 * The service's start script: $AM_AGENT_DIR/bin/amd when AM_AGENT_DIR is set,
 * else an `amd` command on PATH (bin/ linked into ~/.local/bin, say). Either must
 * have bin/amd-env.sh next to it. Null when there is none; agentMissing() then says why.
 */
export function findAgent(): string | null {
  return lookupAgent().file;
}

/**
 * Why findAgent() found nothing, for the page (no paths: the page is music.apple.com's).
 * Sidra's log gets the paths as well (startService()).
 */
export function agentMissing(): string {
  return process.env.AM_AGENT_DIR
    ? `The player service was not found: AM_AGENT_DIR does not point to a checkout of ${AGENT_REPO} with bin/amd (see Sidra's log).`
    : `The player service was not found: set AM_AGENT_DIR to a checkout of ${AGENT_REPO}, or put its bin/amd on PATH.`;
}

export interface ServiceReply {
  status: number;
  json: Record<string, unknown> | null;
}

let token = "";
let rejectedLogged = false;

function readToken(): string {
  try {
    const users = path.join(PREFIX, "drive_c", "users");
    for (const user of fs.readdirSync(users)) {
      const file = path.join(
        users,
        user,
        "AppData",
        "Local",
        "AppleMusicWrapper",
        "token",
      );
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
    }
  } catch {
    // The prefix does not exist yet.
  }
  return "";
}

let missingLogged = false;
/** The service Sidra started, while it runs (bin/amd stays in the foreground). */
let child: ChildProcess | null = null;
let exitedAt = 0;
/** For the page after a start failed, until the service answers. */
let failure: string | null = null;
/** The service has answered since the last start: a later exit is not a failed start. */
let answered = false;

/** Why the last start failed (for the page, no paths), or null. */
export function startFailure(): string | null {
  return failure;
}

function failed(message: string, detail: string): void {
  failure = message;
  agentLog.error(`${detail}; bin/amd's output: ${startLog()}`);
}

/** bin/amd's own output (setup errors, the build); the service itself logs to amd.log in AM_LOG_DIR. */
const startLog = (): string => path.join(app.getPath("logs"), "amd-start.log");

/**
 * Start the service in the background (it outlives Sidra), unless the one started
 * before is still running; after a failed start, again RETRY_MS later. Returns false
 * when the service cannot be found (logged once, see agentMissing()).
 */
export function startService(): boolean {
  if (process.env.AM_WEBUI_NO_SPAWN) return true;
  const { file: agent, why } = lookupAgent();
  if (!agent) {
    if (!missingLogged) agentLog.error([agentMissing(), ...why].join(" "));
    missingLogged = true;
    return false;
  }
  missingLogged = false;
  if (child) return true; // still starting (or running on another port)
  if (failure && Date.now() - exitedAt < RETRY_MS) return true;
  agentLog.info(`starting the player service (${agent})`);
  let out: number | "ignore" = "ignore";
  try {
    fs.mkdirSync(path.dirname(startLog()), { recursive: true });
    out = fs.openSync(startLog(), "w");
  } catch (err: unknown) {
    agentLog.warn(`cannot write ${startLog()}: ${errorMessage(err)}`);
  }
  let started: ChildProcess;
  try {
    // The environment goes through unchanged (AM_STOREFRONT, AM_LOG_DIR, ...); AM_PREFIX
    // is the prefix Sidra reads the token from.
    started = spawn(agent, [String(PORT)], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, AM_PREFIX: PREFIX },
    });
  } finally {
    if (typeof out === "number") fs.closeSync(out);
  }
  child = started;
  answered = false;
  const ended = (): void => {
    if (child === started) child = null;
    exitedAt = Date.now();
  };
  started.on("error", (err) => {
    ended();
    failed(
      "The player service could not be started (see Sidra's log).",
      `player service failed to start: ${errorMessage(err)}`,
    );
  });
  started.on("exit", (code, signal) => {
    ended();
    if (code === 0) agentLog.info("the player service exited");
    else if (code === null || answered)
      agentLog.warn(
        `the player service stopped (${code === null ? String(signal) : `code ${code}`})`,
      );
    else
      failed(
        `The player service exited with code ${code} (see Sidra's log).`,
        `the player service exited with code ${code}`,
      );
  });
  started.unref();
  return true;
}

function call(
  method: string,
  urlPath: string,
  timeoutMs: number,
): Promise<ServiceReply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path: urlPath,
        timeout: timeoutMs,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          let json: Record<string, unknown> | null = null;
          try {
            const parsed: unknown = JSON.parse(body);
            if (parsed && typeof parsed === "object")
              json = parsed as Record<string, unknown>;
          } catch {
            // Not JSON: the status code carries the answer.
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** One API request; re-reads the token once when the service was restarted. */
export async function request(
  method: string,
  urlPath: string,
  timeoutMs: number,
): Promise<ServiceReply> {
  if (!token) token = readToken();
  let reply = await call(method, urlPath, timeoutMs);
  if (reply.status === 401) {
    // The service was restarted and wrote a new token.
    token = readToken();
    reply = await call(method, urlPath, timeoutMs);
  }
  failure = null; // the service answers
  answered = true;
  if (reply.status === 401 && !rejectedLogged)
    agentLog.warn(
      `the player service rejects the token in ${PREFIX}: AM_PREFIX must name the prefix of the running service`,
    );
  rejectedLogged = reply.status === 401;
  return reply;
}

export const isRefused = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === "ECONNREFUSED";
