// Runs in the page's own world on music.apple.com (put there by injectRendererScripts() in src/main.ts, assembled by src/agent/index.ts).
//
// The web player (MusicKit JS) keeps everything it normally does: queue, shuffle/repeat, autoplay,
// now-playing metadata, lyrics, the transport bar. Only the last step is replaced. MusicKit plays
// unencrypted audio through an "HTMLAudioPlayer" that drives an <audio> element; we give it
//   1. an asset for every catalogue song that says "unencrypted, progressive" (resolveAsset), and
//   2. its own HTMLAudioPlayer whose media element is AgentMedia below: an object that looks like
//      an <audio> element but forwards play/pause/seek/volume to the wrapper service and reports
//      the service's position, so MusicKit's state machine runs unchanged.
// Anything that is not a catalogue song (music videos, live radio, uploads without a catalogue
// ID) still goes to MusicKit's own players.
//
// The code is split into parts under assets/agent/ that run inside the one closure below
// (src/agent/index.ts puts them in place of the token): link.js (commands to the service and
// its status), media.js (the <audio> stand-in), musickit.js (the MusicKit hooks), quality.js
// (the quality button), start.js (waiting for MusicKit, status updates).
(() => {
  if (window.__amAgentInit) return;
  window.__amAgentInit = (cfg) => {
    const bridge = window.amAgent;
    if (!bridge || window.__amAgentHooked) return;
    window.__amAgentHooked = true;

    __AGENT_PARTS__
  };
})();
