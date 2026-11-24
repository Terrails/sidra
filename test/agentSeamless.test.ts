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
  seam: { q: { song: string; qid?: string }[]; handoff: unknown; stale: unknown[]; off: boolean; noEnd: boolean; bad: string | null };
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
const D = song("104", 180_000);
const E = song("105", 170_000);
const upNext = (item: Item, qid = `9${item.id}`) => [{ songId: item.id, queueItemId: qid, section: "next-added" }];

beforeEach(() => {
  vi.useFakeTimers();
  cmds = [];
  ended = 0;
  replies = { enqueue: (arg) => ({ ok: true, hresult: "00000000", queueItemId: `9${String(arg.song)}`, loadMs: 900 }) };
  const items = [A, B, C, D, E];
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

// With quality "aac" and crossfade on, Sidra stays two items ahead: the next item, then the one
// after it with at=end.
describe("two items ahead (AAC with crossfade)", () => {
  const xf = { quality: "aac", crossfade: { on: true, seconds: 8 } };
  const up = (...items: Item[]) => items.map((i) => ({ songId: i.id, queueItemId: `9${i.id}`, section: "next-added" }));
  const enq = (song: string, at?: string) => ["enqueue", { song, album: "77", storefront: "gb", ...(at && { at }) }];

  /** A plays, B is queued (no at), then C (at=end); the engine lists both */
  async function two(): Promise<void> {
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    await push(status(A, 13, { ...xf, upNext: up(B) }));
    await push(status(A, 14, { ...xf, upNext: up(B) }));
    expect(names()).toEqual(["play", "enqueue"]);      // not within 3 s of the last command
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, { ...xf, upNext: up(B) }));
    await push(status(A, 18, { ...xf, upNext: up(B, C) }));
  }

  it("queues B, then C with at=end once B is listed first and things have settled", async () => {
    load();
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 9, xf));                      // before fade + 3 s of the track
    expect(names()).toEqual(["play"]);
    await push(status(A, 12, xf));
    expect(cmds[1]).toEqual(enq("102"));
    await push(status(A, 13, { ...xf, upNext: up(B) }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, { ...xf, upNext: up(B) }));
    expect(cmds.slice(1)).toEqual([enq("102"), enq("103", "end")]);
    expect(page.seam.q.map((e) => e.song)).toEqual(["102", "103"]);
  });

  it.each([
    ["lossless", { quality: "lossless", crossfade: { on: true, seconds: 8 } }],
    ["hires", { quality: "hires", crossfade: { on: true, seconds: 8 } }],
    ["aac without crossfade", { quality: "aac", crossfade: { on: false, seconds: 8 } }],
  ])("keeps one item and the window with %s", async (_n, extra) => {
    load();
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, extra));
    expect(names()).toEqual(["play"]);
    await push(status(A, 175, extra));
    expect(cmds[1]).toEqual(enq("102"));
    await push(status(A, 176, { ...extra, upNext: up(B) }));
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 180, { ...extra, upNext: up(B) }));
    expect(names()).toEqual(["play", "enqueue"]);
  });

  it("queues nothing without upNext or with AM_WEBUI_SEAMLESS=0", async () => {
    load(false);
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    expect(names()).toEqual(["play"]);
    load();
    cmds = [];
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push({ ...status(A, 12, xf), upNext: undefined });
    expect(names()).toEqual(["play"]);
  });

  it("goes through early hand-overs one after the other without play, pause or dequeue", async () => {
    load();
    await two();
    await push(status(B, 0.2, { ...xf, upNext: up(C) }));   // the engine switched 8 s early
    await vi.advanceTimersByTimeAsync(10);
    expect(ended).toBe(1);
    expect(page.seam.q.map((e) => e.song)).toEqual(["103"]);
    mk.queue.position = 1;
    page.media.src = "";
    page.media.src = srcOf(B);
    await page.media.play();
    await vi.advanceTimersByTimeAsync(10);
    expect(page.media.currentTime).toBeCloseTo(0.2, 0);
    await push(status(B, 5, { ...xf, upNext: up(C) }));
    await push(status(B, 6, { ...xf, upNext: up(C) }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(B, 12, { ...xf, upNext: up(C) }));
    expect(cmds.slice(1)).toEqual([enq("102"), enq("103", "end"), enq("104", "end")]);
    await push(status(B, 13, { ...xf, upNext: up(C, D) }));
    await push(status(C, 0.3, { ...xf, upNext: up(D) }));
    expect(ended).toBe(2);
    mk.queue.position = 2;
    page.media.src = srcOf(C);
    await page.media.play();
    expect(names()).toEqual(["play", "enqueue", "enqueue", "enqueue"]);
    expect(page.seam.q.map((e) => e.song)).toEqual(["104"]);
  });

  it("keeps C when the engine's upNext is empty for a moment, and queues D once confirmed", async () => {
    load();
    await two();
    await push(status(B, 0.2, { ...xf, upNext: [] }));
    expect(ended).toBe(1);
    mk.queue.position = 1;
    page.media.src = srcOf(B);
    await page.media.play();
    await push(status(B, 5, { ...xf, upNext: [] }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(B, 12, { ...xf, upNext: up(C) }));
    expect(cmds.filter(([n]) => n === "enqueue").length).toBe(3);
    expect(page.seam.q.map((e) => e.song)).toEqual(["103", "104"]);
  });

  it("takes C and then B out when B changes, and starts again", async () => {
    load();
    await two();
    mk.queue.items = [A, C, B, D, E];
    await push(status(A, 19, { ...xf, upNext: up(B, C) }));
    await push(status(A, 20, { ...xf, upNext: up(B, C) }));
    await push(status(A, 21, { ...xf, upNext: up(B) }));
    expect(cmds.slice(3)).toEqual([["dequeue", { id: "9103" }], ["dequeue", { id: "9102" }]]);
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 25, { ...xf, upNext: [] }));
    expect(cmds[5]).toEqual(enq("103"));
  });

  it("takes only C out when only C changes", async () => {
    load();
    await two();
    mk.queue.items = [A, B, D, C, E];
    await push(status(A, 19, { ...xf, upNext: up(B, C) }));
    await push(status(A, 20, { ...xf, upNext: up(B, C) }));
    expect(cmds.slice(3)).toEqual([["dequeue", { id: "9103" }]]);
    await push(status(A, 21, { ...xf, upNext: up(B) }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 25, { ...xf, upNext: up(B) }));
    expect(cmds.slice(4)).toEqual([enq("104", "end")]);
  });

  it("takes both out with repeat-one and pauses at the end", async () => {
    load();
    await two();
    mk.repeatMode = 1;
    await push(status(A, 19, { ...xf, upNext: up(B, C) }));
    await push(status(A, 20, { ...xf, upNext: up(B, C) }));
    await push(status(A, 21, { ...xf, upNext: up(B, C) }));
    expect(names().slice(3)).toEqual(["dequeue", "dequeue"]);
    await push(status(A, 199.5, { ...xf, upNext: [] }), 1000);
    expect(names().slice(5)).toEqual(["pause"]);
  });

  it("plays a skipped-to item first, then takes both out", async () => {
    load();
    await two();
    mk.queue.position = 3;
    page.media.src = srcOf(D);
    const p = page.media.play();
    await vi.advanceTimersByTimeAsync(10);
    const fresh = (x: number): Status => ({ ...status(D, x, xf), nowPlaying: { ...(status(D, x).nowPlaying as Status), queueItemId: "9900" } });
    await push(fresh(0));
    await p;
    await push(fresh(1));
    await push(fresh(2));
    expect(names().slice(3)).toEqual(["play", "dequeue", "dequeue"]);
    expect(cmds.slice(4).map(([, a]) => a.id)).toEqual(["9103", "9102"]);
  });

  it("plays C, not the hand-over, when MusicKit goes elsewhere after the early switch", async () => {
    load();
    await two();
    await push(status(B, 0.2, { ...xf, upNext: up(C) }));
    expect(ended).toBe(1);
    mk.queue.position = 2;
    page.media.src = srcOf(C);                         // the user skipped in the overlap
    const p = page.media.play();
    await vi.advanceTimersByTimeAsync(10);
    const fresh = (x: number): Status => ({ ...status(C, x, xf), nowPlaying: { ...(status(C, x).nowPlaying as Status), queueItemId: "9900" } });
    await push(fresh(0));
    await p;
    await push(fresh(1));
    expect(names().slice(3)).toEqual(["play", "dequeue"]);
    expect(cmds[3]).toEqual(["play", { song: "103", album: "77", storefront: "gb" }]);
    expect(cmds[4]).toEqual(["dequeue", { id: "9103" }]);
  });

  it.each([
    ["the end of the queue", () => { mk.queue.items = [A, B]; }],
    ["a repeat-all wrap to the same song", () => { mk.queue.items = [A, B, A]; }],
    ["the same song twice", () => { mk.queue.items = [A, B, B]; }],
    ["an unplayable item", () => { mk.queue.items = [A, B, { ...C, isPlayable: false } as Item]; }],
    ["an item without play parameters", () => { mk.queue.items = [A, B, { ...C, playParams: undefined } as unknown as Item]; }],
    ["a next item the list does not show", () => { mk.queue.items = [A, D, C]; Object.defineProperty(mk.queue, "nextPlayableItem", { get: () => C }); }],
    ["no list", () => { Object.defineProperty(mk.queue, "items", { value: undefined, writable: true }); Object.defineProperty(mk.queue, "currentItem", { value: A }); Object.defineProperty(mk.queue, "nextPlayableItem", { value: B }); }],
  ])("queues one only with %s", async (_n, arrange) => {
    load();
    arrange();
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    await push(status(A, 13, { ...xf, upNext: up(B) }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, { ...xf, upNext: up(B) }));
    await push(status(A, 18, { ...xf, upNext: up(B) }));
    expect(names()).toEqual(["play", "enqueue"]);
  });

  it("queues an item that MusicKit has loaded later", async () => {
    load();
    mk.queue.items = [A, B];
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    await push(status(A, 13, { ...xf, upNext: up(B) }));
    mk.queue.items = [A, B, D];
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, { ...xf, upNext: up(B) }));
    expect(cmds[2]).toEqual(enq("104", "end"));
  });

  it("queues one only when B is short", async () => {
    load();
    mk.queue.items = [A, song("102", 10_000), C, D];
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    await push(status(A, 13, { ...xf, upNext: up(B) }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, { ...xf, upNext: up(B) }));
    expect(names()).toEqual(["play", "enqueue"]);
  });

  it("does not retry a failed B and pauses at the end", async () => {
    load();
    replies.enqueue = () => ({ ok: false, error: "HTTP 404" });
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, xf));
    await push(status(A, 199.5, xf), 1000);
    expect(names()).toEqual(["play", "enqueue", "pause"]);
  });

  it("lets B hand over when C fails, and does not send C as the first item", async () => {
    load();
    replies.enqueue = (arg) => (arg.at === "end" ? { ok: false, error: "HTTP 404" } : { ok: true, queueItemId: "9102" });
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    await push(status(A, 13, { ...xf, upNext: up(B) }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, { ...xf, upNext: up(B) }));
    await push(status(A, 18, { ...xf, upNext: up(B) }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 22, { ...xf, upNext: up(B) }));
    expect(names()).toEqual(["play", "enqueue", "enqueue"]);
    expect(page.seam.bad).toBe("103");
    await push(status(B, 0.2, { ...xf, upNext: [] }));
    expect(ended).toBe(1);
    expect(names()).toEqual(["play", "enqueue", "enqueue"]);
    mk.queue.position = 1;
    page.media.src = srcOf(B);
    await page.media.play();
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(B, 12, { ...xf, upNext: [] }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(B, 17, { ...xf, upNext: [] }));
    expect(names()).toEqual(["play", "enqueue", "enqueue"]);   // C failed: not sent as the first item
  });

  it("stops using Add to Queue when the app has none, and goes back to the window", async () => {
    load();
    replies.enqueue = (arg) => (arg.at === "end" ? { ok: false, hresult: "80004001" } : { ok: true, queueItemId: "9102" });
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    await push(status(A, 13, { ...xf, upNext: up(B) }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, { ...xf, upNext: up(B) }));
    expect(page.seam.noEnd).toBe(true);
    await push(status(B, 0.2, { ...xf, upNext: [] }));
    mk.queue.position = 1;
    page.media.src = srcOf(B);
    await page.media.play();
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(B, 12, { ...xf, upNext: [] }));
    expect(names()).toEqual(["play", "enqueue", "enqueue"]);   // not before the window
    await push(status(B, 170, { ...xf, upNext: [] }));
    expect(cmds[3]).toEqual(enq("103"));
  });

  it("does not resend C that was answered without an ID, and finds it by its song", async () => {
    load();
    replies.enqueue = (arg) => ({ ok: true, queueItemId: arg.at === "end" ? "" : "9102" });
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    await push(status(A, 13, { ...xf, upNext: up(B) }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, { ...xf, upNext: up(B) }));
    await push(status(A, 18, { ...xf, upNext: up(B, C) }));
    expect(page.seam.q[1].qid).toBe("9103");
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 23, { ...xf, upNext: up(B, C) }));
    expect(names()).toEqual(["play", "enqueue", "enqueue"]);
  });

  it("takes both out after the new /play when the item is replaced while C is being added", async () => {
    load();
    let done!: (r: Reply) => void;
    replies.enqueue = (arg) => (arg.at === "end" ? (new Promise((res) => { done = res; }) as unknown as Reply) : { ok: true, queueItemId: "9102" });
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    await push(status(A, 13, { ...xf, upNext: up(B) }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, { ...xf, upNext: up(B) }));
    expect(names()).toEqual(["play", "enqueue", "enqueue"]);
    mk.queue.position = 3;
    page.media.src = srcOf(D);
    const p = page.media.play();
    done({ ok: true, queueItemId: "9103" });
    await vi.advanceTimersByTimeAsync(10);
    const fresh = (x: number): Status => ({ ...status(D, x, xf), nowPlaying: { ...(status(D, x).nowPlaying as Status), queueItemId: "9900" } });
    await push(fresh(0));
    await p;
    await push(fresh(1));
    await push(fresh(2));
    expect(names().slice(2)).toEqual(["enqueue", "play", "dequeue", "dequeue"]);
    expect(cmds.slice(4).map(([, a]) => a.id).sort()).toEqual(["9102", "9103"]);
  });

  it("hands over normally after quality or crossfade is switched while both are queued", async () => {
    load();
    await two();
    const off = { quality: "lossless", crossfade: { on: false, seconds: 8 } };
    await push(status(A, 20, { ...off, upNext: up(B, C) }));
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 190, { ...off, upNext: up(B, C) }));
    expect(names()).toEqual(["play", "enqueue", "enqueue"]);
    await push(status(B, 0.1, { ...off, upNext: up(C) }));
    expect(ended).toBe(1);
    expect(names()).toEqual(["play", "enqueue", "enqueue"]);
  });

  it("pauses at the end when the engine's first item is not ours", async () => {
    load();
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    const foreign = [{ songId: "999", queueItemId: "9999", section: "next-added" }];
    await push(status(A, 13, { ...xf, upNext: foreign }));
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, { ...xf, upNext: foreign }));
    expect(names()).toEqual(["play", "enqueue"]);
    await push(status(A, 199.5, { ...xf, upNext: foreign }), 1000);
    expect(names()).toEqual(["play", "enqueue", "pause"]);
  });

  it("waits for the resume when the engine switched while paused", async () => {
    load();
    await two();
    page.media.pause();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(500);
    await push(status(B, 0.1, { ...xf, upNext: up(C), playing: false, paused: true }));
    expect(ended).toBe(0);
    const p = page.media.play();
    await vi.advanceTimersByTimeAsync(10);
    await p;
    await vi.advanceTimersByTimeAsync(500);
    await push(status(B, 0.3, { ...xf, upNext: up(C) }));
    expect(ended).toBe(1);
    expect(names()).not.toContain("dequeue");
  });

  it("dequeues C and queues the new next item when the queue changes after an adoption", async () => {
    load();
    await two();
    await push(status(B, 0.2, { ...xf, upNext: up(C) }));
    mk.queue.position = 1;
    page.media.src = "";
    page.media.src = srcOf(B);
    await page.media.play();
    await vi.advanceTimersByTimeAsync(10);
    mk.queue.items = [A, B, D, C, E];                  // the user moved D up behind B
    for (let t = 1; t <= 20; t++) await push(status(B, 4 + t * 0.5, { ...xf, upNext: up(C) }), 250);
    expect(cmds.slice(3).map((c) => c[0])).toContain("dequeue");
    expect(cmds.find((c) => c[0] === "dequeue")).toEqual(["dequeue", { id: "9103" }]);
    expect(cmds.filter((c) => c[0] === "enqueue").pop()?.[1]).toMatchObject({ song: "104" });
  });

  it("ends the item at once when the engine switched while paused with lossless", async () => {
    load();
    await two();
    page.media.pause();
    await vi.advanceTimersByTimeAsync(500);
    await push(status(B, 0.1, { ...xf, quality: "lossless", upNext: up(C), playing: false, paused: true }));
    expect(ended).toBe(1);
  });

  it("ends the item when the engine plays C directly", async () => {
    load();
    await two();
    await push(status(C, 0.5, { ...xf, upNext: [] }));
    expect(ended).toBe(1);
    expect(names().slice(3)).toEqual(["pause"]);
  });

  it("drops the list when the hand-over is not taken in 30 s", async () => {
    load();
    await two();
    await push(status(B, 0.2, { ...xf, upNext: up(C) }));
    expect(ended).toBe(1);
    await vi.advanceTimersByTimeAsync(31000);
    await push(status(B, 31, { ...xf, upNext: up(C) }));
    expect(page.seam.q).toEqual([]);
    await push(status(B, 32, { ...xf, upNext: up(C) }));
    expect(names().slice(3)).toEqual(["dequeue"]);
  });

  it("falls back to /play and drops the list when the engine left the handed-over item", async () => {
    load();
    await two();
    await push(status(B, 0.2, { ...xf, upNext: up(C) }));
    await push({ ...status(null, 0, xf), playing: false });   // the engine stopped before MusicKit's play()
    mk.queue.position = 1;
    page.media.src = srcOf(B);
    const p = page.media.play();
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(names().slice(3)).toEqual(["play"]);
    expect(page.seam.q).toEqual([]);
  });

  it("does not pause when the engine switched early with the end timer armed", async () => {
    load();
    await two();
    await push(status(A, 198.7, { ...xf, upNext: up(B, C) }), 100);
    await push(status(B, 0.1, { ...xf, upNext: up(C) }));
    await vi.advanceTimersByTimeAsync(6000);
    expect(ended).toBe(1);
    expect(names()).toEqual(["play", "enqueue", "enqueue"]);
  });

  it("keeps C when MusicKit has no next item for a moment after an adoption, drops it later", async () => {
    load();
    await two();
    await push(status(B, 0.2, { ...xf, upNext: up(C) }));
    mk.queue.position = 1;
    page.media.src = srcOf(B);
    await page.media.play();
    const items = mk.queue.items;
    mk.queue.items = [A, B];                           // MusicKit's next item is not set yet
    await push(status(B, 1, { ...xf, upNext: up(C) }), 100);
    expect(page.seam.q.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2500);
    await push(status(B, 4, { ...xf, upNext: up(C) }));
    expect(page.seam.q.length).toBe(0);
    mk.queue.items = items;
  });

  it("ends the item when the engine switches into an item that was just dropped", async () => {
    load();
    await two();
    mk.queue.items = [A, D, E];
    await push(status(A, 193, { ...xf, upNext: up(B, C) }));   // both dropped, C leaves first
    await push(status(A, 193, { ...xf, upNext: up(B, C) }));
    expect(cmds.at(-1)).toEqual(["dequeue", { id: "9103" }]);
    await push(status(B, 0, { ...xf, upNext: [] }));           // B lasts nearly as long as A
    expect(ended).toBe(1);
    expect(names().at(-1)).toBe("pause");
  });

  it("keeps a pause when the engine switched into a dropped item, and ends on the resume", async () => {
    load();
    await two();
    mk.queue.items = [A, D, E];
    await push(status(A, 193, { ...xf, upNext: up(B, C) }));
    await push(status(A, 193, { ...xf, upNext: up(B, C) }));
    page.media.pause();
    await vi.advanceTimersByTimeAsync(500);
    const paused = { ...xf, upNext: [], playing: false, paused: true };
    await push(status(B, 1, paused));
    await push(status(B, 1, paused));
    expect(ended).toBe(0);
    await page.media.play();
    await push(status(B, 1, { ...xf, upNext: [] }));
    expect(ended).toBe(1);
  });

  it("does not retry a failed /enqueue in the window with lossless", async () => {
    load();
    replies.enqueue = () => ({ ok: false, error: "item not found on the album page" });
    await start(A);
    for (const at of [176, 177, 178, 179]) await push(status(A, at, { upNext: [] }));
    expect(names()).toEqual(["play", "enqueue"]);
  });

  it("does not send a second /enqueue when one status has no upNext", async () => {
    load();
    await start(A);
    await vi.advanceTimersByTimeAsync(4000);
    await push(status(A, 12, xf));
    await push({ ...status(A, 13, xf), upNext: undefined });
    await vi.advanceTimersByTimeAsync(3500);
    await push(status(A, 17, { ...xf, upNext: up(B) }));
    expect(names()).toEqual(["play", "enqueue"]);
  });
});
