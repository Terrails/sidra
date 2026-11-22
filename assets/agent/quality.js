// Part of the wrapper-service hook (assets/agent/hook.js holds the frame and the overview).
// The parts run inside one closure, in the order AGENT_PARTS in src/agent/index.ts lists them,
// and share its names; this one provides:
//   the audio quality button in the player bar: qualityEnsure(), qualityRender(), quality

// ---- audio quality button in the player bar ---------------------------------
// (styles: assets/agent/style.css, inserted by the main process: the page CSP blocks our own <style>)
const QUALITIES = [['aac', 'AAC', 'High Quality (AAC)'], ['lossless', 'Lossless', 'Lossless'], ['hires', 'Hi-Res', 'Hi-Res Lossless']];
const quality = { btn: null, menu: null, want: null, wantAt: 0 };

function qualityNow() {
  if (quality.want && now() - quality.wantAt < 3000) return quality.want;    // just picked; the service has not confirmed yet
  return (status && status.quality) || null;
}

// how good a format is, and the floor each setting asks for (Atmos/spatial/surround are not lossless)
const FORMAT_RANK = { other: 0, lossless: 1, hires: 2 };
const FLOOR = { aac: 0, lossless: 1, hires: 2 };

// 'met' / 'partial' / 'short' by how far what plays is below the chosen floor, null while unknown:
// nothing playing, no setting yet, or the first seconds of a track (format "other" with sample
// rate "0", the AAC variant played before the stream switches)
function qualityLevel(np, q) {
  if (!np || !np.format || !(Number(np.sampleRate) > 0) || !(q in FLOOR)) return null;
  const gap = FLOOR[q] - (FORMAT_RANK[np.format] || 0);
  return gap <= 0 ? 'met' : gap === 1 ? 'partial' : 'short';
}

// "24-bit/88.2 kHz", or "44.1 kHz" (the engine reports the bit depth for hi-res, rarely otherwise)
function formatDetail(np) {
  if (!np) return '';
  const rate = Number(np.sampleRate) > 0 ? `${np.sampleRate} kHz` : '';
  const depth = Number(np.bitDepth) > 0 ? `${np.bitDepth}-bit` : '';
  return depth && rate ? `${depth}/${rate}` : rate;
}

function qualityRender() {
  const q = qualityNow();
  const b = quality.btn;
  if (b) {
    const row = QUALITIES.find((x) => x[0] === q);
    b.textContent = row ? row[1] : '···';
    b.disabled = !row;
    const np = status && status.nowPlaying;
    // green while what plays reaches the chosen floor, yellow one step below it (lossless for
    // Hi-Res, AAC for Lossless), red two steps below (AAC for Hi-Res); no colour while unknown
    const level = qualityLevel(np, q);
    b.classList.toggle('amagent-quality-met', level === 'met');
    b.classList.toggle('amagent-quality-partial', level === 'partial');
    b.classList.toggle('amagent-quality-short', level === 'short');
    const detail = formatDetail(np);
    if (detail) b.title = detail; else b.removeAttribute('title');
    b.setAttribute('aria-label', 'Audio quality' + (row ? ': ' + row[2] : '') + (detail ? `, playing ${detail}` : ''));
  }
  if (quality.menu) for (const it of quality.menu.querySelectorAll('[data-q]')) it.setAttribute('aria-checked', String(it.dataset.q === q));
}

function qualityClose() {
  if (!quality.menu) return;
  quality.menu.remove();
  quality.menu = null;
  if (quality.btn) quality.btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', qualityOutside, true);
  document.removeEventListener('keydown', qualityKey, true);
}
function qualityOutside(e) {
  if (quality.menu && !quality.menu.contains(e.target) && e.target !== quality.btn) qualityClose();
}
function qualityKey(e) {
  if (!quality.menu) return;
  const items = [...quality.menu.querySelectorAll('[data-q]')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { qualityClose(); if (quality.btn) quality.btn.focus(); }
  else if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
  else if (e.key === 'ArrowUp') items[(i + items.length - 1) % items.length].focus();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function qualityOpen() {
  const m = document.createElement('div');
  m.className = 'amagent-quality-menu';
  m.setAttribute('role', 'menu');
  m.setAttribute('aria-label', 'Audio quality');
  for (const [id, , label] of QUALITIES) {
    const it = document.createElement('button');
    it.type = 'button';
    it.dataset.q = id;
    it.setAttribute('role', 'menuitemradio');
    it.textContent = label;
    it.addEventListener('click', () => {
      quality.want = id;
      quality.wantAt = now();
      qualityClose();
      qualityRender();
      send('quality', { q: id }).then((r) => {
        if (!r.ok) { quality.want = null; log('quality failed:', r.error || ''); }
        qualityRender();
      });
    });
    m.appendChild(it);
  }
  const hint = document.createElement('div');
  hint.className = 'amagent-quality-hint';
  hint.textContent = 'Applies from the next track';
  m.appendChild(hint);
  document.body.appendChild(m);
  quality.menu = m;
  qualityRender();

  // above the button when there is room (the bar sits at the bottom), else below
  const r = quality.btn.getBoundingClientRect();
  const mr = m.getBoundingClientRect();
  const top = r.top - mr.height - 10 >= 8 ? r.top - mr.height - 10 : r.bottom + 10;
  m.style.top = `${Math.round(top)}px`;
  m.style.left = `${Math.round(Math.min(Math.max(8, r.right - mr.width), window.innerWidth - mr.width - 8))}px`;
  quality.btn.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', qualityOutside, true);
  document.addEventListener('keydown', qualityKey, true);
  (m.querySelector('[aria-checked="true"]') || m.querySelector('[data-q]')).focus();
}

// the page rebuilds its player bar now and then: put the button back when it is gone
function qualityEnsure() {
  const host = document.querySelector('.chrome-player .action-buttons') || document.querySelector('.chrome-player__actions');
  if (!host) return;
  if (quality.btn && quality.btn.isConnected && host.contains(quality.btn)) return;
  qualityClose();
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'amagent-quality';
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (quality.menu) qualityClose(); else qualityOpen();
  });
  host.prepend(b);
  quality.btn = b;
  qualityRender();
}
window.addEventListener('resize', qualityClose);
