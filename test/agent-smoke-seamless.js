// Runs in the page over CDP (test/agent-smoke.sh): two consecutive engine songs, the first sought
// to 23 s before its end (inside the enqueue window of seamless.js, also with 6 s crossfade), then either played to its end (__MODE__ "end") or
// skipped once the second is queued in the engine (__MODE__ "skip"). Reports when MusicKit moved
// on: "left" is how many seconds of the first song were still to go (0 to 1: the engine switches
// at the end, also with crossfade on, and shows its position in steps of about a second). __SONG1__ and __SONG2__ are replaced by agent-smoke.sh.
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const mk = MusicKit.getInstance();
  const S1 = '__SONG1__', S2 = '__SONG2__';
  const id = () => String(mk.nowPlayingItem?.id ?? '');
  await mk.setQueue({ songs: [S1, S2] });
  await mk.play().catch(e => console.log('play err ' + e));
  for (let i = 0; i < 80 && !(mk.playbackState === 2 && id() === S1 && mk.currentPlaybackDuration > 0); i++) await sleep(250);
  if (id() !== S1) return `start: FAILED item=${id()} state=${mk.playbackState}`;
  const dur = mk.currentPlaybackDuration;
  await mk.seekToTime(dur - 23);
  if ('__MODE__' === 'skip') {
    await sleep(5000);                                 // queued in the engine, still inside the window
    await mk.skipToNextItem();
  }
  let last = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    if (id() === S1) last = mk.currentPlaybackTime;
    else if (id() === S2 && mk.playbackState === 2 && mk.currentPlaybackTime > 1) break;
    await sleep(100);
  }
  return `moved on item=${id() === S2 ? 'second' : id()} state=${mk.playbackState} left=${(dur - last).toFixed(1)} t=${mk.currentPlaybackTime.toFixed(1)}`;
})()
