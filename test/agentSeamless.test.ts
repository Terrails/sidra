// assets/agent/: the hand-over between two engine-played queue items (seamless.js with
// media.js). The page parts run in one closure, as src/agent/index.ts assembles them, with a
// stand-in bridge, a stand-in MusicKit queue and fake timers; statuses are pushed by hand.
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PARTS = ["link", "media", "musickit", "seamless", "start"];
const code = PARTS.map((p) =>
  fs.readFileSync(path.join(__dirname, "..", "assets", "agent", `${p}.js`), "utf-8"),
).join("\n");

interface Item {
  id: string;
  type: string;
  title: string;
  playbackDuration: number;
  attributes: { url: string; name: string };
  playParams: { id: string };
}
interface Job { song: string; album: string; cc: string }
interface Media extends EventTarget {
  src: string;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
}
interface Page {
  media: Media;
  seam: { enq: unknown; handoff: unknown; stale: unknown[]; off: boolean };
  jobFor(item: Item): Job;
  setMk(mk: unknown): void;
}
type Reply = Record<string, unknown>;
type Status = Record<string, unknown>;

const song = (id: string, durMs: number): Item => ({
  id, type: "songs", title: `Track ${id}`, playbackDuration: durMs,
  attributes: { url: `https://music.apple.com/gb/album/x/77?i=${id}`, name: `Track ${id}` },
  playParams: { id },
});

let page: Page;
let onStatus: (s: Status) => void;
let cmds: [string, Record<string, unknown>][];
let replies: Record<string, (arg: Record<string, unknown>) => Reply>;
let mk: { queue: { items: Item[]; position: number; currentItem?: Item; nextPlayableItem?: Item }; repeatMode: number; continuous: boolean };
let ended: number;

function load(seamless = true): void {
  const bridge = {
    cmd: vi.fn((name: string, arg?: Record<string, unknown>) => {
      cmds.push([name, arg ?? {}]);
      return Promise.resolve(replies[name]?.(arg ?? {}) ?? { ok: true });
    }),
    onStatus: (fn: (s: Status) => void) => { onStatus = fn; },
    log: () => {},
  };
  const cfg = { storefront: "us", debug: false, seamless };
  const run = new Function(
    "cfg", "bridge", "window", "localStorage", "performance",
    "qualityEnsure", "qualityRender", "quality", "shuffleEnsure",
    `${code}\n;return { media, seam, jobFor, setMk: (m) => { mk = m; } };`,
  ) as (...a: unknown[]) => Page;
  page = run(cfg, bridge, {}, {}, { now: () => Date.now() }, () => {}, () => {}, { want: null }, () => {});
  page.setMk(mk);
  page.media.addEventListener("ended", () => { ended++; });
}

const srcOf = (item: Item): string => "amagent:" + encodeURIComponent(JSON.stringify(page.jobFor(item)));
const names = (): string[] => cmds.map(([n]) => n);

function status(item: Item | null, posS: number, extra: Status = {}): Status {
  return {
    engine: "ready", ready: true, playing: !!item, paused: false, volume: 0.5,
    nowPlaying: item ? { songId: item.id, title: item.title, positionMs: posS * 1000, durationMs: item.playbackDuration, queueItemId: `9${item.id}` } : null,
    upNext: [], crossfade: { on: false, seconds: 6 }, autoplay: false,
    ...extra,
  };
}

/** a status, then enough time for the page to act on the next one (commands hold it 400 ms) */
async function push(s: Status, ms = 500): Promise<void> {
  onStatus(s);
  await vi.advanceTimersByTimeAsync(ms);
}

async function start(item: Item): Promise<void> {
  page.media.src = srcOf(item);
  const p = page.media.play();
  await vi.advanceTimersByTimeAsync(10);
  await push(status(item, 0));
  await p;
}

const A = song("101", 200_000);
const B = song("102", 199_000);   // within 2.5 s of A: matches()' duration fallback takes it for A
const C = song("103", 150_000);
const upNext = (item: Item, qid = `9${item.id}`) => [{ songId: item.id, queueItemId: qid, section: "next-added" }];

beforeEach(() => {
  vi.useFakeTimers();
  cmds = [];
  ended = 0;
  replies = { enqueue: (arg) => ({ ok: true, hresult: "00000000", queueItemId: `9${String(arg.song)}`, loadMs: 900 }) };
  const items = [A, B, C];
  mk = {
    queue: {
      items, position: 0,
      get currentItem() { return this.items[this.position]; },
      get nextPlayableItem() { return this.items[this.position + 1]; },
    },
    repeatMode: 0, continuous: true,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("seamless hand-over", () => {
  it("enqueues the next item, lets the engine go on and adopts the playing track", async () => {
    load();
    await start(A);
    await push(status(A, 170));                       // 30 s left: too early (lead 25 s)
    expect(names()).toEqual(["play"]);
    await push(status(A, 181));                       // 19 s left
    expect(cmds[1]).toEqual(["enqueue", { song: "102", album: "77", storefront: "gb" }]);
    await push(status(A, 185, { upNext: upNext(B) }));
    await push(status(A, 199.6, { upNext: upNext(B) }), 300);
    await push(status(B, 0.2), 0);                    // the engine went on by itself
    await vi.advanceTimersByTimeAsync(10);
    expect(ended).toBe(1);
    // MusicKit's next item
    mk.queue.position = 1;
    let playing = 0;
    page.media.addEventListener("playing", () => { playing++; });
    page.media.src = srcOf(B);
    await page.media.play();
    await vi.advanceTimersByTimeAsync(10);
    expect(playing).toBe(1);
    expect(page.media.currentTime).toBeCloseTo(0.2, 0);
    await push(status(B, 5));
    await vi.advanceTimersByTimeAsync(6000);
    expect(names()).toEqual(["play", "enqueue"]);   // no pause, no second play
    expect(ended).toBe(1);
  });

  it("hands over early with crossfade and fires ended once", async () => {
    load();
    const xf = { crossfade: { on: true, seconds: 8 } };
    await start(A);
    await push(status(A, 166, xf));                   // 34 s left, lead is 8 + 25 = 33 s
    expect(names()).toEqual(["play"]);
    await push(status(A, 172, xf));
    expect(names()).toEqual(["play", "enqueue"]);
    await push(status(A, 190, { ...xf, upNext: upNext(B) }));
    await push(status(B, 0.1, xf));                   // 8 s before A's end
    await push(status(B, 0.6, xf));
    await push(status(B, 1.1, xf));
    expect(ended).toBe(1);
    expect(names()).toEqual(["play", "enqueue"]);
  });

  it("keeps the pause at the end with a service without a queue API", async () => {
    load();
    const old = { upNext: undefined, crossfade: undefined };
    await start(A);
    await push({ ...status(A, 185), ...old });
    await push({ ...status(A, 199.5), ...old }, 1000);
    expect(ended).toBe(1);
    expect(names()).toEqual(["play", "pause"]);
  });

  it("keeps the pause at the end with AM_WEBUI_SEAMLESS=0", async () => {
    load(false);
    await start(A);
    await push(status(A, 185));
    await push(status(A, 199.5), 1000);
    expect(names()).toEqual(["play", "pause"]);
  });

  it("does not enqueue with repeat-one, nor after the last item", async () => {
    load();
    mk.repeatMode = 1;
    await start(A);
    await push(status(A, 185));
    mk.repeatMode = 0;
    mk.queue.items = [A];
    await push(status(A, 186));
    expect(names()).toEqual(["play"]);
  });

  it("takes the item out again when MusicKit's next item changes, and enqueues the new one", async () => {
    load();
    await start(A);
    await push(status(A, 181));
    await push(status(A, 182, { upNext: upNext(B) }));
    mk.queue.items = [A, C, B];                       // shuffle, or the user moved C up
    await push(status(A, 183, { upNext: upNext(B) }));
    await push(status(A, 184, { upNext: upNext(B) }));
    await push(status(A, 185));
    expect(cmds.slice(1)).toEqual([
      ["enqueue", { song: "102", album: "77", storefront: "gb" }],
      ["dequeue", { id: "9102" }],
      ["enqueue", { song: "103", album: "77", storefront: "gb" }],
    ]);
  });

  it("plays a skipped-to item and only then takes the enqueued one out", async () => {
    load();
    await start(A);
    await push(status(A, 181));
    await push(status(A, 182, { upNext: upNext(B) }));
    mk.queue.position = 1;
    page.media.src = srcOf(B);                        // the user skips to it
    const p = page.media.play();
    await vi.advanceTimersByTimeAsync(10);
    const fresh = (st: Status): Status => ({ ...st, nowPlaying: { ...(st.nowPlaying as Status), queueItemId: "9900" } });
    await push(fresh(status(B, 0)));                 // /play made a new queue item
    await p;
    await push(fresh(status(B, 1)));
    expect(names()).toEqual(["play", "enqueue", "play", "dequeue"]);
    expect(cmds[3][1]).toEqual({ id: "9102" });
    expect(ended).toBe(0);
  });

  it("pauses at the end when the engine never shows the item as next", async () => {
    load();
    await start(A);
    await push(status(A, 181));
    await push(status(A, 199.5), 1000);
    expect(ended).toBe(1);
    await push(status(A, 199.9, { playing: false, paused: true }));
    expect(names()).toEqual(["play", "enqueue", "pause", "dequeue"]);
  });

  it("finds an item the service answered without an ID by its song, and takes only that out", async () => {
    load();
    replies.enqueue = () => ({ ok: true, hresult: "00000000", queueItemId: "", loadMs: 5900 });
    await start(A);
    await push(status(A, 181));
    await push(status(A, 182, { upNext: upNext(B, "9555") }));
    mk.queue.items = [A, C, B];
    await push(status(A, 183, { upNext: upNext(B, "9555") }));
    await push(status(A, 184, { upNext: upNext(B, "9555") }));
    expect(cmds.slice(1, 3)).toEqual([
      ["enqueue", { song: "102", album: "77", storefront: "gb" }],
      ["dequeue", { id: "9555" }],
    ]);
  });

  it("finds the item by its song when it was dropped before the engine showed it", async () => {
    load();
    replies.enqueue = () => ({ ok: true, hresult: "00000000", queueItemId: "", loadMs: 5900 });
    await start(A);
    await push(status(A, 181));
    mk.queue.items = [A, C, B];
    await push(status(A, 182));                       // dropped, upNext does not have it yet
    await push(status(A, 183, { upNext: upNext(B, "9555") }));
    expect(cmds.slice(1, 3)).toEqual([
      ["enqueue", { song: "102", album: "77", storefront: "gb" }],
      ["dequeue", { id: "9555" }],
    ]);
  });

  it("does not enqueue when too close to the end for a slow /enqueue", async () => {
    load();
    await start(A);
    await push(status(A, 185));                       // 15 s left
    await push(status(A, 199.5), 1000);
    expect(names()).toEqual(["play", "pause"]);
  });

  it("pauses at the end after all when the item is dropped with the end timer armed", async () => {
    load();
    await start(A);
    await push(status(A, 181));
    await push(status(A, 185, { upNext: upNext(B) }));
    await push(status(A, 198.7, { upNext: upNext(B) }), 100);   // armed for the hand-over
    mk.repeatMode = 1;                                 // the user turns on repeat-one
    await push(status(A, 199.0, { upNext: upNext(B) }), 1000);
    expect(ended).toBe(1);
    expect(names()).toEqual(["play", "enqueue", "pause"]);
  });

  it("waits for MusicKit's play() of a skipped-to item before the dequeue", async () => {
    load();
    await start(A);
    await push(status(A, 181));
    await push(status(A, 182, { upNext: upNext(B) }));
    mk.queue.position = 2;
    page.media.src = srcOf(C);                        // set now, play() a moment later
    await push(status(A, 182.3, { upNext: upNext(B) }), 300);
    expect(names()).toEqual(["play", "enqueue"]);
    const p = page.media.play();
    await vi.advanceTimersByTimeAsync(10);
    await push({ ...status(C, 0), nowPlaying: { ...(status(C, 0).nowPlaying as Status), queueItemId: "9901" } });
    await p;
    await push({ ...status(C, 1), nowPlaying: { ...(status(C, 1).nowPlaying as Status), queueItemId: "9901" } });
    expect(names()).toEqual(["play", "enqueue", "play", "dequeue"]);
  });

  it("stops trying when the service does not know /enqueue", async () => {
    load();
    replies.enqueue = () => ({ error: "unknown endpoint" });
    await start(A);
    await push(status(A, 181));
    expect(page.seam.off).toBe(true);
    await push(status(A, 199.5), 1000);
    expect(names()).toEqual(["play", "enqueue", "pause"]);
  });
});
