// src/agent/commands.ts: page commands for the player service. The page is not trusted, so
// anything unknown or malformed must throw before it becomes an API path.
import { net } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { commandPath, crossfadeSetting } from "../src/agent/commands";

const fetchMock = vi.mocked(net.fetch);

function lookupReply(rows: { trackId?: number; collectionId?: number }[], ok = true) {
  return { ok, status: ok ? 200 : 503, json: () => Promise.resolve({ results: rows }) } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("commandPath", () => {
  it.each(["pause", "resume", "stop", "next", "previous"])("passes %s through", async (cmd) => {
    expect(await commandPath(cmd, {})).toBe(`/${cmd}`);
  });

  it.each(["quit", "status", "", "/pause", "pause?x=1", "constructor", "__proto__"])(
    "refuses the command %j",
    async (cmd) => {
      await expect(commandPath(cmd, {})).rejects.toThrow("unknown player command");
    },
  );

  it("plays a song of a known album with the page's storefront", async () => {
    expect(await commandPath("play", { song: "617154366", album: "617154241", storefront: "gb" })).toBe(
      "/play?album=617154241&song=617154366&storefront=gb&queue=single",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to Sidra's storefront for a malformed one", async () => {
    for (const storefront of ["GB", "gbr", "g&", 7, null]) {
      expect(await commandPath("play", { song: "1", album: "2", storefront })).toBe(
        "/play?album=2&song=1&storefront=us&queue=single",
      );
    }
  });

  it.each([
    [{ song: "1&x=2", album: "2" }],
    [{ song: 1, album: "2" }],
    [{ song: "", album: "2" }],
    [{ song: "123456789012345678901", album: "2" }],
    [{ song: "1", album: "2/../quit" }],
    [{ song: "1", album: 2 }],
    [{}],
  ])("refuses play with %j", async (arg) => {
    await expect(commandPath("play", arg)).rejects.toThrow("unknown player command");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks the album up once when the page does not know it", async () => {
    fetchMock.mockResolvedValue(lookupReply([{ trackId: 99 }, { trackId: 4242, collectionId: 77 }]));
    expect(await commandPath("play", { song: "4242", storefront: "gb" })).toBe(
      "/play?album=77&song=4242&storefront=gb&queue=single",
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://itunes.apple.com/lookup?id=4242&country=gb&entity=song",
    );
    await commandPath("play", { song: "4242" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails when the lookup fails or does not know the song", async () => {
    fetchMock.mockResolvedValueOnce(lookupReply([], false));
    await expect(commandPath("play", { song: "5001" })).rejects.toThrow("album lookup failed (503)");
    fetchMock.mockResolvedValueOnce(lookupReply([{ trackId: 5002 }]));
    await expect(commandPath("play", { song: "5002" })).rejects.toThrow("song not found");
  });

  it("clamps and rounds seek and volume", async () => {
    expect(await commandPath("seek", { ms: -5 })).toBe("/seek?ms=0");
    expect(await commandPath("seek", { ms: 1234.6 })).toBe("/seek?ms=1235");
    expect(await commandPath("volume", { v: 2 })).toBe("/volume?v=1.000");
    expect(await commandPath("volume", { v: -1 })).toBe("/volume?v=0.000");
    expect(await commandPath("volume", { v: 0.12345 })).toBe("/volume?v=0.123");
  });

  it.each([
    ["seek", { ms: Number.NaN }],
    ["seek", { ms: Number.POSITIVE_INFINITY }],
    ["seek", { ms: "10" }],
    ["volume", { v: "0.5" }],
    ["volume", { v: Number.NaN }],
    ["quality", { q: "best" }],
    ["quality", { q: ["hires"] }],
  ])("refuses %s with %j", async (cmd, arg) => {
    await expect(commandPath(cmd, arg)).rejects.toThrow("unknown player command");
  });

  it.each(["aac", "lossless", "hires"])("sets quality %s", async (q) => {
    expect(await commandPath("quality", { q })).toBe(`/quality?q=${q}`);
  });

  it("enqueues a song like play, without queue=single", async () => {
    expect(await commandPath("enqueue", { song: "617154366", album: "617154241", storefront: "gb" })).toBe(
      "/enqueue?album=617154241&song=617154366&storefront=gb",
    );
    fetchMock.mockResolvedValue(lookupReply([{ trackId: 4343, collectionId: 78 }]));
    expect(await commandPath("enqueue", { song: "4343" })).toBe("/enqueue?album=78&song=4343&storefront=us");
  });

  it.each(["next", "end"])("passes at=%s to enqueue", async (at) => {
    expect(await commandPath("enqueue", { song: "617154366", album: "617154241", storefront: "gb", at })).toBe(
      `/enqueue?album=617154241&song=617154366&storefront=gb&at=${at}`,
    );
  });

  it("ignores at for play", async () => {
    expect(await commandPath("play", { song: "1", album: "2", storefront: "gb", at: "end" })).toBe(
      "/play?album=2&song=1&storefront=gb&queue=single",
    );
  });

  it.each([["x"], [""], [5], ["end&x=1"]])("refuses enqueue with at=%j without a lookup", async (at) => {
    await expect(commandPath("enqueue", { song: "1", at })).rejects.toThrow("unknown player command");
    await expect(commandPath("enqueue", { song: "1", album: "2", at })).rejects.toThrow("unknown player command");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ song: "1&x=2", album: "2" }],
    [{ song: 1, album: "2" }],
    [{ song: "1", album: "2/../quit" }],
    [{}],
  ])("refuses enqueue with %j", async (arg) => {
    await expect(commandPath("enqueue", arg)).rejects.toThrow("unknown player command");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dequeues one queue item or everything after the current one", async () => {
    expect(await commandPath("dequeue", {})).toBe("/dequeue");
    expect(await commandPath("dequeue", { id: "1234567890" })).toBe("/dequeue?id=1234567890");
  });

  it.each([[{ id: "" }], [{ id: "1&x=2" }], [{ id: "1/../quit" }], [{ id: 5 }], [{ id: "q102" }], [{ id: "1".repeat(21) }]])(
    "refuses dequeue with %j",
    async (arg) => {
      await expect(commandPath("dequeue", arg)).rejects.toThrow("unknown player command");
    },
  );
});

describe("crossfadeSetting", () => {
  it.each([[undefined], [""], ["  "]])("leaves the engine's setting for %j", (raw) => {
    expect(crossfadeSetting(raw)).toBeNull();
  });

  it("turns crossfade off with 0 and on with 1 to 12 seconds", () => {
    expect(crossfadeSetting("0")).toEqual({ on: false, seconds: null });
    expect(crossfadeSetting("1")).toEqual({ on: true, seconds: 1 });
    expect(crossfadeSetting(" 12 ")).toEqual({ on: true, seconds: 12 });
  });

  it.each(["13", "-1", "1.5", "on", "6s", "100"])("refuses %j", (raw) => {
    expect(() => crossfadeSetting(raw)).toThrow("AM_WEBUI_CROSSFADE");
  });
});
