// Part of the wrapper-service hook (assets/agent/hook.js holds the frame and the overview).
// The parts run inside one closure, in the order AGENT_PARTS in src/agent/index.ts lists them,
// and share its names; this one provides:
//   the Shuffle button on Library > Songs: shuffleEnsure()

// ---- Shuffle on Library > Songs ---------------------------------------------
// The web page has Play/Shuffle buttons on albums and playlists but none for the whole library,
// and a song started from the Songs list queues only the rows the page has loaded. This button
// fetches every library song (/v1/me/library/songs, 100 a page) and queues them with MusicKit's
// own shuffle on: with shuffleMode set first, setQueue shuffles the new queue and play() starts
// at its first item; the player bar's shuffle toggle shows it, and turning it off goes back to
// library order. On unless AM_WEBUI_LIBRARY_SHUFFLE=0 (cfg.libraryShuffle, src/agent/index.ts).
// (styles: assets/agent/style.css)
const shuffle = { btn: null, busy: false };
const SHUFFLE_LOAD_MS = 60000;

function shuffleIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  // two crossing arrows (the page CSP allows no markup strings, so built as nodes)
  path.setAttribute('d', 'M1.5 4h2.6c1.2 0 2 .5 2.7 1.5l2.4 5c.6 1 1.4 1.5 2.6 1.5h1.7M12 10l1.7 2-1.7 2M1.5 12h2.6c1 0 1.8-.4 2.4-1.1M9.6 5.1c.6-.7 1.4-1.1 2.4-1.1h1.7M12 2l1.7 2L12 6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function shuffleLabel(text) {
  const b = shuffle.btn;
  if (!b) return;
  b.replaceChildren(shuffleIcon(), document.createTextNode(text));
}

async function shuffleLibrary() {
  const inst = mk || (window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance());
  if (!inst || shuffle.busy) return;
  shuffle.busy = true;
  if (shuffle.btn) { shuffle.btn.disabled = true; shuffle.btn.removeAttribute('title'); }
  shuffleLabel('Loading…');
  const t0 = Date.now();
  try {
    const songs = await withTimeout(containerTracks(inst, '/v1/me/library/songs'), SHUFFLE_LOAD_MS);
    if (!songs.length) throw new Error('the library has no songs');
    const loadMs = Date.now() - t0;
    if (songs.total != null && songs.length < songs.total) log('library shuffle: only', songs.length, 'of', songs.total, 'songs arrived');
    if (inst.shuffleMode !== 1) {                      // MusicKit.PlayerShuffleMode.songs
      // the write reshuffles the queue that is there on the main thread (seconds for a long
      // one, see fastPlaylistQueue.js): empty it first, the new one replaces it anyway
      if (inst.queue && inst.queue.length > 1 && typeof inst.clearQueue === 'function') await inst.clearQueue();
      inst.shuffleMode = 1;
    }
    await inst.setQueue({ items: songs, startPlaying: false });
    await inst.play();
    log('library shuffle:', songs.length, 'songs, loaded in', loadMs, 'ms, playing after', Date.now() - t0, 'ms');
  } catch (e) {
    log('library shuffle failed:', String(e));
    if (shuffle.btn) shuffle.btn.title = 'Could not load the library';
  } finally {
    shuffle.busy = false;
    if (shuffle.btn) shuffle.btn.disabled = false;
    shuffleLabel('Shuffle');
  }
}

// the header is the page's (it is shared by the library pages and rebuilt on navigation):
// the button goes into it on Library > Songs while signed in, and out again elsewhere
function shuffleEnsure() {
  const inst = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
  const host = /^(?:\/[a-z]{2})?\/library\/songs\/?$/.test(location.pathname) && inst && inst.isAuthorized
    ? document.querySelector('.header-nav--library-header .header-nav__action') : null;
  if (!host) {
    if (shuffle.btn) { shuffle.btn.remove(); shuffle.btn = null; }
    return;
  }
  if (shuffle.btn && shuffle.btn.isConnected && host.contains(shuffle.btn)) return;
  if (shuffle.btn) shuffle.btn.remove();
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'amagent-shuffle';
  b.setAttribute('aria-label', 'Shuffle all library songs');
  b.addEventListener('click', (e) => { e.stopPropagation(); shuffleLibrary(); });
  host.classList.add('amagent-shuffle-host');
  host.prepend(b);
  shuffle.btn = b;
  b.disabled = shuffle.busy;
  shuffleLabel(shuffle.busy ? 'Loading…' : 'Shuffle');
}
