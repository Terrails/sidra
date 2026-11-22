/**
 * Player commands from the page, validated and turned into service API paths. The
 * page is not trusted: every argument is checked here.
 */
import { net } from "electron";
import { STOREFRONT } from "./service";

// The service plays a song through its album page, so it needs the album ID. The
// page usually knows it; when it does not, the public iTunes lookup answers.
const albumCache = new Map<string, string>();

async function albumOf(song: string, storefront: string): Promise<string> {
  const cached = albumCache.get(song);
  if (cached) return cached;
  const res = await net.fetch(
    `https://itunes.apple.com/lookup?id=${song}&country=${storefront}&entity=song`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`album lookup failed (${res.status})`);
  const body = (await res.json()) as {
    results?: { trackId?: number; collectionId?: number }[];
  };
  const row = (body.results ?? []).find(
    (r) => String(r.trackId) === song && r.collectionId,
  );
  if (!row) throw new Error("album lookup: song not found");
  const album = String(row.collectionId);
  albumCache.set(song, album);
  return album;
}

const SIMPLE = new Set(["pause", "resume", "stop", "next", "previous"]);
const QUALITIES = new Set(["aac", "lossless", "hires"]);
const isId = (v: unknown): v is string =>
  typeof v === "string" && /^\d{1,20}$/.test(v);
const isCountry = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z]{2}$/.test(v);

/** API path for a page command; throws for anything unknown or malformed. */
export async function commandPath(
  cmd: string,
  arg: Record<string, unknown>,
): Promise<string> {
  if (SIMPLE.has(cmd)) return `/${cmd}`;
  if (
    cmd === "play" &&
    isId(arg.song) &&
    (arg.album == null || isId(arg.album))
  ) {
    const storefront = isCountry(arg.storefront) ? arg.storefront : STOREFRONT;
    const album = isId(arg.album)
      ? arg.album
      : await albumOf(arg.song, storefront);
    // queue=single: MusicKit keeps the queue here and asks for one song at a time, so
    // the service must not queue the rest of the album (its default).
    return `/play?album=${album}&song=${arg.song}&storefront=${storefront}&queue=single`;
  }
  if (cmd === "seek" && typeof arg.ms === "number" && Number.isFinite(arg.ms))
    return `/seek?ms=${Math.max(0, Math.round(arg.ms))}`;
  if (cmd === "volume" && typeof arg.v === "number" && Number.isFinite(arg.v))
    return `/volume?v=${Math.min(1, Math.max(0, arg.v)).toFixed(3)}`;
  if (cmd === "quality" && typeof arg.q === "string" && QUALITIES.has(arg.q))
    return `/quality?q=${arg.q}`;
  throw new Error("unknown player command");
}
