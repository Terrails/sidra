// Part of the wrapper-service hook (assets/agent/hook.js holds the frame and the overview).
// The parts run inside one closure, in the order AGENT_PARTS in src/agent/index.ts lists them,
// and share its names; this one provides:
//   start-up: the stale tip timestamp, the 300 ms MusicKit watch (buttons, restriction off, hooks)
//   and the status subscription

// The page stores when it first showed its "Transfer music" tip (localStorage
// transfer-music-bubble-tip-first-view-<user>, milliseconds). Once that is more than 7 days old the
// page locks up a few seconds after load: the renderer spins and grows by ~70 MB/s until the machine
// swaps (it also happens with every Sidra and agent injection off, so it is the page's own bug; 6.9
// days fine, 7.1 days frozen). The page reads the key after load, so refreshing it here is in time.
try {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('transfer-music-bubble-tip-first-view') && Date.now() - Number(localStorage.getItem(k)) > 864e5) {
      localStorage.setItem(k, String(Date.now()));
      log('transfer-music tip timestamp refreshed (the page freezes when it is over 7 days old)');
    }
  }
} catch (e) { log('tip timestamp', String(e)); }

setInterval(() => {                                    // MusicKit configures itself after page load
  try { qualityEnsure(); } catch (e) { log('quality button', String(e)); }
  if (cfg.libraryShuffle) try { shuffleEnsure(); } catch (e) { log('shuffle button', String(e)); }
  try {
    const inst = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
    if (!inst) return;
    if (cfg.unrestrict) try { unrestrict(inst); } catch (e) { log('unrestrict', String(e)); }
    hook(inst);
    // signed out of the web page, MusicKit stops after every track; the queue should run on
    const pc = inst._playbackController;
    if (pc && pc._continuous === false) pc._continuous = true;
  } catch { /* not configured yet */ }
}, 300);

bridge.onStatus((s) => {
  status = s;
  if (s && quality.want && s.quality === quality.want) quality.want = null;
  qualityRender();
  if (!s || s.engine !== 'ready') return;
  for (const w of [...waiters]) {
    if (w.pred(s)) { waiters.delete(w); w.resolve(s); }
  }
  media._onStatus(s);
});
