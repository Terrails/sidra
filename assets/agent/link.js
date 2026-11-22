// Part of the wrapper-service hook (assets/agent/hook.js holds the frame and the overview).
// The parts run inside one closure, in the order AGENT_PARTS in src/agent/index.ts lists them,
// and share its names; this one provides:
//   send(), waitStatus(), matches(), status, busy/lastCmdAt, now(), log(), END_CUT_MS

const END_CUT_MS = 200;        // hand over to the next queue item this long before the track ends
const now = () => performance.now();
const log = (...a) => { if (cfg.debug) bridge.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// ---- service link: commands run one at a time, in order ------------------
let status = null;
let busy = 0;
let lastCmdAt = 0;
let chain = Promise.resolve();
const waiters = new Set();

function send(name, arg, skip) {
  const run = async () => {
    if (skip && skip()) return { ok: false, skipped: true };
    busy++;
    try {
      return (await bridge.cmd(name, arg)) || { ok: false, error: 'no reply' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      busy--;
      lastCmdAt = now();
    }
  };
  const p = chain.then(run);
  chain = p.catch(() => {});
  return p;
}

// resolves with the first later status that satisfies pred, or null after ms
function waitStatus(pred, ms) {
  return new Promise((resolve) => {
    const w = { pred, resolve };
    waiters.add(w);
    setTimeout(() => { if (waiters.delete(w)) resolve(null); }, ms);
  });
}

function matches(s, job) {
  const np = s && s.nowPlaying;
  if (!np) return false;
  // the service reports the catalogue ID; title/duration stay as a fallback (an equivalent
  // track with another ID, a service without songId)
  if (np.songId && job.song && np.songId === String(job.song)) return true;
  if (norm(np.title) === norm(job.title)) return true;
  return !!(job.durMs && np.durationMs && Math.abs(np.durationMs - job.durMs) < 2500);
}
