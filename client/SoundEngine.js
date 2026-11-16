export class SoundEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  ensure() {
    if (this.muted) return null;
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  playTone(freqStart, freqEnd, duration, type = 'sine', gainVal = 0.14) {
    const ctx = this.ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + duration);
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration);
  }

  playNoise(duration, filterFreq = 900, gainVal = 0.16) {
    const ctx = this.ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const bufferSize = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFreq, now);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start(now);
  }

  bolt() {
    this.playTone(760, 210, 0.12, 'triangle', 0.14);
    this.playTone(1120, 420, 0.06, 'sine', 0.08);
  }

  slash() {
    this.playNoise(0.14, 1800, 0.16);
    this.playTone(320, 120, 0.14, 'sawtooth', 0.08);
  }

  rail() {
    this.playTone(980, 95, 0.28, 'sawtooth', 0.16);
    this.playNoise(0.22, 2400, 0.18);
  }

  scope(zoomIn = true) {
    if (zoomIn) {
      this.playTone(540, 1180, 0.085, 'sine', 0.09);
      this.playTone(820, 1480, 0.06, 'triangle', 0.06);
    } else {
      this.playTone(1080, 520, 0.075, 'sine', 0.08);
    }
  }

  hit(headshot = false) {
    if (headshot) {
      // Crisp CS2-style headshot dink
      this.playTone(1850, 1450, 0.09, 'sine', 0.2);
      this.playTone(2550, 2100, 0.07, 'triangle', 0.14);
    } else {
      this.playTone(620, 320, 0.055, 'triangle', 0.12);
    }
  }

  kill() {
    this.playTone(440, 880, 0.16, 'triangle', 0.15);
    setTimeout(() => this.playTone(660, 1320, 0.18, 'sine', 0.12), 70);
  }

  explosion() {
    this.playNoise(0.36, 480, 0.26);
    this.playTone(130, 38, 0.34, 'sawtooth', 0.18);
  }

  dash() {
    this.playNoise(0.15, 1400, 0.12);
    this.playTone(280, 520, 0.12, 'sine', 0.08);
  }

  blink() {
    this.playTone(520, 1240, 0.15, 'sine', 0.13);
  }

  parry() {
    this.playTone(1320, 1980, 0.2, 'triangle', 0.22);
    this.playTone(880, 1760, 0.24, 'sine', 0.16);
  }

  jumpPad() {
    this.playTone(240, 740, 0.22, 'sine', 0.14);
  }

  unlock() {
    this.playTone(523, 784, 0.18, 'triangle', 0.14);
    setTimeout(() => this.playTone(784, 1046, 0.22, 'sine', 0.14), 90);
  }

  hurt() {
    this.playTone(180, 75, 0.14, 'sawtooth', 0.14);
  }

  panSpawn() {
    const notes = [587, 784, 1175];
    notes.forEach((freq, i) => {
      setTimeout(() => this.playTone(freq, freq * 1.03, 0.16, 'triangle', 0.12), i * 75);
    });
  }

  panSwing() {
    this.playNoise(0.13, 1350, 0.14);
    this.playTone(300, 130, 0.12, 'triangle', 0.09);
  }

  panClang(hitPlayer = true, scale = 1.0) {
    const g = Math.max(0.12, Math.min(1, scale));
    if (hitPlayer) {
      this.playTone(230, 82, 0.14, 'sawtooth', 0.18 * g);
      this.playNoise(0.08, 2200, 0.18 * g);
    } else {
      this.playNoise(0.06, 1800, 0.11 * g);
    }
    // Inharmonic cast-iron pan ringing partials
    this.playTone(465, 452, 0.34, 'triangle', 0.19 * g);
    this.playTone(738, 725, 0.3, 'sine', 0.16 * g);
    this.playTone(1165, 1148, 0.24, 'triangle', 0.13 * g);
    this.playTone(1840, 1810, 0.18, 'sine', 0.09 * g);
  }

  emote(emoteId, scale = 1.0) {
    const g = 0.14 * Math.max(0.15, Math.min(1, scale));
    if (emoteId === 'wave') {
      this.playTone(523, 659, 0.12, 'triangle', g);
      setTimeout(() => this.playTone(659, 784, 0.16, 'sine', g * 0.9), 85);
    } else if (emoteId === 'dance') {
      [440, 554, 659, 554, 880].forEach((freq, i) => {
        setTimeout(() => this.playTone(freq, freq * 1.04, 0.12, 'triangle', g * 0.85), i * 110);
      });
    } else if (emoteId === 'twerk') {
      // Bouncy funky bass pop beat
      [0, 180, 360, 540, 720, 900].forEach((ms, i) => {
        setTimeout(() => {
          const base = i % 2 === 0 ? 185 : 245;
          this.playTone(base, base * 0.55, 0.13, 'sawtooth', g * 0.9);
          this.playTone(base * 2.4, base * 3.1, 0.06, 'triangle', g * 0.5);
        }, ms);
      });
    } else if (emoteId === 'cheer') {
      [523, 659, 784, 1046].forEach((freq, i) => {
        setTimeout(() => this.playTone(freq, freq, 0.14, 'triangle', g), i * 65);
      });
    } else if (emoteId === 'spin') {
      this.playNoise(0.28, 1900, g * 0.85);
      this.playTone(420, 960, 0.28, 'sine', g * 0.8);
    } else if (emoteId === 'bow') {
      this.playTone(392, 523, 0.18, 'triangle', g * 0.9);
      setTimeout(() => this.playTone(587, 587, 0.22, 'sine', g * 0.75), 110);
    }
  }
}
