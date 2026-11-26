// src/agent/index.ts: configure() (crossfade / autoplay set once per connection, retried when
// it fails), slow /status answers, and the autoplay restore at quit (and after a crash). The
// service and config modules are replaced; the settings are read when index.ts loads, so each
// test loads a fresh copy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("../src/agent/service", () => ({
  agentMissing: () => "missing",
  findAgent: () => null,
  isRefused: (e: unknown) => (e as { code?: string })?.code === "ECONNREFUSED",
  isTimeout: (e: unknown) => e instanceof Error && e.message === "timeout",
  PORT: 7654,
  request: requestMock,
  startFailure: () => null,
  startService: () => true,
  STOREFRONT: "us",
}));

/** The stored marker: Sidra turned the engine's autoplay off (survives a load(), like a crash). */
const marker = vi.hoisted(() => ({ off: false }));
vi.mock("../src/config", () => ({
  getAgentAutoplayOff: () => marker.off,
  setAgentAutoplayOff: (off: boolean) => (marker.off = off),
}));

const ENV = ["AM_WEBUI_CROSSFADE", "AM_WEBUI_SEAMLESS", "AM_WEBUI_KEEP_SERVICE"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const ok = (status = 200, json: Record<string, unknown> | null = { ok: true }) =>
  Promise.resolve({ status, json });
const refused = () => Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
const timeout = () => Promise.reject(new Error("timeout"));

/** A ready status; crossfade and autoplay as the engine has them. */
const status = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  engine: "ready",
  ready: true,
  crossfade: { on: true, seconds: 6 },
  autoplay: true,
  upNext: [],
  ...over,
});

const posts = (): string[] =>
  requestMock.mock.calls.filter((c) => c[0] === "POST").map((c) => c[1] as string);

async function load(env: Record<string, string> = {}) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import("../src/agent/index");
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  requestMock.mockReset();
  requestMock.mockImplementation(() => ok());
  marker.off = false;
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("configure", () => {
  it("turns autoplay off once when the engine's crossfade is on", async () => {
    const { configure } = await load();
    configure(status());
    await flush();
    configure(status());
    await flush();
    expect(posts()).toEqual(["/autoplay?on=0"]);
  });

  it("does not turn autoplay off with AM_WEBUI_CROSSFADE=0 although the engine's crossfade is on", async () => {
    const { configure } = await load({ AM_WEBUI_CROSSFADE: "0" });
    configure(status());
    await flush();
    configure(status({ crossfade: { on: false, seconds: 6 } }));
    await flush();
    expect(posts()).toEqual(["/crossfade?on=0"]);
  });

  it("sets crossfade first and autoplay after, with the crossfade just set", async () => {
    const { configure } = await load({ AM_WEBUI_CROSSFADE: "8" });
    configure(status({ crossfade: { on: false, seconds: 6 } }));
    await flush();
    expect(posts()).toEqual(["/crossfade?on=1&s=8"]);
    configure(status({ crossfade: { on: false, seconds: 6 } })); // status not updated yet
    await flush();
    expect(posts()).toEqual(["/crossfade?on=1&s=8", "/autoplay?on=0"]);
  });

  it("leaves autoplay alone with AM_WEBUI_SEAMLESS=0 or when it is off already", async () => {
    let m = await load({ AM_WEBUI_SEAMLESS: "0" });
    m.configure(status());
    await flush();
    m = await load();
    m.configure(status({ autoplay: false }));
    await flush();
    expect(posts()).toEqual([]);
  });

  it("leaves a service without these settings alone", async () => {
    const { configure } = await load({ AM_WEBUI_CROSSFADE: "5" });
    configure({ engine: "ready", ready: true });
    configure(status({ crossfade: { on: false, seconds: 0 }, autoplay: undefined, upNext: undefined }));
    await flush();
    expect(posts()).toEqual([]);
  });

  it("sets everything again after the connection was lost", async () => {
    const { configure } = await load();
    configure(status());
    await flush();
    configure({ engine: "starting" });
    configure(status());
    await flush();
    expect(posts()).toEqual(["/autoplay?on=0", "/autoplay?on=0"]);
  });

  it("retries a failed or non-2xx request a bounded number of times, spaced apart", async () => {
    requestMock.mockImplementation(() => Promise.reject(new Error("boom")));
    const { configure } = await load();
    const poll = async (): Promise<void> => {
      configure(status());
      await flush();
    };
    await poll();
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(250); // the poll interval
      await poll();
    }
    expect(posts()).toHaveLength(3);
    requestMock.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    await poll();
    expect(posts()).toEqual([]);
  });

  it("waits for the crossfade request, and goes by the engine's crossfade once it was given up", async () => {
    requestMock.mockImplementation((_m: string, p: string) =>
      p.startsWith("/crossfade") ? ok(500, null) : ok(),
    );
    const { configure } = await load({ AM_WEBUI_CROSSFADE: "8" });
    for (let i = 0; i < 2; i++) {
      configure(status());
      await flush();
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(posts()).toEqual(["/crossfade?on=1&s=8", "/crossfade?on=1&s=8"]);
    configure(status());
    await flush();
    configure(status());
    await flush();
    expect(posts().slice(2)).toEqual(["/crossfade?on=1&s=8", "/autoplay?on=0"]);
  });

  it("does not send a setting again while its request is under way", async () => {
    requestMock.mockImplementation(() => new Promise(() => {}));
    const { configure } = await load();
    configure(status());
    await vi.advanceTimersByTimeAsync(20_000);
    configure(status());
    expect(posts()).toEqual(["/autoplay?on=0"]);
  });

  it("stops retrying once a request succeeds", async () => {
    requestMock.mockImplementationOnce(() => ok(500, null));
    const { configure } = await load();
    configure(status());
    await flush();
    configure(status()); // too early for a retry
    await flush();
    expect(posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    configure(status());
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    configure(status());
    await flush();
    expect(posts()).toEqual(["/autoplay?on=0", "/autoplay?on=0"]);
  });

  it("ignores the answer of a lost connection", async () => {
    let resolve!: (v: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const { configure } = await load();
    configure(status());
    configure({ engine: "starting" });
    resolve({ status: 200, json: {} });
    await flush();
    configure(status());
    await flush();
    expect(posts()).toEqual(["/autoplay?on=0", "/autoplay?on=0"]);
  });

  it("does not take a lost connection's crossfade for the new one's", async () => {
    let resolve!: (v: unknown) => void;
    requestMock.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    requestMock.mockImplementation(() => ok(500, null));
    const { configure } = await load({ AM_WEBUI_CROSSFADE: "8" });
    const off = status({ crossfade: { on: false, seconds: 6 } });
    configure(off);
    configure({ engine: "starting" });
    configure(off);
    resolve({ status: 200, json: {} });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5000);
      configure(off);
    }
    // the new connection's attempts all failed: crossfade is off, so autoplay stays
    expect(posts()).toEqual(Array(4).fill("/crossfade?on=1&s=8"));
  });

  it("does not count crossfade as given up while its last request is under way", async () => {
    requestMock.mockImplementationOnce(() => ok(500)).mockImplementationOnce(() => ok(500));
    requestMock.mockImplementation(() => new Promise(() => {}));
    const { configure } = await load({ AM_WEBUI_CROSSFADE: "0" });
    for (let i = 0; i < 4; i++) {
      configure(status());
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(posts()).toEqual(Array(3).fill("/crossfade?on=0"));
  });
});

describe("poll", () => {
  const answer = (...steps: (() => Promise<unknown>)[]) => {
    for (const s of steps) requestMock.mockImplementationOnce(s);
  };
  const ready = () => ok(200, { ready: true, crossfade: { on: false, seconds: 6 } });

  it("reports a hung engine as lost after a bound, and sets up again", async () => {
    const { poll } = await load({ AM_WEBUI_CROSSFADE: "5" });
    answer(ready);
    await poll();
    await flush();
    answer(timeout);
    await poll(); // held
    await vi.advanceTimersByTimeAsync(61_000);
    answer(timeout);
    await poll(); // too long: starting, which resets
    answer(ready);
    await poll();
    await flush();
    expect(posts()).toEqual(["/crossfade?on=1&s=5", "/crossfade?on=1&s=5"]);
  });

  it("resets on a refused connection", async () => {
    const { poll } = await load({ AM_WEBUI_CROSSFADE: "5" });
    answer(ready);
    await poll();
    await flush();
    answer(refused, ready);
    await poll(); // refused: reset
    await poll();
    await flush();
    expect(posts()).toEqual(["/crossfade?on=1&s=5", "/crossfade?on=1&s=5"]);
  });

  it("does not reset on a timeout", async () => {
    const { poll } = await load({ AM_WEBUI_CROSSFADE: "5" });
    answer(ready);
    await poll();
    await flush();
    answer(timeout, ready);
    await poll();
    await poll();
    await flush();
    expect(posts()).toEqual(["/crossfade?on=1&s=5"]);
  });
});

describe("poll and the page", () => {
  it("sends no status while a slow one is held, but says so when there was no connection", async () => {
    const { initAgent } = await load();
    const sent: unknown[] = [];
    const contents = {
      isDestroyed: () => false,
      send: (_c: string, s: { engine: string }) => sent.push(s.engine),
    };
    initAgent((() => ({ isDestroyed: () => false, webContents: contents })) as never);
    const step = async (how: () => Promise<unknown>): Promise<void> => {
      requestMock.mockImplementationOnce(how);
      await vi.advanceTimersByTimeAsync(250);
    };
    await step(timeout);
    expect(sent).toEqual(["starting"]);
    await step(() => ok(200, { ready: true }));
    await step(timeout);
    expect(sent).toEqual(["starting", "ready"]);
    // answered, then slow again much later: a new hold, not the end of the old one
    await step(() => ok(200, { ready: true }));
    vi.setSystemTime(Date.now() + 61_000);
    await step(timeout);
    expect(sent).toEqual(["starting", "ready", "ready"]);
  });
});

describe("autoplay after a crash", () => {
  it("marks autoplay as turned off from the request on", async () => {
    requestMock.mockImplementationOnce(timeout);
    const { configure } = await load();
    configure(status());
    await flush();
    expect(marker.off).toBe(true);
  });

  it("turns it back on at the next start when that start does not turn it off", async () => {
    marker.off = true;
    let m = await load({ AM_WEBUI_CROSSFADE: "0" });
    m.configure(status({ crossfade: { on: false, seconds: 6 }, autoplay: false }));
    await flush();
    m.configure(status({ crossfade: { on: false, seconds: 6 }, autoplay: false })); // status not updated yet
    await flush();
    expect(posts()).toEqual(["/autoplay?on=1"]);
    expect(marker.off).toBe(true); // cleared by a status that shows it on
    m.configure(status({ crossfade: { on: false, seconds: 6 }, autoplay: true }));
    expect(marker.off).toBe(false);
    marker.off = true;
    m = await load({ AM_WEBUI_SEAMLESS: "0" });
    m.configure(status({ autoplay: false }));
    await flush();
    m.configure(status({ autoplay: true }));
    expect(posts()).toEqual(["/autoplay?on=1", "/autoplay?on=1"]);
    expect(marker.off).toBe(false);
  });

  it("keeps the mark while the restore is pending (202: nothing played yet)", async () => {
    marker.off = true;
    requestMock.mockImplementation(() => ok(202, { ok: true, autoplay: false, pending: true }));
    const { configure } = await load({ AM_WEBUI_SEAMLESS: "0" });
    configure(status({ autoplay: false }));
    await flush();
    configure(status({ autoplay: false }));
    await flush();
    expect(posts()).toEqual(["/autoplay?on=1"]); // accepted: not sent again
    expect(marker.off).toBe(true);
    configure(status({ autoplay: true })); // something played
    expect(marker.off).toBe(false);
  });

  it("waits for the crossfade being set before it decides", async () => {
    marker.off = true;
    const { configure } = await load({ AM_WEBUI_CROSSFADE: "0" });
    configure(status({ autoplay: false })); // crossfade still on in the engine
    await flush();
    expect(posts()).toEqual(["/crossfade?on=0"]);
    configure(status({ crossfade: { on: false, seconds: 6 }, autoplay: false }));
    await flush();
    expect(posts()).toEqual(["/crossfade?on=0", "/autoplay?on=1"]);
  });

  it("keeps the mark while the restore fails, and drops it when autoplay is on anyway", async () => {
    marker.off = true;
    requestMock.mockImplementation(() => ok(500));
    const { configure } = await load({ AM_WEBUI_SEAMLESS: "0" });
    configure(status({ autoplay: false }));
    await flush();
    expect(posts()).toEqual(["/autoplay?on=1"]);
    expect(marker.off).toBe(true);
    configure(status({ autoplay: true }));
    await flush();
    expect(posts()).toEqual(["/autoplay?on=1"]);
    expect(marker.off).toBe(false);
  });

  it("restores it at quit when the next start keeps it off", async () => {
    marker.off = true;
    const { configure, stopEngine } = await load();
    configure(status({ autoplay: false }));
    await flush();
    expect(posts()).toEqual([]);
    await stopEngine();
    expect(posts()).toEqual(["/stop", "/autoplay?on=1", "/quit"]);
    expect(marker.off).toBe(false);
  });

  it("keeps the mark when the restore at quit is only pending", async () => {
    const { configure, stopEngine } = await load();
    configure(status());
    await flush();
    requestMock.mockImplementation((_m: string, p: string) =>
      p === "/autoplay?on=1" ? ok(202, { ok: true, autoplay: false, pending: true }) : ok(),
    );
    await stopEngine();
    expect(posts()).toEqual(["/autoplay?on=0", "/stop", "/autoplay?on=1", "/quit"]);
    expect(marker.off).toBe(true);
  });

  it("keeps the mark when the restore at quit fails", async () => {
    const { configure, stopEngine } = await load();
    configure(status());
    await flush();
    requestMock.mockImplementation((_m: string, p: string) => (p === "/autoplay?on=1" ? ok(500) : ok()));
    await stopEngine();
    expect(marker.off).toBe(true);
  });
});

describe("stopEngine", () => {
  it("keeps the quit budget when the engine hangs", async () => {
    const { configure, stopEngine } = await load();
    configure(status());
    await flush();
    requestMock.mockClear();
    requestMock.mockImplementation(
      (_m: string, _p: string, ms: number) =>
        new Promise((_r, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
    );
    let done = false;
    void stopEngine().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(3000);
    expect(done).toBe(true);
    expect(posts()).toEqual(["/stop", "/autoplay?on=1", "/quit"]);
    expect(requestMock.mock.calls[2][2]).toBe(2000); // the quit keeps two thirds
  });

  it("restores autoplay although the request that turned it off got no answer", async () => {
    requestMock.mockImplementationOnce(timeout);
    const { configure, stopEngine } = await load();
    configure(status());
    await flush();
    await stopEngine();
    expect(posts()).toEqual(["/autoplay?on=0", "/stop", "/autoplay?on=1", "/quit"]);
  });

  it("refuses page commands and quits once while the engine is being stopped", async () => {
    vi.resetModules();
    const { app, ipcMain } = await import("electron");
    vi.mocked(app.on).mockClear();
    vi.mocked(ipcMain.handle).mockClear();
    vi.mocked(app.quit).mockClear();
    const { initAgent } = await load();
    const contents = {
      isDestroyed: () => false,
      send: () => {},
      mainFrame: { url: "https://music.apple.com/us/new" },
    };
    initAgent((() => ({ isDestroyed: () => false, webContents: contents })) as never);
    const cmd = vi.mocked(ipcMain.handle).mock.calls[0][1];
    const event = { sender: contents, senderFrame: contents.mainFrame } as never;
    expect(await cmd(event, "pause", {})).toMatchObject({ ok: true }); // allowed before the quit
    let release!: () => void;
    requestMock.mockImplementation(() => new Promise((r) => (release = () => r({ status: 200, json: {} }))));
    const quit = vi.mocked(app.on).mock.calls.find((c) => (c[0] as string) === "before-quit")![1] as (
      e: unknown,
    ) => void;
    requestMock.mockClear();
    const e = { preventDefault: vi.fn() };
    quit(e);
    quit(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(2);
    expect(await cmd(event, "resume", {})).toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(1000); // no poll either
    expect(requestMock.mock.calls.map((c) => c[1])).toEqual(["/quit"]);
    release();
    await flush();
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("only quits when Sidra did not turn autoplay off", async () => {
    const { stopEngine } = await load();
    await stopEngine();
    expect(posts()).toEqual(["/quit"]);
  });

  it("turns autoplay back on after the stop and before the quit", async () => {
    const { configure, stopEngine } = await load();
    configure(status());
    await flush();
    requestMock.mockClear();
    await stopEngine();
    expect(posts()).toEqual(["/stop", "/autoplay?on=1", "/quit"]);
  });

  it("does the same with AM_WEBUI_KEEP_SERVICE, and quits anyway when the restore fails", async () => {
    const { configure, stopEngine } = await load({ AM_WEBUI_KEEP_SERVICE: "1" });
    configure(status());
    await flush();
    requestMock.mockClear();
    requestMock.mockImplementation((_m: string, p: string) =>
      p.startsWith("/autoplay") ? Promise.reject(new Error("boom")) : ok(),
    );
    await stopEngine();
    expect(posts()).toEqual(["/stop", "/autoplay?on=1", "/stop"]);
  });

  it("leaves autoplay alone when the engine's was off already", async () => {
    const { configure, stopEngine } = await load();
    configure(status({ autoplay: false }));
    await flush();
    await stopEngine();
    expect(posts()).toEqual(["/quit"]);
  });
});
