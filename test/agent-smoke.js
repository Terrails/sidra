// Runs in the page over CDP (test/agent-smoke.sh): MusicKit play, pause, seek + resume, next, stop,
// all against the mock service. __SONG1__ and __SONG2__ are replaced by agent-smoke.sh (SMOKE_SONGS):
// two consecutive tracks of one catalogue album.
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const mk = MusicKit.getInstance();
  const out = [];
  await mk.setQueue({ songs: ['__SONG1__', '__SONG2__'] });
  await mk.play().catch(e => out.push('play err ' + e));
  await sleep(4000);
  out.push(`state=${mk.playbackState} item=${mk.nowPlayingItem?.title} t=${mk.currentPlaybackTime.toFixed(1)}`);
  await mk.pause(); await sleep(800);
  out.push(`paused state=${mk.playbackState}`);
  await mk.seekToTime(60); await mk.play(); await sleep(1500);
  out.push(`after seek t=${mk.currentPlaybackTime.toFixed(1)}`);
  await mk.skipToNextItem(); await sleep(4000);
  out.push(`next item=${mk.nowPlayingItem?.title} state=${mk.playbackState}`);
  await mk.stop();
  return out.join('\n');
})()
