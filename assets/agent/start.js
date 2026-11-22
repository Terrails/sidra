// Part of the wrapper-service hook (assets/agent/hook.js holds the frame and the overview).
// The parts run inside one closure, in the order AGENT_PARTS in src/agent/index.ts lists them,
// and share its names; this one provides:
//   start-up: the 300 ms MusicKit watch (restriction off, hooks) and the status subscription

setInterval(() => {                                    // MusicKit configures itself after page load
  try { qualityEnsure(); } catch (e) { log('quality button', String(e)); }
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
