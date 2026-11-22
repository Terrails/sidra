// Part of the wrapper-service hook (assets/agent/hook.js holds the frame and the overview).
// The parts run inside one closure, in the order AGENT_PARTS in src/agent/index.ts lists them,
// and share its names; this one provides:
//   class AgentMedia (the <audio> stand-in) and its instance, media

// ---- the stand-in for the <audio> element --------------------------------
class AgentMedia extends EventTarget {
  constructor() {
    super();
    Object.assign(this, {
      id: '', title: '', autoplay: false, controls: false, muted: false, loop: false, preload: 'metadata',
      playbackRate: 1, defaultPlaybackRate: 1, error: null, readyState: 0, networkState: 0,
      _src: '', _job: null, _gen: 0, _loaded: false, _paused: true, _ended: false, _seeking: false,
      _pos: 0, _posAt: 0, _dur: NaN, _vol: 1, _volKnown: false, _volSetAt: 0, _volBusy: false, _volWant: null,
      _pending: null, _miss: 0, _stopped: 0, _endTimer: 0, _seekWant: null, _seekBusy: false, _attrs: new Map(),
    });
    setInterval(() => { if (this._loaded && !this._paused && !this._seeking) this._fire('timeupdate'); }, 250);
  }

  _fire(type) { queueMicrotask(() => this.dispatchEvent(new Event(type))); }

  // -- attributes MusicKit touches
  get nodeName() { return 'AUDIO'; }
  get tagName() { return 'AUDIO'; }
  get parentNode() { return null; }
  getAttribute(n) { return n === 'src' ? this._src || null : n === 'title' ? this.title || null : this._attrs.get(n) ?? null; }
  setAttribute(n, v) { if (n === 'src') this.src = v; else if (n === 'title') this.title = String(v); else this._attrs.set(n, String(v)); }
  removeAttribute(n) { if (n === 'src') this.src = ''; else if (n === 'title') this.title = ''; else this._attrs.delete(n); }
  hasAttribute(n) { return this.getAttribute(n) !== null; }

  get src() { return this._src; }
  get currentSrc() { return this._src; }
  set src(v) {
    v = String(v || '');
    this._src = v;
    this._gen++;
    this._loaded = false;
    this._pending = null;
    this._ended = false;
    this._seeking = false;
    this._seekWant = null;
    this._miss = this._stopped = 0;
    clearTimeout(this._endTimer);
    this._endTimer = 0;
    this._pos = 0;
    this.readyState = 0;
    this.error = null;
    this._job = null;
    this._dur = NaN;
    if (v.startsWith('amagent:')) {
      try {
        const [body, frag] = v.slice(8).split('#');
        this._job = JSON.parse(decodeURIComponent(body));
        const t = /(?:^|&)t=([\d.]+)/.exec(frag || '');
        if (t) this._job.startMs = Math.round(parseFloat(t[1]) * 1000);
        if (this._job.durMs) this._dur = this._job.durMs / 1000;
      } catch { this._job = null; }
    }
  }

  get paused() { return this._paused; }
  get ended() { return this._ended; }
  get seeking() { return this._seeking; }
  get duration() { return this._dur; }
  get buffered() { return this._ranges(); }
  get seekable() { return this._ranges(); }
  get played() { return this._ranges(); }
  _ranges() {
    const d = this._loaded && Number.isFinite(this._dur) ? this._dur : 0;
    return d ? { length: 1, start: () => 0, end: () => d } : { length: 0, start: () => 0, end: () => 0 };
  }

  get currentTime() {
    if (!this._loaded || this._paused || this._seeking) return this._pos;
    const t = this._pos + (now() - this._posAt) / 1000;
    return Number.isFinite(this._dur) ? Math.min(t, this._dur) : t;
  }
  set currentTime(v) {
    v = Math.max(0, Number(v) || 0);
    if (Number.isFinite(this._dur)) v = Math.min(v, this._dur);
    this._pos = v;
    this._posAt = now();
    if (!this._loaded) return;
    const gen = this._gen;
    this._seeking = true;
    this._seekWant = v;
    clearTimeout(this._endTimer);
    this._endTimer = 0;
    // MusicKit resets an element with "currentTime = 0; removeAttribute('src')": by the time
    // this runs the source is gone and nothing is sent
    queueMicrotask(() => {
      if (gen !== this._gen || !this._loaded) return;
      this._fire('seeking');
      this._seekPump(gen);
    });
  }
  async _seekPump(gen) {
    if (this._seekBusy) return;
    this._seekBusy = true;
    while (this._seekWant !== null && gen === this._gen) {     // a drag sends only the latest target
      const v = this._seekWant;
      this._seekWant = null;
      await send('seek', { ms: v * 1000 });
      if (gen !== this._gen) break;
      this._pos = this._seekWant ?? v;
      this._posAt = now();
    }
    this._seekBusy = false;
    if (gen !== this._gen) return;
    this._seeking = false;
    this._fire('seeked');
    this._fire('timeupdate');
  }

  get volume() { return this._vol; }
  set volume(v) {
    v = Math.min(1, Math.max(0, Number(v) || 0));
    if (Math.abs(v - this._vol) < 0.0005) return;
    this._vol = v;
    this._fire('volumechange');
    // Until the service has told us its volume, the page's idea of it (a stored value, or
    // 100 %) must not reach the speakers: the service's value wins at start-up.
    if (!this._volKnown) return;
    this._volSetAt = now();
    this._volWant = v;
    this._volPump();
  }
  async _volPump() {
    if (this._volBusy) return;
    this._volBusy = true;
    while (this._volWant !== null) {
      const v = this._volWant;
      this._volWant = null;
      await send('volume', { v });
      this._volSetAt = now();
    }
    this._volBusy = false;
  }

  load() {
    this.networkState = 2;
    this._fire('loadstart');
  }

  play() {
    const job = this._job;
    const gen = this._gen;
    if (!job) return Promise.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'));
    const aborted = () => new DOMException('The play() request was interrupted by a new load request.', 'AbortError');

    if (this._loaded) {                               // resume
      if (!this._paused) return Promise.resolve();
      this._paused = false;
      this._ended = false;
      this._posAt = now();
      this._fire('play');
      return send('resume').then((r) => {
        if (gen !== this._gen) throw aborted();
        if (!r.ok) { this._paused = true; this._fire('pause'); throw aborted(); }
        this._posAt = now();
        this._fire('playing');
      });
    }

    if (this._pending) { this._paused = false; return this._pending; }
    this._paused = false;
    this._pending = (async () => {
      log('play', job);
      const r = await send('play', { song: job.song, album: job.album, storefront: job.cc }, () => gen !== this._gen);
      if (gen !== this._gen) throw aborted();
      if (!r.ok) throw this._fail(r.error || 'The player engine could not start this track.');
      const s = await waitStatus((x) => x.playing && matches(x, job), 15000);
      if (gen !== this._gen) throw aborted();
      if (!s) throw this._fail('The player engine did not start this track.');
      this._pending = null;
      this._loaded = true;
      this.readyState = 4;
      this.networkState = 1;
      if (s.nowPlaying.durationMs) this._dur = s.nowPlaying.durationMs / 1000;
      this._pos = (s.nowPlaying.positionMs || 0) / 1000;
      this._posAt = now();
      this._fire('durationchange');
      this._fire('loadedmetadata');
      this._fire('progress');
      this._fire('canplay');
      if (job.startMs > 1000) this.currentTime = job.startMs / 1000;
      if (this._paused) {                             // paused while it was loading
        send('pause');
        this._fire('pause');
      } else this._fire('playing');
      log('playing', job.title, 'dur', this._dur);
    })();
    this._pending.catch(() => {});
    return this._pending;
  }

  _fail(message) {
    log('failed:', message);
    this._pending = null;
    this._paused = true;
    this.error = { code: 4, message, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 };
    this._fire('error');
    return new DOMException(message, 'NotSupportedError');
  }

  pause() {
    if (this._paused) return;
    this._paused = true;
    if (this._loaded) {
      this._pos = Number.isFinite(this._dur) ? Math.min(this._pos + (now() - this._posAt) / 1000, this._dur) : this._pos;
      clearTimeout(this._endTimer);
      this._endTimer = 0;
      send('pause');
    }
    this._fire('pause');
  }

  // the track is over (or about to be): MusicKit moves on to the next queue item
  _finish(why) {
    if (!this._loaded) return;
    log('ended', why);
    clearTimeout(this._endTimer);
    this._endTimer = 0;
    this._loaded = false;
    this._paused = true;
    this._ended = true;
    if (Number.isFinite(this._dur)) this._pos = this._dur;
    send('pause');           // keep the engine from continuing with a track of its own choosing
    this._fire('ended');
  }

  _onStatus(s) {
    if (typeof s.volume === 'number') {
      if (!this._volKnown) {
        this._volKnown = true;
        this._vol = s.volume;
        adoptVolume(s.volume);
      } else if (!this._volBusy && now() - this._volSetAt > 1500 && Math.abs(s.volume - this._vol) > 0.01) {
        this._vol = s.volume;                          // changed from outside (amctl or another client)
        adoptVolume(s.volume);
        this._fire('volumechange');
      }
    }
    if (!this._loaded || busy || now() - lastCmdAt < 400 || this._seeking) return;
    const job = this._job;
    const np = s.nowPlaying;

    if (!matches(s, job)) {
      // The engine is on something else. Near the end of our track that is its own autoplay;
      // otherwise somebody else started a track: leave it alone and show ours as paused.
      if (++this._miss < 3) return;
      const left = this._dur - this.currentTime;
      if (!this._paused && left < 5) { this._finish('engine moved on'); return; }
      log('engine plays something else; pausing our item');
      this._loaded = false;
      this.readyState = 0;
      if (!this._paused) { this._paused = true; this._fire('pause'); }
      return;
    }
    this._miss = 0;

    if (np.durationMs && Math.abs(np.durationMs / 1000 - this._dur) > 0.5) {
      this._dur = np.durationMs / 1000;
      this._fire('durationchange');
    }
    this._pos = (np.positionMs || 0) / 1000;
    this._posAt = now();

    if (s.paused && !this._paused) { this._paused = true; this._fire('pause'); }
    else if (s.playing && this._paused) { this._paused = false; this._ended = false; this._fire('playing'); }
    else if (!s.playing && !s.paused && !this._paused) {         // stopped by itself
      if (++this._stopped >= 3) this._finish('engine stopped');
      return;
    }
    this._stopped = 0;

    if (!this._paused && !this._endTimer && Number.isFinite(this._dur)) {
      const leftMs = (this._dur - this._pos) * 1000;
      if (leftMs < 1500) this._endTimer = setTimeout(() => { this._endTimer = 0; this._finish('end of track'); }, Math.max(0, leftMs - END_CUT_MS));
    }
  }
}

const media = new AgentMedia();
window.__amAgentMedia = media;                         // for debugging from DevTools
