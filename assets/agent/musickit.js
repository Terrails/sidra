// Part of the wrapper-service hook (assets/agent/hook.js holds the frame and the overview).
// The parts run inside one closure, in the order AGENT_PARTS in src/agent/index.ts lists them,
// and share its names; this one provides:
//   mk, agentPlayer, adoptVolume(), jobFor(), unrestrict(inst), mixedQueueFix(inst), hook(inst)

// ---- MusicKit hooks -------------------------------------------------------
let mk = null;
let agentPlayer = null;

// the page's volume slider follows the service's volume
function adoptVolume(v) {
  try {
    const mip = mk && mk._mediaItemPlayback;
    if (!mip) return;
    if (mip.playerState) mip.playerState.volume = v;
    const cur = mip._currentPlayer;
    if (cur && cur !== agentPlayer && Math.abs((cur.volume ?? v) - v) > 0.0005) cur.volume = v;
  } catch (e) { log('adoptVolume', String(e)); }
}

// {song, album, cc, title, durMs} for a catalogue song, else null
function jobFor(item) {
  try {
    if (!item) return null;
    const type = String(item.type || '');
    if (!/song/i.test(type) || item.isUTS || item.isLiveRadioStation || item.isLinearStream) return null;
    const pp = item.playParams || (item.attributes && item.attributes.playParams) || {};
    const song = [pp.catalogId, pp.id, item.id].map((x) => (x == null ? '' : String(x))).find((x) => /^\d+$/.test(x));
    if (!song) return null;
    const url = String((item.attributes && item.attributes.url) || '');
    const m = /music\.apple\.com\/([a-z]{2})\/(?:album|song)\//.exec(url);
    const a = /\/album\/(?:[^/?#]+\/)?(\d+)/.exec(url);
    const c = item.container;
    let album = a ? a[1] : null;
    if (!album && c && /album/i.test(String(c.type || '')) && /^\d+$/.test(String(c.id))) album = String(c.id);
    const cc = (m && m[1]) || (mk && mk.storefrontCountryCode) || cfg.storefront;
    return { song, album, cc: /^[a-z]{2}$/.test(cc) ? cc : cfg.storefront, title: item.title || (item.attributes && item.attributes.name) || '', durMs: item.playbackDuration || 0 };
  } catch (e) { log('jobFor', String(e)); return null; }
}

// Explicit-content restriction off. The page greys out explicit rows while MusicKit's
// restrictedEnabled is on (row disabled = isDisabled || explicit && restricted), and MusicKit
// drops explicit items from a restricted queue. The setter is MusicKit's own override: it stores
// "0" and ignores later sets (sign-in, account data). A status still at RESTRICTED (2) goes to
// AUTHORIZED (3); that change is the event the page re-reads restrictedEnabled on, so rows that
// are already shown turn normal. Called every 300 ms (start.js): sign-out resets the value.
// Off unless AM_WEBUI_UNRESTRICT=1 (cfg.unrestrict, src/agent/index.ts): it also overrides a
// restriction that is set on purpose.
function unrestrict(inst) {
  if (inst.restrictedEnabled) {
    inst.restrictedEnabled = false;
    log('explicit-content restriction turned off');
  }
  // the instance has no storekit of its own; its playback controller holds the shared one
  const pc = inst.playbackController || inst._playbackController;
  const sk = pc && pc.storekit;
  if (sk && sk.authorizationStatus === 2 && sk.userToken && !inst.restrictedEnabled) sk.authorizationStatus = 3;
}

// Mixed-kind queues. A list holding songs and music videos (a library playlist with a video in
// it) is played by the page as setQueue({ songs: [...], musicVideos: [...], startWith }), which
// MusicKit refuses ("Using multiple media kinds is not supported"); the page shows that as "Not
// available on the web". The kinds are split by then, so their order is gone: it is taken from
// the container the page shows (its tracks, fetched with the page's own MusicKit), and the call
// goes on as one ordered { items } list with the page's other options. Only the tracks the page
// sent are queued. Anything not found that way goes to MusicKit unchanged (and fails as before).
// Off unless AM_WEBUI_MIXED_QUEUE=1 (cfg.mixedQueue, src/agent/index.ts).
const QUEUE_KINDS = ['songs', 'musicVideos', 'librarySongs', 'uploadedAudios', 'uploadedVideos', 'musicMovies', 'episodes', 'podcastEpisodes',
  'song', 'musicVideo', 'librarySong', 'uploadedAudio', 'uploadedVideo', 'musicMovie', 'episode', 'podcastEpisode'];

// tracks endpoint of the album or playlist on the current page, else null
function containerTracksPath() {
  const p = location.pathname;
  let m;
  if ((m = /^\/library\/playlist\/(p\.[A-Za-z0-9]+)/.exec(p))) return `/v1/me/library/playlists/${m[1]}/tracks`;
  if ((m = /^\/library\/albums?\/(l\.[A-Za-z0-9]+)/.exec(p))) return `/v1/me/library/albums/${m[1]}/tracks`;
  if ((m = /^\/([a-z]{2})\/playlist\/[^/]+\/(pl\.[A-Za-z0-9-]+)/.exec(p))) return `/v1/catalog/${m[1]}/playlists/${m[2]}/tracks`;
  if ((m = /^\/([a-z]{2})\/album\/[^/]+\/(\d+)/.exec(p))) return `/v1/catalog/${m[1]}/albums/${m[2]}/tracks`;
  return null;
}

// all items of a paged endpoint (a container's tracks, the library's songs), in order
async function containerTracks(inst, path) {
  const LIMIT = 100;
  const PARALLEL = 8;                                  // a large library is hundreds of pages
  const first = (await inst.api.music(path, { limit: LIMIT })).data;
  const out = [...(first.data || [])];
  const total = first.meta && first.meta.total;
  if (typeof total === 'number' && first.next) {    // the rest in parallel, by offset
    const offsets = [];
    for (let o = LIMIT; o < total; o += LIMIT) offsets.push(o);
    const pages = new Array(offsets.length);
    let i = 0;
    const worker = async () => {
      while (i < offsets.length) {
        const k = i++;
        pages[k] = await inst.api.music(path, { limit: LIMIT, offset: offsets[k] });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, offsets.length) }, worker));
    for (const r of pages) out.push(...((r.data && r.data.data) || []));
  } else {
    for (let next = first.next; next;) {
      const r = (await inst.api.music(next)).data;
      out.push(...(r.data || []));
      next = r.next;
    }
  }
  // MusicKit hands an HTTP error (429, 500) back as a body without data instead of throwing:
  // the caller compares with the total when it needs every item
  out.total = typeof total === 'number' ? total : null;
  return out;
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(t));
}

function mixedQueueFix(inst) {
  const setQueue = inst.setQueue;
  if (typeof setQueue !== 'function' || setQueue.__agentMixed) return;
  inst.setQueue = async function (opts, ...rest) {
    const kinds = opts && typeof opts === 'object' ? QUEUE_KINDS.filter((k) => opts[k] != null && opts[k] !== '') : [];
    const path = kinds.length > 1 && !opts.items && !opts.url ? containerTracksPath() : null;
    if (!path) return setQueue.call(this, opts, ...rest);
    const ids = new Set();
    for (const k of kinds) for (const x of [].concat(opts[k])) ids.add(String(x && typeof x === 'object' ? x.id : x));
    let items = null;
    const t0 = Date.now();
    try {
      const tracks = await withTimeout(containerTracks(inst, path), 10000);
      const found = tracks.filter((r) => r && ids.has(String(r.id)));
      if (new Set(found.map((r) => String(r.id))).size === ids.size) items = found;
      else log('mixed-kind queue: tracks not all in the container', found.length, 'of', ids.size);
    } catch (e) { log('mixed-kind queue: container tracks', String(e)); }
    if (!items) return setQueue.call(this, opts, ...rest);
    const merged = { ...opts, items };
    for (const k of kinds) delete merged[k];
    log('mixed-kind queue:', kinds.join('+'), '->', items.length, 'items in order,', Date.now() - t0, 'ms');
    return setQueue.call(this, merged, ...rest);
  };
  inst.setQueue.__agentMixed = true;
}

function hook(inst) {
  const mip = inst._mediaItemPlayback;
  const ar = mip && mip.services && mip.services.assetResolver;
  const pm = mip && mip.playerManager;
  if (!ar || !pm || typeof ar.resolveAsset !== 'function' || typeof pm.createAudioPlayer !== 'function') return false;
  if (ar.resolveAsset.__agent) return true;

  const resolveAsset = ar.resolveAsset;
  ar.resolveAsset = async function (item, opts) {
    const job = jobFor(item);
    if (!job) return resolveAsset.call(this, item, opts);
    return {
      id: item.id, item, agent: true, encrypted: false, hls: false, preview: false, contentType: 'audio', delivery: 'progressive',
      assetURL: 'amagent:' + encodeURIComponent(JSON.stringify(job)),
    };
  };
  ar.resolveAsset.__agent = true;

  const createAudioPlayer = pm.createAudioPlayer;
  pm.createAudioPlayer = async function (asset, opts) {
    if (!asset || !asset.agent) return createAudioPlayer.call(this, asset, opts);
    if (!agentPlayer || agentPlayer.isDestroyed) {
      // MusicKit's own class for plain <audio> playback, with our element in place of a real one
      const plain = await createAudioPlayer.call(this, { encrypted: false, hls: false, contentType: 'audio' }, opts);
      const p = new plain.constructor(opts.playerOptions);
      p.initializeMediaElement = async function () { this.mediaElement = media; };
      // MusicKit asks for "an HTMLElement that is in the document" before it wires up events
      Object.defineProperty(p, 'hasMediaElement', { get: () => true });
      p.destroy = function () {};                      // outlives MusicKit's player clean-ups
      await p.initialize();
      agentPlayer = p;
      log('agent player created');
    }
    return agentPlayer;
  };

  // signed out of the web page, MusicKit is in preview mode; our tracks are full tracks
  const playAsset = mip.playAsset;
  mip.playAsset = async function (asset, ...rest) {
    if (!asset || !asset.agent || !this.previewOnly) return playAsset.call(this, asset, ...rest);
    this.previewOnly = false;
    try { return await playAsset.call(this, asset, ...rest); } finally { this.previewOnly = true; }
  };

  mk = inst;
  if (cfg.mixedQueue) try { mixedQueueFix(inst); } catch (e) { log('mixedQueueFix', String(e)); }
  if (media._volKnown) adoptVolume(media._vol);
  log('hooked MusicKit', String(window.MusicKit.version));
  return true;
}
