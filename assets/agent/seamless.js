// Part of the wrapper-service hook (assets/agent/hook.js holds the frame and the overview).
// The parts run inside one closure, in the order AGENT_PARTS in src/agent/index.ts lists them,
// and share its names; this one provides:
//   seam, seamNext(), seamAfter(), seamStatus(), seamCheck(), seamHanded(), seamPassed(),
//   seamReady(), seamDrop(), seamSource(), seamAdopt(), seamSkip(), seamWith(), seamWithDone(), seamAhead()

// ---- seamless transitions -----------------------------------------------------
// Each queue item is its own /play, and AgentMedia pauses the engine just before the end, so
// tracks are separated by the engine's load time. With a service that has a queue API
// (status.upNext), MusicKit's next item is added to the engine's queue ("Play Next", /enqueue)
// SEAM_LEAD_MS (plus the crossfade seconds) before the end. Once the engine shows it as its
// next item, the current item is not paused at the end: the engine goes on by itself, the
// current item ends when the engine shows the new song, and MusicKit's next item then takes over
// the track that is already playing (seamAdopt()) instead of sending /play. An engine that
// crossfades switches to the new song early, by up to the crossfade seconds; that ends the
// item too. Only when both items are catalogue songs that MusicKit plays one after the other
// (not with repeat-one, nor when MusicKit stops after the item); a queue change, shuffle or
// repeat toggle, skip or new queue takes the item out of the engine's queue again (/dequeue),
// except a skip to the item that is next in the engine's queue: that sends /next (seamSkip()),
// and the item after it stays queued.
// Anything else keeps the pause at the end. Off with AM_WEBUI_SEAMLESS=0 (cfg.seamless,
// src/agent/index.ts).
// With quality "aac" and crossfade on (seamAhead()), the engine's docs (docs/api.md) say the
// next song only crossfades when it was queued before the current one started. Sidra then
// stays two items ahead: the next item as soon as the current one has started and settled, and
// the one after it with at=end ("Add to Queue": the end of the added items, in order). The
// list seam.q holds those entries in engine order; after a hand-over the second becomes the
// first for the next item. Everything else keeps the single item and the window above.
// A skip to MusicKit's next item would otherwise cost the next crossfade too: a /play starts
// the item with nothing queued behind it. /next moves the engine on into the item, with the
// one after it already queued. And a /play (a new queue, a pick from a list) names MusicKit's next
// item (seamWith(): next=&nextAlbum=): the engine queues it before the played song goes on (a
// pause, Play Next, a play), so its end is crossfaded too.
const SEAM_LEAD_MS = 25000;
// closer to the end than this (plus crossfade), no enqueue: while /enqueue runs the service
// answers only /status, and it can take up to about 20 s, so the pause at the end would come
// too late
const SEAM_MIN_MS = 16000;
const SEAM_GRACE_MS = 4000;    // an engine that has not gone on this long after the end is paused (the old way)
// chosen, not measured: after a command, and after the item started, before an item is added with
// seamAhead() (also inside the fade-out of the previous item: measured fine, 2026-11-26); and how
// long MusicKit may take to set the next item after a hand-over
const SEAM_SETTLE_MS = 3000;
const SEAM_MOVE_MS = 2000;
const SKIP_WAIT_MS = 10000;    // how long the engine may take to show the item after a /next (chosen)
const seam = {
  q: [],           // { song, itemId, qid, ok, dropped }: MusicKit's next items (2 at most), in the engine's
                   //   order (qid: the engine's queue item ID, undefined while /enqueue runs; ok: seamReady())
  handoff: null,   // { song, at }: the engine went on into it; MusicKit's next play() takes it over
  skip: null,      // { song, qid }: MusicKit skipped to the engine's next item; its play() sends /next
  stale: [],       // { qid, song, at }: items to take out of the engine's queue (qid '': looked up by song in upNext)
  tried: -1,       // the AgentMedia item gen in which an /enqueue failed (or the queue API went away)
  bad: null,       // the song of the last failed /enqueue: not sent again with seamAhead()
  noEnd: false,    // "Add to Queue" is not available (500 80004001)
  adoptedAt: -Infinity,
  off: false,      // the service answered /enqueue with 404 (no queue API)
};

const seamOn = (s) => !!cfg.seamless && !seam.off && !!s && Array.isArray(s.upNext);
const seamFade = (s) => (s && s.crossfade && s.crossfade.on && s.crossfade.seconds > 0 ? s.crossfade.seconds * 1000 : 0);
// two items ahead: the engine's AAC player decides about a crossfade when it starts an item
const seamAhead = (s) => !!s && s.quality === 'aac' && seamFade(s) > 0 && !seam.noEnd;

// the job of MusicKit's next item, if it plays right after the current one (job), else null
function seamNext(job) {
  const q = mk && mk.queue;
  if (!q || !job) return null;
  if (mk.repeatMode === 1) return null;              // MusicKit.PlayerRepeatMode.one: the item plays again
  if (mk.continuous === false) return null;          // MusicKit stops after the item
  const c = jobFor(q.currentItem);
  if (!c || c.song !== job.song) return null;        // MusicKit is elsewhere already
  const item = q.nextPlayableItem;                   // honours repeat-all, shuffle order, autoplay items
  const n = jobFor(item);
  if (!n || n.song === job.song) return null;        // the same song again would not be told apart
  n.itemId = String(item.id);
  return n;
}

// the job of the item after n (seamNext()'s result), if MusicKit's list says so without doubt,
// else null: no wrap-around, nothing that is not loaded yet, nothing the same song again
function seamAfter(job, n) {
  try {
    const { items, position: p } = mk.queue;
    const cur = mk.queue.currentItem;
    if (!Array.isArray(items) || !Number.isSafeInteger(p) || p < 0 || !cur) return null;
    if (String(items[p] && items[p].id) !== String(cur.id)) return null;
    if (String(items[p + 1] && items[p + 1].id) !== n.itemId) return null;
    const it = items[p + 2];
    if (!it || it.isPlayable === false) return null;
    if (!(it.playParams || (it.attributes && it.attributes.playParams))) return null;
    const x = jobFor(it);
    if (!x || x.song === job.song || x.song === n.song) return null;
    x.itemId = String(it.id);
    return x;
  } catch { return null; }
}

// a status, before AgentMedia looks at it: queue items that are out of date leave the engine's
// queue, once no command is running (after a /play that replaced the current item; MusicKit may
// call play() a moment after it set the new item, so that is waited for up to 2 s)
function seamStatus(s, m) {
  if (seam.handoff && now() - seam.handoff.at > 30000) { seam.handoff = null; seamDrop('hand-over not taken'); }
  if (!seam.stale.length || busy || m._pending) return;
  if (m._job && !m._loaded && !m._ended && now() - seam.stale[0].at < 2000) return;
  const x = seam.stale.shift();
  // an /enqueue that answered without an ID (the item showed up late): found by its song, not
  // a dequeue of everything, which would take a newer item with it
  const u = !x.qid && s && Array.isArray(s.upNext) && s.upNext.find((t) => t.songId === x.song && t.section !== 'autoplay');
  const id = x.qid || (u && u.queueItemId);
  const np = s && s.nowPlaying;
  if (id && np && np.queueItemId === id && m._loaded) {
    // the engine switched into it before the dequeue: it must not pass for the current item
    // (matches() falls back on the duration). Paused: not before the resume, MusicKit would play on
    if (m._paused && !s.playing) seam.stale.unshift(x);
    else m._finish('engine plays a dropped item');
    return;
  }
  if (!id || (np && np.queueItemId === id)) {        // not (yet) in the queue, or it plays already: left alone
    log('seamless: not dequeued', x.song, id || 'not in the queue');
    return;
  }
  log('seamless: dequeue', id);
  send('dequeue', { id });
}

// takes the entries from index `from` out of the engine's queue (the last first, so an entry
// never outlasts the one before it)
function seamDrop(why, from = 0) {
  if (seam.q.length <= from) return;
  for (const e of seam.q.splice(from).reverse()) {
    log('seamless: dropped', e.song, why);
    if (e.qid === undefined) e.dropped = true;      // still being added: taken out when /enqueue answers
    else seam.stale.push({ qid: e.qid, song: e.song, at: now() });
  }
  seam.tried = -1;
}

// end: with at=end (after the items already added), else Play Next
async function seamEnqueue(gen, n, end) {
  const e = { song: n.song, itemId: n.itemId, qid: undefined };
  seam.q.push(e);
  log('seamless: enqueue', n, end ? 'end' : 'next');
  const r = await send('enqueue', { song: n.song, album: n.album, storefront: n.cc, ...(end && { at: 'end' }) });
  if (!r.ok) {
    log('seamless: enqueue failed', r.error || r);
    const i = seam.q.indexOf(e);
    if (i >= 0) seam.q.splice(i, 1);
    if (/unknown endpoint/i.test(String(r.error || ''))) seam.off = true;
    if (!e.dropped) {
      seam.tried = gen;
      if (end && r.hresult === '80004001') seam.noEnd = true;
      else seam.bad = n.song;
    }
    return;
  }
  e.qid = String(r.queueItemId || '');
  seam.bad = null;
  if (e.dropped) seam.stale.push({ qid: e.qid, song: e.song, at: now() });
}

// the engine plays the current item's added item: its queue went on by itself
function seamIs(e, np, job) {
  if (!np) return false;
  if (e.qid && np.queueItemId) return np.queueItemId === e.qid;
  return !!np.songId && np.songId === e.song && e.song !== String(job.song);
}
const seamHanded = (s, job) => !!(seam.q[0] && seamIs(seam.q[0], s.nowPlaying, job));
// the engine plays the second added item: it passed over the first
const seamPassed = (s) => !!(seam.q[1] && seam.q[1].qid && s.nowPlaying && s.nowPlaying.queueItemId === seam.q[1].qid);

// the engine has shown the added item as its next one: the current item can run to its end
// (kept while upNext is empty: it is, for a moment, while the engine moves on)
function seamReady(s) {
  if (seamOn(s)) {
    seam.q.forEach((e, i) => {
      const u = s.upNext[i];
      if (!u || e.qid === undefined) return;
      e.ok = e.qid && u.queueItemId ? u.queueItemId === e.qid : u.songId === e.song;
      if (e.ok && !e.qid && u.queueItemId) e.qid = u.queueItemId;   // /enqueue answered without one
    });
  }
  const e = seam.q[0];
  return !!(e && e.qid !== undefined && e.ok);
}

// on every status of the playing AgentMedia item m (job): add MusicKit's next item (and, with
// seamAhead(), the one after it) in time, and take them out again when they are no longer next
function seamCheck(s, m, job) {
  const q = seam.q;
  let n;
  if (q.length) {
    if (!seamOn(s)) { seam.q = []; seam.tried = m._gen; return; }   // the service was replaced by one without a queue API
    n = seamNext(job);
    if (!n && now() - seam.adoptedAt < SEAM_MOVE_MS) return;        // MusicKit sets its next item a moment after play()
    if (!n || n.song !== q[0].song || n.itemId !== q[0].itemId) {
      seamDrop(n ? `next is now ${n.song}` : 'no next item');
      return;
    }
    if (q[1]) {
      const x = seamAfter(job, n);
      if (!x || x.song !== q[1].song || x.itemId !== q[1].itemId) seamDrop('item after next changed', 1);
      return;
    }
  }
  if (!seamOn(s) || m._paused || seam.tried === m._gen || !Number.isFinite(m._dur)) return;
  const fade = seamFade(s);
  const left = (m._dur - m._pos) * 1000;
  if (left < fade + SEAM_MIN_MS) return;
  if (!seamAhead(s)) {
    if (!q.length && left <= fade + SEAM_LEAD_MS && (n = seamNext(job))) seamEnqueue(m._gen, n);
    return;
  }
  // not while items are being taken out (the order), nor right after a command or the start
  if (seam.stale.length || now() - lastCmdAt < SEAM_SETTLE_MS || m._pos * 1000 < SEAM_SETTLE_MS) return;
  // an unknown duration of the next item: one only
  const x = !q.length ? seamNext(job) : q[0].ok && n.durMs >= fade + SEAM_MIN_MS ? seamAfter(job, n) : null;
  if (x && x.song !== seam.bad) seamEnqueue(m._gen, x, q.length > 0);
}

// the engine's next item is this entry (qid), confirmed in the latest status, and not playing yet
function seamFirst(e) {
  const s = status, u = s && Array.isArray(s.upNext) && s.upNext[0];
  return !!(e && e.qid && u && u.queueItemId === e.qid && s.nowPlaying && s.nowPlaying.queueItemId !== e.qid);
}

// the src of AgentMedia was set (job: the new item, if any): its entries stay only for the
// hand-over that is taken over, or for a skip to the engine's next item (seamSkip())
function seamSource(job) {
  seam.skip = null;
  if (seam.handoff && (!job || String(job.song) === seam.handoff.song)) return;
  const e = seam.q[0];
  if (!seam.handoff && job && e && e.ok && String(job.song) === e.song && seamFirst(e)) {
    seam.q.shift();
    seam.skip = { song: e.song, qid: e.qid };
    log('seamless: skip into', e.song, e.qid);
    return;
  }
  seamDrop('item replaced');                         // skip, previous, a new queue
}

// MusicKit's next item (job) is the song the engine went on into: true when the play() of it
// takes over what plays instead of sending /play (once)
function seamAdopt(job) {
  const h = seam.handoff;
  seam.handoff = null;
  const np = status && status.nowPlaying;
  const ok = !!(h && h.song === String(job.song) && now() - h.at < 30000 && np && np.songId === h.song);
  if (ok) seam.adoptedAt = now();
  return ok;
}

// MusicKit skipped to the engine's next item (job, seamSource()): the entry for play() to send
// /next for, while the engine still has it next (once), else null
function seamSkip(job) {
  const k = seam.skip;
  seam.skip = null;
  if (!k || k.song !== String(job.song) || !seamFirst(k)) return null;
  seam.adoptedAt = now();
  return k;
}

// a /play of job, or a /next into it with nothing queued behind it, with AAC and crossfade:
// MusicKit's next item goes with it (next=), and its entry heads seam.q while the command runs;
// null when there is none or the song is too short for it
function seamWith(job) {
  const s = status;
  if (!seamOn(s) || !seamAhead(s) || seam.q.length) return null;
  if (job.durMs && job.durMs < seamFade(s) + SEAM_MIN_MS) return null;
  const n = seamNext(job);
  if (!n || n.song === seam.bad) return null;
  const e = { song: n.song, itemId: n.itemId, qid: undefined, album: n.album };
  seam.q.push(e);
  log('seamless: play with next', n);
  return e;
}

// the answer r of that /play or /next: the entry gets its queue item, or goes (not queued, or a service
// without next=: queued later in the track as before)
function seamWithDone(e, r) {
  const queued = !!(r && r.ok && typeof r.nextQueueItemId === 'string');
  if (queued && e.dropped) { seam.stale.push({ qid: r.nextQueueItemId, song: e.song, at: now() }); return; }
  if (queued) { e.qid = r.nextQueueItemId; return; }
  const i = seam.q.indexOf(e);
  if (i >= 0) seam.q.splice(i, 1);
  if (r && r.nextQueued === false) log('seamless: next not queued with the command', e.song);
}
