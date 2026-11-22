// Part of the wrapper-service hook (assets/agent/hook.js holds the frame and the overview).
// The parts run inside one closure, in the order AGENT_PARTS in src/agent/index.ts lists them,
// and share its names; this one provides:
//   mk, agentPlayer, adoptVolume(), jobFor(), unrestrict(inst), hook(inst)

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
  if (media._volKnown) adoptVolume(media._vol);
  log('hooked MusicKit', String(window.MusicKit.version));
  return true;
}
