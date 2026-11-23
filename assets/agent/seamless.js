// Part of the wrapper-service hook (assets/agent/hook.js holds the frame and the overview).
// The parts run inside one closure, in the order AGENT_PARTS in src/agent/index.ts lists them,
// and share its names; this one provides:
//   seam, seamNext(), seamStatus(), seamCheck(), seamHanded(), seamReady(), seamDrop(), seamAdopt()

// ---- seamless transitions -----------------------------------------------------
// Each queue item is its own /play, and AgentMedia pauses the engine just before the end, so
// tracks are separated by the engine's load time. With a service that has a queue API
// (status.upNext), MusicKit's next item is added to the engine's queue ("Play Next", /enqueue)
// SEAM_LEAD_MS (plus the crossfade seconds) before the end. Once the engine
// shows it as its next item, the current item is not paused at the end: the engine goes on by
// itself (gapless; an engine that crossfades switches that many seconds early, though under
// Wine it does not), the current item ends when the engine shows the new song, and MusicKit's
// next item then takes over the track that is already playing (seamAdopt()) instead of
// sending /play. Only when both items are catalogue
// songs that MusicKit plays one after the other (not with repeat-one, nor when MusicKit
// stops after the item); a queue change, shuffle or repeat toggle, skip or new queue takes
// the item out of the engine's queue again (/dequeue). Anything else keeps the pause at the
// end. Off with AM_WEBUI_SEAMLESS=0 (cfg.seamless, src/agent/index.ts).
const SEAM_LEAD_MS = 25000;
// closer to the end than this (plus crossfade), no enqueue: the service answers nothing else
// while it runs, up to about 13 s for a song the album page does not have (404) and 15 s for a
// failed menu, so the pause at the end would come too late
const SEAM_MIN_MS = 16000;
const SEAM_GRACE_MS = 4000;    // an engine that has not gone on this long after the end is paused (the old way)
const seam = {
  enq: null,       // { gen, song, itemId, qid, ok }: MusicKit's next item, added for AgentMedia item
                   //   gen (qid: the engine's queue item ID, undefined while /enqueue runs; ok: seamReady())
  handoff: null,   // { song, at }: the engine went on into it; MusicKit's next play() takes it over
  stale: [],       // { qid, song, at }: items to take out of the engine's queue (qid '': looked up by song in upNext)
  tried: -1,       // the AgentMedia item gen the last /enqueue was sent for (once per item)
  off: false,      // the service answered /enqueue with 404 (no queue API)
};

const seamOn = (s) => !!cfg.seamless && !seam.off && !!s && Array.isArray(s.upNext);
const seamFade = (s) => (s && s.crossfade && s.crossfade.on && s.crossfade.seconds > 0 ? s.crossfade.seconds * 1000 : 0);

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

// a status, before AgentMedia looks at it: queue items that are out of date leave the engine's
// queue, once no command is running (after a /play that replaced the current item; MusicKit may
// call play() a moment after it set the new item, so that is waited for up to 2 s)
function seamStatus(s, m) {
  if (!seam.stale.length || busy || m._pending) return;
  if (m._job && !m._loaded && !m._ended && now() - seam.stale[0].at < 2000) return;
  const x = seam.stale.shift();
  // an /enqueue that answered without an ID (the item showed up late): found by its song, not
  // a dequeue of everything, which would take a newer item with it
  const u = !x.qid && s && Array.isArray(s.upNext) && s.upNext.find((t) => t.songId === x.song && t.section !== 'autoplay');
  const id = x.qid || (u && u.queueItemId);
  const np = s && s.nowPlaying;
  if (!id || (np && np.queueItemId === id)) {        // not (yet) in the queue, or it plays already: left alone
    log('seamless: not dequeued', x.song, id || 'not in the queue');
    return;
  }
  log('seamless: dequeue', id);
  send('dequeue', { id });
}

function seamDrop(why) {
  const e = seam.enq;
  if (!e) return;
  seam.enq = null;
  seam.tried = -1;
  log('seamless: dropped', e.song, why);
  if (e.qid === undefined) e.dropped = true;        // still being added: taken out when /enqueue answers
  else seam.stale.push({ qid: e.qid, song: e.song, at: now() });
}

async function seamEnqueue(gen, n) {
  const e = { gen, song: n.song, itemId: n.itemId, qid: undefined };
  seam.enq = e;
  seam.tried = gen;
  log('seamless: enqueue', n);
  const r = await send('enqueue', { song: n.song, album: n.album, storefront: n.cc });
  if (!r.ok) {
    log('seamless: enqueue failed', r.error || r);
    if (/unknown endpoint/i.test(String(r.error || ''))) seam.off = true;
    if (seam.enq === e) seam.enq = null;
    return;
  }
  e.qid = String(r.queueItemId || '');
  if (e.dropped) seam.stale.push({ qid: e.qid, song: e.song, at: now() });
}

// the engine plays the item added for AgentMedia item gen: its queue went on by itself
function seamHanded(s, gen, job) {
  const e = seam.enq;
  const np = s.nowPlaying;
  if (!e || e.gen !== gen || !np) return false;
  if (e.qid && np.queueItemId) return np.queueItemId === e.qid;
  return !!np.songId && np.songId === e.song && e.song !== String(job.song);
}

// the engine has shown the added item as its next one: the current item can run to its end
// (kept while upNext is empty: it is, for a moment, while the engine moves on)
function seamReady(s, gen) {
  const e = seam.enq;
  if (!e || e.gen !== gen || e.qid === undefined) return false;
  const u = seamOn(s) && s.upNext[0];
  if (u) e.ok = e.qid && u.queueItemId ? u.queueItemId === e.qid : u.songId === e.song;
  if (e.ok && !e.qid && u && u.queueItemId) e.qid = u.queueItemId;   // /enqueue answered without one
  return !!e.ok;
}

// on every status of the playing AgentMedia item m (job): add MusicKit's next item in time, and
// take it out again when it is no longer next
function seamCheck(s, m, job) {
  const e = seam.enq;
  if (e && e.gen === m._gen) {
    if (!seamOn(s)) { seam.enq = null; return; }   // the service was replaced by one without a queue API
    const n = seamNext(job);
    if (!n || n.song !== e.song || n.itemId !== e.itemId) seamDrop(n ? `next is now ${n.song}` : 'no next item');
    return;
  }
  if (!seamOn(s) || m._paused || seam.tried === m._gen || !Number.isFinite(m._dur)) return;
  const fade = seamFade(s);
  const left = (m._dur - m._pos) * 1000;
  if (left > fade + SEAM_LEAD_MS || left < fade + SEAM_MIN_MS) return;
  const n = seamNext(job);
  if (n) seamEnqueue(m._gen, n);
}

// MusicKit's next item (job) is the song the engine went on into: true when the play() of it
// takes over what plays instead of sending /play (once)
function seamAdopt(job) {
  const h = seam.handoff;
  seam.handoff = null;
  const np = status && status.nowPlaying;
  return !!(h && h.song === String(job.song) && now() - h.at < 30000 && np && np.songId === h.song);
}
