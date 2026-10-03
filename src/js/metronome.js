// 节拍器：Web Audio 预排程（lookahead）保证节拍精准，界面动画按音频时钟同步。
import { getAudioContext, load, save, $, clamp } from './util.js';

const LOOKAHEAD = 0.12;   // 预排程窗口（秒）
const TICK_MS = 25;       // 排程器唤醒间隔

// 用 Worker 计时，窗口切到后台也不会被节流。
const timerWorker = new Worker(URL.createObjectURL(new Blob([`
  let id = 0;
  onmessage = (e) => {
    clearInterval(id);
    if (e.data > 0) id = setInterval(() => postMessage(0), e.data);
  };
`], { type: 'text/javascript' })));

const TEMPO_NAMES = [
  [60, 'Largo 广板'], [66, 'Larghetto 小广板'], [76, 'Adagio 柔板'], [108, 'Andante 行板'],
  [120, 'Moderato 中板'], [156, 'Allegro 快板'], [176, 'Vivace 活泼'], [200, 'Presto 急板'],
  [Infinity, 'Prestissimo 最急板'],
];
export const tempoName = (bpm) => TEMPO_NAMES.find(([max]) => bpm < max)[1];

export class Metronome extends EventTarget {
  constructor() {
    super();
    this.state = load('metronome', {
      bpm: 120, beats: 4, note: 4, subdiv: 1, sound: 'beep', volume: 80,
      accents: null, trainer: { on: false, bars: 4, step: 5, target: 160 },
    });
    if (!Array.isArray(this.state.accents) || this.state.accents.length !== this.state.beats) {
      this.state.accents = defaultAccents(this.state.beats);
    }
    this.running = false;
    this.queue = [];
    this.out = null;
    timerWorker.onmessage = () => this.schedule();
  }

  persist() { save('metronome', this.state); }

  set(patch) {
    Object.assign(this.state, patch);
    if ('bpm' in patch) this.state.bpm = clamp(Math.round(this.state.bpm), 30, 300);
    if ('beats' in patch && this.state.accents.length !== this.state.beats) {
      this.state.accents = defaultAccents(this.state.beats);
      this.beat = Math.min(this.beat ?? 0, this.state.beats - 1);
    }
    if ('volume' in patch && this.out) this.out.gain.value = volToGain(this.state.volume);
    this.persist();
    this.dispatchEvent(new CustomEvent('change', { detail: patch }));
  }

  async start() {
    if (this.running) return;
    const ctx = getAudioContext();
    if (ctx.state !== 'running') await ctx.resume();
    if (!this.out) {
      this.out = ctx.createGain();
      this.out.connect(ctx.destination);
      this.noise = makeNoise(ctx);
    }
    this.out.gain.value = volToGain(this.state.volume);
    this.running = true;
    this.nextTime = ctx.currentTime + 0.06;
    this.beat = 0;
    this.sub = 0;
    this.bar = 0;
    this.barsAtStep = 0;
    this.startedAt = performance.now();
    this.schedule();
    timerWorker.postMessage(TICK_MS);
    this.dispatchEvent(new Event('state'));
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    timerWorker.postMessage(0);
    this.queue.length = 0;
    this.dispatchEvent(new Event('state'));
  }

  toggle() { this.running ? this.stop() : this.start(); }

  schedule() {
    if (!this.running) return;
    const ctx = getAudioContext();
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      const { accents, subdiv } = this.state;
      const level = this.sub === 0 ? accents[this.beat] : (accents[this.beat] === 0 ? 0 : 0.5);
      const gain = level > 0 ? this.click(this.nextTime, level) : null;
      this.queue.push({ time: this.nextTime, beat: this.beat, sub: this.sub, bar: this.bar, gain });
      this.nextTime += 60 / this.state.bpm / subdiv;
      if (++this.sub >= subdiv) {
        this.sub = 0;
        if (++this.beat >= this.state.beats) {
          this.beat = 0;
          this.bar++;
          this.onBarDone();
        }
      }
    }
  }

  /** 让第一拍（重拍）从此刻响起：撤掉已排好但还没响的拍子，从这里重新数小节。 */
  downbeatNow() {
    if (!this.running) { this.start(); return; }
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const keep = this.queue.filter((ev) => ev.time <= now);
    const pending = this.queue.filter((ev) => ev.time > now);
    for (const ev of pending) ev.gain?.disconnect();
    this.queue = keep;
    // 被撤掉的第一拍代表「本来接下来要响的位置」；不在小节开头就算新起一小节
    const next = pending[0] ?? { beat: this.beat, sub: this.sub, bar: this.bar };
    this.bar = next.bar + (next.beat === 0 && next.sub === 0 ? 0 : 1);
    this.beat = 0;
    this.sub = 0;
    this.nextTime = now + 0.01;
    this.schedule();
  }

  onBarDone() {
    const t = this.state.trainer;
    if (!t.on) return;
    if (this.bar - this.barsAtStep >= t.bars && this.state.bpm < t.target) {
      this.barsAtStep = this.bar;
      this.set({ bpm: Math.min(t.target, this.state.bpm + t.step) });
    }
  }

  /** 取出已经到点（音频时钟）的拍子，供界面动画使用。 */
  drainDue() {
    if (!this.running) return [];
    const ctx = getAudioContext();
    const now = ctx.currentTime - (ctx.outputLatency || 0);
    const due = [];
    while (this.queue.length && this.queue[0].time <= now) due.push(this.queue.shift());
    return due;
  }

  /** level: 2 重音 / 1 普通拍 / 0.5 细分 */
  click(t, level) {
    const ctx = getAudioContext();
    const g = ctx.createGain();
    g.connect(this.out);
    const peak = level === 2 ? 1 : level === 1 ? 0.6 : 0.32;
    const env = (dur) => {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    };
    const osc = (type, f, f2, dur) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur * 0.4);
      o.connect(g);
      o.start(t);
      o.stop(t + dur + 0.01);
    };
    const pitch = level === 2 ? 1.5 : level === 1 ? 1 : 0.8;

    switch (this.state.sound) {
      case 'wood': {
        env(0.06);
        osc('sine', 1400 * pitch, 900 * pitch, 0.06);
        this.noiseBurst(t, g, 'bandpass', 2600 * pitch, 0.02, 0.5);
        break;
      }
      case 'stick': {
        env(level === 2 ? 0.09 : 0.05);
        this.noiseBurst(t, g, 'highpass', level === 2 ? 5000 : 7000, 0.09, 1.2);
        if (level === 2) osc('triangle', 900, 500, 0.03);
        break;
      }
      case 'cow': {
        // 两个方波叠加再带通，经典 808 牛铃做法
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 900 * pitch; bp.Q.value = 2;
        g.disconnect();
        g.connect(bp).connect(this.out);
        env(0.15);
        osc('square', 560 * pitch, 0, 0.15);
        osc('square', 845 * pitch, 0, 0.15);
        break;
      }
      default: {
        env(0.05);
        osc('sine', level === 2 ? 1760 : level === 1 ? 1320 : 990, 0, 0.05);
      }
    }
    return g;
  }

  noiseBurst(t, dest, type, freq, dur, amp) {
    const ctx = getAudioContext();
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = amp;
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 0.5, dur);
  }
}

function defaultAccents(n) { return Array.from({ length: n }, (_, i) => (i === 0 ? 2 : 1)); }
function volToGain(v) { return Math.pow(v / 100, 2) * 0.9; }
function makeNoise(ctx) {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// ---------------------------------------------------------------- 界面

export function initMetronomeUI(metro) {
  const s = () => metro.state;
  const beatRow = $('beatRow');
  const bpmValue = $('bpmValue');
  const playBtn = $('metroPlay');

  const beatsSel = $('beatsSel');
  for (let i = 1; i <= 12; i++) beatsSel.add(new Option(String(i), String(i)));

  function renderBeats() {
    beatRow.innerHTML = '';
    s().accents.forEach((lvl, i) => {
      const b = document.createElement('button');
      b.className = 'beat';
      b.dataset.level = lvl;
      b.title = ['静音', '普通', '重音'][lvl];
      b.innerHTML = `<span class="num">${i + 1}</span><span class="bar"></span>`;
      b.addEventListener('click', () => {
        const accents = [...s().accents];
        accents[i] = (accents[i] + 2) % 3; // 重音 → 普通 → 静音 → 重音
        metro.set({ accents });
        renderBeats();
      });
      beatRow.appendChild(b);
    });
  }

  function renderValues() {
    const st = s();
    bpmValue.textContent = st.bpm;
    $('bpmSlider').value = st.bpm;
    $('tempoName').textContent = tempoName(st.bpm);
    $('miniBpm').textContent = st.bpm;
    beatsSel.value = st.beats;
    $('noteSel').value = st.note;
    $('soundSel').value = st.sound;
    $('metroVol').value = st.volume;
    for (const btn of $('subdivSeg').children) btn.setAttribute('aria-checked', String(+btn.dataset.v === st.subdiv));
    $('trainerOn').checked = st.trainer.on;
    $('trainerBars').value = st.trainer.bars;
    $('trainerStep').value = st.trainer.step;
    $('trainerTarget').value = st.trainer.target;
  }

  const nudge = (d) => metro.set({ bpm: s().bpm + d });
  bindRepeat($('bpmDown'), () => nudge(-1));
  bindRepeat($('bpmUp'), () => nudge(1));
  $('bpmSlider').addEventListener('input', (e) => metro.set({ bpm: +e.target.value }));
  playBtn.addEventListener('click', () => metro.toggle());
  $('miniMetro').addEventListener('click', () => metro.toggle());
  beatsSel.addEventListener('change', () => { metro.set({ beats: +beatsSel.value }); renderBeats(); });
  $('noteSel').addEventListener('change', (e) => metro.set({ note: +e.target.value }));
  $('soundSel').addEventListener('change', (e) => metro.set({ sound: e.target.value }));
  $('metroVol').addEventListener('input', (e) => metro.set({ volume: +e.target.value }));
  $('subdivSeg').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (v) metro.set({ subdiv: +v });
  });

  const trainerInputs = ['trainerOn', 'trainerBars', 'trainerStep', 'trainerTarget'];
  for (const id of trainerInputs) {
    $(id).addEventListener('change', () => {
      metro.barsAtStep = metro.bar ?? 0;
      metro.set({
        trainer: {
          on: $('trainerOn').checked,
          bars: clamp(+$('trainerBars').value || 4, 1, 64),
          step: clamp(+$('trainerStep').value || 5, 1, 40),
          target: clamp(+$('trainerTarget').value || 160, 30, 300),
        },
      });
    });
  }

  // 敲击测速
  let taps = [];
  const tap = () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 5) taps.shift();
    if (taps.length >= 2) {
      const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      metro.set({ bpm: 60000 / avg });
    }
    const btn = $('tapBtn');
    btn.classList.add('toggled');
    setTimeout(() => btn.classList.remove('toggled'), 90);
  };
  $('tapBtn').addEventListener('click', tap);
  const downbeat = () => metro.downbeatNow();
  $('downbeatBtn').addEventListener('click', downbeat);

  metro.addEventListener('change', (e) => {
    renderValues();
    if ('beats' in e.detail) renderBeats();
    updateTrainerStatus();
  });
  metro.addEventListener('state', () => {
    playBtn.textContent = metro.running ? '停止' : '开始';
    playBtn.classList.toggle('active', metro.running);
    if (!metro.running) {
      for (const el of beatRow.children) el.classList.remove('hit');
      $('miniDot').classList.remove('on');
    }
    updateTrainerStatus();
  });

  function updateTrainerStatus() {
    const t = s().trainer;
    const el = $('trainerStatus');
    if (!t.on) el.textContent = '开启后，每练够设定的小节数就自动加速。';
    else if (s().bpm >= t.target) el.textContent = `已到目标速度 ${t.target} BPM，保持住！`;
    else if (metro.running) el.textContent = `还差 ${Math.max(0, t.bars - (metro.bar - metro.barsAtStep))} 小节加速到 ${Math.min(t.target, s().bpm + t.step)} BPM`;
    else el.textContent = `从 ${s().bpm} 开始，每 ${t.bars} 小节 +${t.step}，直到 ${t.target} BPM`;
  }

  // 动画循环：按音频时钟点亮拍点
  let litTimer = 0;
  function frame() {
    for (const ev of metro.drainDue()) {
      if (ev.sub !== 0) continue;
      const cells = beatRow.children;
      for (const el of cells) el.classList.remove('hit');
      cells[ev.beat]?.classList.add('hit');
      const dot = $('miniDot');
      dot.classList.add('on');
      if (ev.beat === 0) bpmValue.classList.add('flash');
      clearTimeout(litTimer);
      litTimer = setTimeout(() => {
        dot.classList.remove('on');
        bpmValue.classList.remove('flash');
        cells[ev.beat]?.classList.remove('hit');
      }, Math.min(120, 30000 / s().bpm));
      $('statBars').textContent = ev.bar;
      if (ev.beat === 0) updateTrainerStatus();
    }
    if (metro.running) {
      const sec = Math.floor((performance.now() - metro.startedAt) / 1000);
      $('statTime').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  renderBeats();
  renderValues();
  updateTrainerStatus();
  return { tap, nudge, downbeat };
}

/** 按住按钮连续调整。 */
function bindRepeat(btn, fn) {
  let t1 = 0, t2 = 0;
  const stop = () => { clearTimeout(t1); clearInterval(t2); };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    fn();
    t1 = setTimeout(() => { t2 = setInterval(fn, 60); }, 400);
  });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter') fn(); });
}
