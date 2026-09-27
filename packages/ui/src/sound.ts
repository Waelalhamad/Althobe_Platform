// Distinct sounds for found / not found (docs/barcode.md): staff often do not look at the screen
// while scanning. Web Audio needs one user gesture first; logging in provides it.

let audio: AudioContext | undefined;

function tone(frequency: number, ms: number, delay = 0) {
  audio ??= new AudioContext();
  const start = audio.currentTime + delay / 1000;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'square';
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.08, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + ms / 1000);
  osc.connect(gain).connect(audio.destination);
  osc.start(start);
  osc.stop(start + ms / 1000);
}

export const sound = {
  /** Short high beep: scanned and counted. */
  ok: () => tone(1320, 90),
  /** Low double buzz: not found, misread, or refused. */
  bad: () => {
    tone(220, 160);
    tone(220, 160, 220);
  },
  /** Soft blip: duplicate scan ignored. */
  dup: () => tone(660, 60),
};
