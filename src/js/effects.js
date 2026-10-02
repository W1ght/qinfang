// 效果器：吉他实时输入 → 噪声门 → 压缩 → 过载 → 均衡 → 箱体 → 合唱 → 延迟 → 混响 → 限幅 → 输出。
import { getAudioContext, $, load, save, loadRaw, toast, dbToGain, promptText, clamp } from './util.js';

const SMOOTH = 0.015;

// ---------------------------------------------------------------- 效果模块定义
// kind: 'insert' 开启时完全替换干声；'mix' 干声保留，湿声按 mix 叠加。
const MODULES = [
  {
    id: 'gate', name: '噪声门', en: 'GATE', color: '#7fb8ff', kind: 'insert',
    params: [
      { id: 'threshold', label: '阈值', min: -90, max: -20, step: 1, def: -62, unit: 'dB' },
      { id: 'release', label: '释放', min: 10, max: 600, step: 5, def: 120, unit: 'ms' },
    ],
    build(ctx) {
      const node = new AudioWorkletNode(ctx, 'noise-gate');
      return {
        input: node, output: node,
        apply(p) {
          node.parameters.get('threshold').setValueAtTime(p.threshold, ctx.currentTime);
          node.parameters.get('release').setValueAtTime(p.release, ctx.currentTime);
        },
      };
    },
  },
  {
    id: 'comp', name: '压缩', en: 'COMP', color: '#62d0c5', kind: 'insert',
    params: [
      { id: 'threshold', label: '阈值', min: -60, max: 0, step: 1, def: -24, unit: 'dB' },
      { id: 'ratio', label: '压缩比', min: 1, max: 20, step: 0.5, def: 4, unit: ':1' },
      { id: 'attack', label: '启动', min: 1, max: 100, step: 1, def: 8, unit: 'ms' },
      { id: 'release', label: '释放', min: 20, max: 1000, step: 10, def: 200, unit: 'ms' },
      { id: 'makeup', label: '补偿', min: 0, max: 24, step: 0.5, def: 6, unit: 'dB' },
    ],
    build(ctx) {
      const comp = ctx.createDynamicsCompressor();
      comp.knee.value = 6;
      const makeup = ctx.createGain();
      comp.connect(makeup);
      return {
        input: comp, output: makeup,
        apply(p) {
          const t = ctx.currentTime;
          comp.threshold.setTargetAtTime(p.threshold, t, SMOOTH);
          comp.ratio.setTargetAtTime(p.ratio, t, SMOOTH);
          comp.attack.setTargetAtTime(p.attack / 1000, t, SMOOTH);
          comp.release.setTargetAtTime(p.release / 1000, t, SMOOTH);
          makeup.gain.setTargetAtTime(dbToGain(p.makeup), t, SMOOTH);
        },
      };
    },
  },
  {
    id: 'drive', name: '箱头 / 失真', en: 'AMP', color: '#ff8a3d', kind: 'insert',
    params: [
      {
        id: 'type', label: '类型', type: 'select', def: 'od', options: [
          ['clean', '清音箱头'], ['od', '过载 Overdrive'], ['crunch', '英式 Crunch'],
          ['dist', '高增益失真'], ['metal', '金属 Metal'], ['fuzz', '法兹 Fuzz'],
        ],
      },
      { id: 'gain', label: '增益', min: 0, max: 100, step: 1, def: 50, unit: '' },
      { id: 'tone', label: '音色', min: 0, max: 100, step: 1, def: 55, unit: '' },
      { id: 'level', label: '音量', min: -24, max: 12, step: 0.5, def: 0, unit: 'dB' },
    ],
    build(ctx) {
      const tight = biquad(ctx, 'highpass', 90, 0.7);
      const mid = biquad(ctx, 'peaking', 720, 0.8);
      const shaper = ctx.createWaveShaper();
      shaper.oversample = '4x';
      const tone = biquad(ctx, 'lowpass', 4000, 0.7);
      const level = ctx.createGain();
      chain(tight, mid, shaper, tone, level);
      let curveKey = '';
      return {
        input: tight, output: level,
        apply(p) {
          const t = ctx.currentTime;
          const key = `${p.type}:${p.gain}`;
          if (key !== curveKey) { shaper.curve = driveCurve(p.type, p.gain); curveKey = key; }
          mid.gain.setTargetAtTime({ clean: 0, od: 6, crunch: 3, dist: 2, metal: 5, fuzz: 0 }[p.type] ?? 0, t, SMOOTH);
          tone.frequency.setTargetAtTime(800 * Math.pow(2, (p.tone / 100) * 4), t, SMOOTH);
          level.gain.setTargetAtTime(dbToGain(p.level - 14), t, SMOOTH); // 网页版削波后电平接近满幅，统一压低
        },
      };
    },
  },
  {
    id: 'eq', name: '均衡', en: 'EQ', color: '#c6e35a', kind: 'insert',
    params: [
      { id: 'low', label: '低音', min: -15, max: 15, step: 0.5, def: 0, unit: 'dB' },
      { id: 'mid', label: '中音', min: -15, max: 15, step: 0.5, def: 0, unit: 'dB' },
      { id: 'midFreq', label: '中频点', min: 250, max: 3000, step: 10, def: 800, unit: 'Hz' },
      { id: 'high', label: '高音', min: -15, max: 15, step: 0.5, def: 0, unit: 'dB' },
    ],
    build(ctx) {
      const low = biquad(ctx, 'lowshelf', 120);
      const mid = biquad(ctx, 'peaking', 800, 0.9);
      const high = biquad(ctx, 'highshelf', 3200);
      chain(low, mid, high);
      return {
        input: low, output: high,
        apply(p) {
          const t = ctx.currentTime;
          low.gain.setTargetAtTime(p.low, t, SMOOTH);
          mid.gain.setTargetAtTime(p.mid, t, SMOOTH);
          mid.frequency.setTargetAtTime(p.midFreq, t, SMOOTH);
          high.gain.setTargetAtTime(p.high, t, SMOOTH);
        },
      };
    },
  },
  {
    id: 'cab', name: '箱体模拟', en: 'CAB', color: '#d9a066', kind: 'insert',
    params: [
      { id: 'type', label: '箱体', type: 'select', def: 'combo', options: [['combo', '1×12 音箱'], ['open', '2×12 开背'], ['stack', '4×12 闭箱']] },
      { id: 'cut', label: '高切', min: 2500, max: 10000, step: 100, def: 5500, unit: 'Hz' },
    ],
    build(ctx) {
      const hp = biquad(ctx, 'highpass', 75, 0.7);
      const res = biquad(ctx, 'peaking', 110, 1.2);
      const box = biquad(ctx, 'peaking', 500, 1);
      const pres = biquad(ctx, 'peaking', 2500, 1.2);
      const lp1 = biquad(ctx, 'lowpass', 5500, 0.7);
      const lp2 = biquad(ctx, 'lowpass', 5500, 0.6);
      chain(hp, res, box, pres, lp1, lp2);
      const TYPES = {
        combo: { res: [120, 3], box: -1, pres: [2200, 4] },
        open: { res: [100, 2], box: 0, pres: [3000, 3] },
        stack: { res: [95, 5], box: -4, pres: [2700, 4] },
      };
      return {
        input: hp, output: lp2,
        apply(p) {
          const t = ctx.currentTime;
          const c = TYPES[p.type];
          res.frequency.setTargetAtTime(c.res[0], t, SMOOTH);
          res.gain.setTargetAtTime(c.res[1], t, SMOOTH);
          box.gain.setTargetAtTime(c.box, t, SMOOTH);
          pres.frequency.setTargetAtTime(c.pres[0], t, SMOOTH);
          pres.gain.setTargetAtTime(c.pres[1], t, SMOOTH);
          lp1.frequency.setTargetAtTime(p.cut, t, SMOOTH);
          lp2.frequency.setTargetAtTime(p.cut * 1.15, t, SMOOTH);
        },
      };
    },
  },
  {
    id: 'chorus', name: '合唱', en: 'CHORUS', color: '#b28dff', kind: 'mix',
    params: [
      { id: 'rate', label: '速度', min: 0.1, max: 5, step: 0.05, def: 0.8, unit: 'Hz' },
      { id: 'depth', label: '深度', min: 0, max: 100, step: 1, def: 50, unit: '%' },
      { id: 'mix', label: '混合', min: 0, max: 100, step: 1, def: 50, unit: '%' },
    ],
    build(ctx) {
      const input = ctx.createGain();
      const dl = ctx.createDelay(0.1), dr = ctx.createDelay(0.1);
      dl.delayTime.value = dr.delayTime.value = 0.012;
      const lfo = ctx.createOscillator();
      const depthL = ctx.createGain(), depthR = ctx.createGain();
      lfo.connect(depthL).connect(dl.delayTime);
      lfo.connect(depthR).connect(dr.delayTime);
      lfo.start();
      const merger = ctx.createChannelMerger(2);
      input.connect(dl).connect(merger, 0, 0);
      input.connect(dr).connect(merger, 0, 1);
      return {
        input, output: merger,
        apply(p) {
          const t = ctx.currentTime;
          const d = (p.depth / 100) * 0.004;
          lfo.frequency.setTargetAtTime(p.rate, t, SMOOTH);
          depthL.gain.setTargetAtTime(d, t, SMOOTH);
          depthR.gain.setTargetAtTime(-d, t, SMOOTH); // 左右反相，展开立体声
        },
      };
    },
  },
  {
    id: 'delay', name: '延迟', en: 'DELAY', color: '#4fc3f7', kind: 'mix',
    params: [
      { id: 'sync', label: '同步', type: 'select', def: 'off', options: [['off', '手动'], ['1/4', '跟节拍器 ♩'], ['1/8.', '跟节拍器 附点♪'], ['1/8', '跟节拍器 ♪'], ['1/16', '跟节拍器 16分']] },
      { id: 'time', label: '时间', min: 30, max: 1500, step: 5, def: 380, unit: 'ms' },
      { id: 'feedback', label: '反馈', min: 0, max: 90, step: 1, def: 35, unit: '%' },
      { id: 'tone', label: '音色', min: 1000, max: 12000, step: 100, def: 4500, unit: 'Hz' },
      { id: 'mix', label: '混合', min: 0, max: 100, step: 1, def: 30, unit: '%' },
    ],
    build(ctx, env) {
      const input = ctx.createGain();
      const dly = ctx.createDelay(3);
      const tone = biquad(ctx, 'lowpass', 4500, 0.5);
      const fb = ctx.createGain();
      input.connect(dly).connect(tone);
      tone.connect(fb).connect(dly);
      return {
        input, output: tone,
        apply(p) {
          const t = ctx.currentTime;
          dly.delayTime.setTargetAtTime(delaySeconds(p, env.bpm()), t, 0.05);
          fb.gain.setTargetAtTime(p.feedback / 100, t, SMOOTH);
          tone.frequency.setTargetAtTime(p.tone, t, SMOOTH);
        },
      };
    },
  },
  {
    id: 'reverb', name: '混响', en: 'REVERB', color: '#ff7eb6', kind: 'mix',
    params: [
      { id: 'decay', label: '时长', min: 0.3, max: 8, step: 0.1, def: 2.2, unit: 's' },
      { id: 'predelay', label: '预延迟', min: 0, max: 100, step: 1, def: 15, unit: 'ms' },
      { id: 'tone', label: '音色', min: 1000, max: 12000, step: 100, def: 6000, unit: 'Hz' },
      { id: 'mix', label: '混合', min: 0, max: 100, step: 1, def: 25, unit: '%' },
    ],
    build(ctx) {
      const pre = ctx.createDelay(0.2);
      const conv = ctx.createConvolver();
      const tone = biquad(ctx, 'lowpass', 6000, 0.6);
      chain(pre, conv, tone);
      let decay = 0, timer = 0;
      return {
        input: pre, output: tone,
        apply(p) {
          const t = ctx.currentTime;
          pre.delayTime.setTargetAtTime(p.predelay / 1000, t, SMOOTH);
          tone.frequency.setTargetAtTime(p.tone, t, SMOOTH);
          if (p.decay !== decay) {
            decay = p.decay;
            clearTimeout(timer);
            // 拖动滑杆时不必每次都重算脉冲响应
            timer = setTimeout(() => { conv.buffer = impulse(ctx, decay); }, conv.buffer ? 150 : 0);
          }
        },
      };
    },
  },
];

const MOD_BY_ID = Object.fromEntries(MODULES.map((m) => [m.id, m]));

function defaultModuleState() {
  const s = {};
  for (const m of MODULES) {
    s[m.id] = { on: false };
    for (const p of m.params) s[m.id][p.id] = p.def;
  }
  return s;
}

/** 预设只写与默认值不同的部分。 */
function preset(over) {
  const s = defaultModuleState();
  for (const [id, v] of Object.entries(over)) Object.assign(s[id], { on: true }, v);
  return s;
}

const BUILTIN_PRESETS = {
  // ---- 清音
  '晶莹清音': preset({ comp: { threshold: -26, ratio: 3, makeup: 4 }, drive: { type: 'clean', gain: 25, tone: 70, level: 6 }, eq: { low: 1, high: 3 }, cab: { type: 'open', cut: 7500 }, reverb: { decay: 2.2, mix: 20 } }),
  '温暖爵士': preset({ drive: { type: 'clean', gain: 35, tone: 30, level: 4 }, eq: { low: 3, mid: 1, midFreq: 500, high: -4 }, cab: { type: 'combo', cut: 4500 }, reverb: { decay: 1.6, tone: 4000, mix: 16 } }),
  '放克切音': preset({ comp: { threshold: -34, ratio: 8, attack: 2, release: 120, makeup: 8 }, drive: { type: 'clean', gain: 15, tone: 80, level: 4 }, eq: { low: -2, mid: -2, midFreq: 600, high: 5 }, cab: { type: 'open', cut: 8000 }, reverb: { decay: 0.8, mix: 10 } }),
  '80 年代合唱': preset({ comp: { threshold: -26, ratio: 4 }, drive: { type: 'clean', gain: 30, tone: 65, level: 5 }, eq: { high: 3 }, cab: { type: 'open', cut: 7000 }, chorus: { rate: 0.6, depth: 70, mix: 55 }, delay: { time: 420, feedback: 25, mix: 18 }, reverb: { decay: 2.8, mix: 25 } }),
  // ---- 轻度过载
  '布鲁斯过载': preset({ gate: { threshold: -68 }, drive: { type: 'od', gain: 40, tone: 50, level: 0 }, eq: { mid: 2, midFreq: 900 }, cab: { type: 'combo', cut: 5500 }, reverb: { decay: 1.8, mix: 18 } }),
  '英式 Crunch': preset({ gate: { threshold: -64 }, drive: { type: 'crunch', gain: 55, tone: 60, level: 0 }, eq: { low: 1, mid: 2, midFreq: 800, high: 1 }, cab: { type: 'stack', cut: 5500 }, reverb: { decay: 1.4, mix: 14 } }),
  '经典摇滚': preset({ gate: { threshold: -62 }, drive: { type: 'crunch', gain: 75, tone: 55, level: 0 }, eq: { mid: 3, midFreq: 750 }, cab: { type: 'stack', cut: 5200 }, delay: { time: 300, feedback: 18, mix: 12 }, reverb: { decay: 1.5, mix: 14 } }),
  // ---- 失真
  '硬摇滚失真': preset({ gate: { threshold: -60 }, drive: { type: 'dist', gain: 55, tone: 50, level: 0 }, eq: { low: 2, mid: 1, high: 1 }, cab: { type: 'stack', cut: 5000 }, reverb: { decay: 1.3, mix: 12 } }),
  '独奏 Lead': preset({ gate: { threshold: -62 }, comp: { threshold: -28, ratio: 3, makeup: 2 }, drive: { type: 'dist', gain: 75, tone: 55, level: 1 }, eq: { mid: 4, midFreq: 800, high: 1 }, cab: { type: 'stack', cut: 5200 }, delay: { sync: '1/8.', feedback: 32, tone: 3800, mix: 24 }, reverb: { decay: 2.4, predelay: 30, mix: 20 } }),
  '金属节奏': preset({ gate: { threshold: -52, release: 50 }, drive: { type: 'metal', gain: 65, tone: 48, level: 0 }, eq: { low: 2, mid: -3, midFreq: 650, high: 2 }, cab: { type: 'stack', cut: 4800 } }),
  '现代金属 Djent': preset({ gate: { threshold: -48, release: 35 }, comp: { threshold: -20, ratio: 4, attack: 1, makeup: 2 }, drive: { type: 'metal', gain: 85, tone: 52, level: -1 }, eq: { low: 1, mid: -4, midFreq: 700, high: 3 }, cab: { type: 'stack', cut: 4600 } }),
  // ---- 特色
  '法兹': preset({ gate: { threshold: -66 }, drive: { type: 'fuzz', gain: 75, tone: 50, level: 0 }, eq: { mid: 3, midFreq: 900 }, cab: { type: 'combo', cut: 5000 }, reverb: { decay: 1.5, mix: 12 } }),
  '氛围空间': preset({ comp: { threshold: -26, ratio: 4 }, drive: { type: 'clean', gain: 30, tone: 60, level: 5 }, eq: { low: -2, high: 2 }, cab: { type: 'open', cut: 7500 }, chorus: { rate: 0.35, depth: 60, mix: 35 }, delay: { sync: '1/8.', feedback: 50, tone: 3500, mix: 35 }, reverb: { decay: 5.5, predelay: 40, mix: 40 } }),
  '梦幻噪音': preset({ drive: { type: 'fuzz', gain: 60, tone: 40, level: -2 }, cab: { type: 'open', cut: 6000 }, chorus: { rate: 0.25, depth: 85, mix: 45 }, delay: { time: 520, feedback: 45, tone: 3000, mix: 30 }, reverb: { decay: 7.5, predelay: 20, tone: 5000, mix: 55 } }),
};

// ---------------------------------------------------------------- DSP 工具

function biquad(ctx, type, freq, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  if (q != null) f.Q.value = q;
  return f;
}

function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
}

function driveCurve(type, gain) {
  const n = 4096;
  const curve = new Float32Array(n);
  const g = gain / 100;
  const k = 1 + g * g * ({ clean: 8, od: 60, crunch: 120, dist: 300, metal: 500, fuzz: 500 }[type] ?? 60);
  if (type === 'metal') type = 'dist';
  if (type === 'clean' || type === 'crunch') type = 'od';
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y;
    if (type === 'od') {
      // 软削波，轻微不对称带出偶次谐波（管味）
      y = Math.tanh(k * (x + 0.1 * x * x)) / Math.tanh(k * 1.1);
    } else if (type === 'dist') {
      y = (Math.atan(k * x) / Math.atan(k)) * 1.25;
      y = Math.max(-0.95, Math.min(0.95, y));
    } else {
      // 法兹：正负半周削得不一样，偏硬
      y = x >= 0 ? Math.tanh(k * x) : Math.tanh(k * x * 0.6) * 0.75;
      y = Math.max(-0.7, Math.min(0.85, y));
    }
    curve[i] = y;
  }
  return curve;
}

function impulse(ctx, seconds) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // 指数衰减噪声；开头几毫秒稀疏一些，模拟早期反射
      const early = i < rate * 0.02 ? (Math.random() < 0.05 ? 1 : 0.15) : 1;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2) * Math.exp(-4 * t) * early;
    }
  }
  return buf;
}

const SYNC_BEATS = { '1/4': 1, '1/8.': 0.75, '1/8': 0.5, '1/16': 0.25 };
function delaySeconds(p, bpm) {
  return p.sync === 'off' ? p.time / 1000 : Math.min(3, (60 / bpm) * SYNC_BEATS[p.sync]);
}

// ---------------------------------------------------------------- 引擎

class FxEngine {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.nodes = null;
    this.stream = null;
    this.running = false;
  }

  async init() {
    if (this.nodes) return;
    const ctx = getAudioContext();
    await ctx.audioWorklet.addModule(new URL('./worklets/gate-processor.js', import.meta.url));

    const inGain = ctx.createGain();
    const inMeter = ctx.createAnalyser();
    inMeter.fftSize = 1024;
    inGain.connect(inMeter);

    let prev = inGain;
    const mods = {};
    for (const spec of MODULES) {
      const core = spec.build(ctx, this.env);
      const input = ctx.createGain(), output = ctx.createGain();
      const dry = ctx.createGain(), wet = ctx.createGain();
      input.connect(dry).connect(output);
      input.connect(core.input);
      core.output.connect(wet).connect(output);
      prev.connect(input);
      prev = output;
      mods[spec.id] = { spec, core, dry, wet };
    }

    const master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    const outMeter = ctx.createAnalyser();
    outMeter.fftSize = 1024;
    // 关掉效果器时把整条链静音（主要是让混响/延迟尾巴停下来）
    const gate = ctx.createGain();
    gate.gain.value = 0;
    prev.connect(master).connect(limiter).connect(outMeter).connect(gate).connect(ctx.destination);

    this.nodes = { ctx, inGain, inMeter, mods, master, outMeter, gate, source: null, picker: null };
    this.applyAll();
  }

  applyAll() {
    if (!this.nodes) return;
    for (const id of Object.keys(this.nodes.mods)) this.applyModule(id);
    this.applyIO();
  }

  applyIO() {
    if (!this.nodes) return;
    const t = this.nodes.ctx.currentTime;
    this.nodes.inGain.gain.setTargetAtTime(dbToGain(this.state.inputGain), t, SMOOTH);
    this.nodes.master.gain.setTargetAtTime(dbToGain(this.state.master), t, SMOOTH);
  }

  applyModule(id) {
    if (!this.nodes) return;
    const { spec, core, dry, wet } = this.nodes.mods[id];
    const p = this.state.modules[id];
    core.apply(p);
    const t = this.nodes.ctx.currentTime;
    const [d, w] = spec.kind === 'insert' ? (p.on ? [0, 1] : [1, 0]) : [1, p.on ? p.mix / 100 : 0];
    dry.gain.setTargetAtTime(d, t, SMOOTH);
    wet.gain.setTargetAtTime(w, t, SMOOTH);
  }

  async start() {
    await this.init();
    const { ctx } = this.nodes;
    if (ctx.state !== 'running') await ctx.resume();
    const audio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      latency: { ideal: 0 },
    };
    if (this.state.device) audio.deviceId = { exact: this.state.device };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      if (this.state.device && err.name === 'OverconstrainedError') {
        this.state.device = '';
        delete audio.deviceId;
        this.stream = await navigator.mediaDevices.getUserMedia({ audio });
      } else {
        throw err;
      }
    }
    this.connectSource();
    this.nodes.gate.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
    this.running = true;
  }

  connectSource() {
    const n = this.nodes;
    n.source?.disconnect();
    n.picker?.disconnect();
    n.source = n.ctx.createMediaStreamSource(this.stream);
    // 吉他是单声道信号：从声卡的某个输入通道取出来再进效果链
    const split = n.ctx.createChannelSplitter(2);
    const picker = n.ctx.createGain();
    picker.channelCount = 1;
    picker.channelCountMode = 'explicit';
    n.source.connect(split);
    const chan = this.state.chan;
    if (chan === 'mix') {
      split.connect(picker, 0);
      split.connect(picker, 1);
      picker.gain.value = 0.5;
    } else {
      split.connect(picker, +chan);
    }
    picker.connect(n.inGain);
    n.picker = picker;
  }

  async stop() {
    if (!this.running) return;
    const n = this.nodes;
    n.gate.gain.setTargetAtTime(0, n.ctx.currentTime, 0.05);
    n.source?.disconnect();
    n.picker?.disconnect();
    n.source = n.picker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.running = false;
  }

  trackInfo() {
    const s = this.stream?.getAudioTracks()[0]?.getSettings() ?? {};
    return { channels: s.channelCount, inLatency: s.latency, label: this.stream?.getAudioTracks()[0]?.label };
  }

  async setChannel() {
    if (!this.running) return;
    if (this.trackInfo().channels === 1 && this.state.chan === '1') {
      this.state.chan = '0';
      toast('当前设备只有 1 个输入通道，已切回「输入 1」');
    }
    this.connectSource();
  }

  async restart() {
    if (!this.running) return;
    this.stop();
    await this.start();
  }

  /** 自上次调用以来的峰值电平（线性） */
  levels() {
    if (!this.running) return null;
    const peak = (an) => {
      an.getFloatTimeDomainData(meterBuf);
      let pk = 0;
      for (let i = 0; i < meterBuf.length; i++) pk = Math.max(pk, Math.abs(meterBuf[i]));
      return pk;
    };
    return { in: peak(this.nodes.inMeter), out: peak(this.nodes.outMeter) };
  }

  describe() {
    const ctx = this.nodes.ctx;
    const { inLatency } = this.trackInfo();
    const ms = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0) + (inLatency || 0)) * 1000;
    return `网页音频 · ${ctx.sampleRate / 1000} kHz · 估计延迟约 ${ms.toFixed(0)} ms`;
  }
}
const meterBuf = new Float32Array(1024);

/**
 * 原生引擎：效果链在 Rust 里跑，直接走声卡 ASIO 驱动，往返延迟只有几毫秒。
 * 只在桌面版（Tauri）里可用；接口与网页版 FxEngine 保持一致。
 */
class NativeFxEngine {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.running = false;
    this.native = true;
    this.invoke = window.__TAURI__.core.invoke;
    this.lv = { in: 0, out: 0 };
    this.frames = 0;
    this.info = null;
    this.timer = 0;
    this.queued = false;
    this.onError = null;
  }

  devices() { return this.invoke('audio_devices'); }

  payload() {
    const s = this.state;
    return { inputGain: s.inputGain, master: s.master, bpm: this.env.bpm(), modules: s.modules };
  }

  // 拖滑杆时每帧最多发一次
  push() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.invoke('fx_params', { params: this.payload() }).catch(console.error);
    });
  }
  applyModule() { this.push(); }
  applyIO() { this.push(); }
  applyAll() { this.push(); }

  async start() {
    const s = this.state;
    await this.invoke('fx_params', { params: this.payload() });
    this.info = await this.invoke('fx_start', {
      cfg: {
        host: s.host,
        input: s.nativeIn,
        output: s.host === 'ASIO' ? s.nativeIn : s.nativeOut,
        buffer: +s.buffer,
        channel: s.chan === 'mix' ? -1 : +s.chan,
      },
    });
    this.running = true;
    this.frames = 0;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), 50);
  }

  async poll() {
    const p = await this.invoke('fx_poll');
    this.last = p;
    this.lv.in = Math.max(this.lv.in, p.inPeak);
    this.lv.out = Math.max(this.lv.out, p.outPeak);
    if (p.frames && p.frames !== this.frames) {
      this.frames = p.frames;
      this.onInfo?.();
    }
    if (p.error) this.onError?.(p.error);
  }

  async stop() {
    clearInterval(this.timer);
    await this.invoke('fx_stop');
    this.running = false;
  }

  // 声道和设备都是开流时定的，改了就重开
  async setChannel() { await this.restart(); }
  async restart() { if (this.running) await this.start(); }

  levels() {
    if (!this.running) return null;
    const v = this.lv;
    this.lv = { in: 0, out: 0 };
    return v;
  }

  describe() {
    const sr = this.info?.sampleRate || 0;
    const f = this.frames;
    const lat = f && sr ? ` · 缓冲 ${f} 帧 · 往返约 ${((2 * f) / sr * 1000 + 1.5).toFixed(1)} ms` : '';
    return `${this.state.host} · ${sr / 1000} kHz${lat}`;
  }
}

// ---------------------------------------------------------------- 界面

export function initEffects({ getBpm, onBpmChange }) {
  const state = load('fx', {
    inputGain: 0, master: -6, device: '', chan: '0', preset: '晶莹清音', modules: null,
    host: '', nativeIn: '', nativeOut: '', buffer: '64',
  });
  state.modules = mergeModules(state.modules ?? BUILTIN_PRESETS['晶莹清音']);
  let userPresets = loadRaw('fxPresets', {});

  const native = !!window.__TAURI__?.core;
  const engine = native ? new NativeFxEngine(state, { bpm: getBpm }) : new FxEngine(state, { bpm: getBpm });
  const persist = debounce(() => save('fx', state), 300);

  // ---- 踏板
  const board = $('pedalboard');
  const pedalEls = {};
  MODULES.forEach((spec, idx) => {
    const el = document.createElement('div');
    el.className = 'pedal';
    el.style.setProperty('--pc', spec.color);
    el.innerHTML = `
      <div class="pedal-head">
        <span class="pedal-idx">${String(idx + 1).padStart(2, '0')}</span>
        <span class="pedal-name">${spec.name}<small>${spec.en}</small></span>
        <button class="footswitch" aria-pressed="false" aria-label="开关${spec.name}" title="开关${spec.name}"></button>
      </div>`;
    for (const p of spec.params) {
      const row = document.createElement('div');
      row.className = 'param';
      const inputId = `fx-${spec.id}-${p.id}`;
      if (p.type === 'select') {
        row.innerHTML = `<label for="${inputId}">${p.label}</label><select id="${inputId}">${
          p.options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`;
      } else {
        row.innerHTML = `<label for="${inputId}">${p.label}</label>
          <input type="range" id="${inputId}" min="${p.min}" max="${p.max}" step="${p.step}">
          <output for="${inputId}"></output>`;
      }
      const input = row.querySelector('select, input');
      input.addEventListener('input', () => {
        state.modules[spec.id][p.id] = p.type === 'select' ? input.value : +input.value;
        syncPedal(spec.id);
        engine.applyModule(spec.id);
        persist();
      });
      input.addEventListener('dblclick', () => {
        if (p.type === 'select') return;
        state.modules[spec.id][p.id] = p.def;
        syncPedal(spec.id);
        engine.applyModule(spec.id);
        persist();
      });
      input.title = '双击恢复默认值';
      el.appendChild(row);
    }
    el.querySelector('.footswitch').addEventListener('click', () => {
      state.modules[spec.id].on = !state.modules[spec.id].on;
      syncPedal(spec.id);
      engine.applyModule(spec.id);
      persist();
    });
    board.appendChild(el);
    pedalEls[spec.id] = el;
  });

  function syncPedal(id) {
    const spec = MOD_BY_ID[id];
    const st = state.modules[id];
    const el = pedalEls[id];
    el.classList.toggle('off', !st.on);
    el.querySelector('.footswitch').setAttribute('aria-pressed', String(st.on));
    for (const p of spec.params) {
      const input = el.querySelector(`#fx-${id}-${p.id}`);
      input.value = st[p.id];
      const out = input.parentElement.querySelector('output');
      if (out) out.textContent = fmt(st[p.id], p.unit);
    }
    if (id === 'delay') {
      const synced = st.sync !== 'off';
      const timeInput = el.querySelector('#fx-delay-time');
      timeInput.disabled = synced;
      if (synced) timeInput.parentElement.querySelector('output').textContent = `${Math.round(delaySeconds(st, getBpm()) * 1000)} ms`;
    }
  }
  const syncAll = () => MODULES.forEach((m) => syncPedal(m.id));

  onBpmChange(() => {
    if (state.modules.delay.sync === 'off') return;
    syncPedal('delay');
    engine.applyModule('delay');
  });

  // ---- 输入输出
  const bindDb = (inputId, valId, key) => {
    const input = $(inputId);
    input.value = state[key];
    $(valId).textContent = `${state[key]} dB`;
    input.addEventListener('input', () => {
      state[key] = +input.value;
      $(valId).textContent = `${state[key]} dB`;
      engine.applyIO();
      persist();
    });
    input.addEventListener('dblclick', () => { input.value = 0; input.dispatchEvent(new Event('input')); });
  };
  bindDb('inGain', 'inGainVal', 'inputGain');
  bindDb('masterVol', 'masterVal', 'master');

  const chanSel = $('chanSel');
  chanSel.value = state.chan;
  chanSel.addEventListener('change', async () => {
    state.chan = chanSel.value;
    persist();
    await guard(() => engine.setChannel());
    chanSel.value = state.chan;
  });

  const inputSel = $('inputSel');
  const outputSel = $('outputSel');
  const hostSel = $('hostSel');
  const bufSel = $('bufSel');

  // 把虚拟声卡、直播软件之类的设备排在后面
  const JUNK = /FL Studio|ASIO4ALL|DSD|Generic|虚拟|Virtual|Steam|ToDesk|WeCam|NVIDIA|Realtek Digital/i;
  const pick = (list, saved, preferred) =>
    list.includes(saved) ? saved
      : list.includes(preferred) && !JUNK.test(preferred) ? preferred
        : list.find((n) => !JUNK.test(n)) ?? preferred ?? list[0] ?? '';
  const fillSelect = (sel, list, value) => {
    sel.innerHTML = '';
    for (const n of list) sel.add(new Option(n, n));
    if (!list.length) sel.add(new Option('（没有可用设备）', ''));
    sel.value = value;
  };

  let hosts = [];
  function renderNativeDevices() {
    const host = hosts.find((h) => h.id === state.host) ?? hosts[0];
    if (!host) return;
    state.host = host.id;
    hostSel.value = host.id;
    const asio = host.id === 'ASIO';
    state.nativeIn = pick(host.inputs, state.nativeIn, host.default_input);
    fillSelect(inputSel, host.inputs, state.nativeIn);
    $('inputLabel').textContent = asio ? '声卡' : '输入设备';
    $('outputRow').hidden = asio;
    if (!asio) {
      state.nativeOut = pick(host.outputs, state.nativeOut, host.default_output);
      fillSelect(outputSel, host.outputs, state.nativeOut);
    }
    bufSel.value = state.buffer;
    persist();
  }

  if (native) {
    $('hostRow').hidden = false;
    inputSel.innerHTML = '<option>正在扫描声卡…</option>';
    engine.devices().then((list) => {
      hosts = list.filter((h) => h.inputs.length);
      hosts.sort((a, b) => (b.id === 'ASIO') - (a.id === 'ASIO'));
      hostSel.innerHTML = '';
      for (const h of hosts) hostSel.add(new Option(h.id === 'ASIO' ? 'ASIO（推荐，低延迟）' : h.id, h.id));
      if (!state.host && hosts.some((h) => h.id === 'ASIO')) state.host = 'ASIO';
      renderNativeDevices();
    }).catch((e) => toast(`扫描声卡失败：${e}`, true));

    hostSel.addEventListener('change', async () => { state.host = hostSel.value; renderNativeDevices(); await guard(() => engine.restart()); });
    inputSel.addEventListener('change', async () => { state.nativeIn = inputSel.value; persist(); await guard(() => engine.restart()); });
    outputSel.addEventListener('change', async () => { state.nativeOut = outputSel.value; persist(); await guard(() => engine.restart()); });
    bufSel.addEventListener('change', async () => { state.buffer = bufSel.value; persist(); await guard(() => engine.restart()); });
    engine.onInfo = () => renderPower();
    engine.onError = (e) => toast(`音频设备出错：${e}`, true);
  } else {
    inputSel.addEventListener('change', async () => {
      state.device = inputSel.value;
      persist();
      await guard(() => engine.restart());
    });
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshWebDevices);
  }

  async function refreshWebDevices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    const ins = list.filter((d) => d.kind === 'audioinput');
    inputSel.innerHTML = '';
    inputSel.add(new Option('默认设备', ''));
    for (const d of ins) {
      if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
      inputSel.add(new Option(d.label || `输入设备 ${inputSel.length}`, d.deviceId));
    }
    inputSel.value = [...inputSel.options].some((o) => o.value === state.device) ? state.device : '';
  }

  // ---- 电源
  const powerBtn = $('fxPower');
  async function guard(fn) {
    powerBtn.disabled = true;
    try {
      await fn();
    } catch (err) {
      console.error(err);
      const msg = typeof err === 'string' ? `无法开启音频：${err}`
        : err.name === 'NotAllowedError' ? '没有麦克风权限，请在系统设置里允许本程序使用麦克风'
          : err.name === 'NotFoundError' ? '没找到音频输入设备，请连接声卡或麦克风'
            : `无法开启音频：${err.message || err.name}`;
      toast(msg, true);
      if (engine.running) await engine.stop().catch(() => {});
    }
    powerBtn.disabled = false;
    renderPower();
  }
  async function power(on) {
    await guard(async () => {
      if (on) {
        await engine.start();
        if (!native) { await refreshWebDevices(); await engine.setChannel(); chanSel.value = state.chan; }
      } else {
        await engine.stop();
      }
    });
  }
  function renderPower() {
    const on = engine.running;
    powerBtn.textContent = on ? '关闭效果器' : '开启效果器';
    powerBtn.classList.toggle('active', on);
    $('miniFxLed').classList.toggle('on', on);
    $('miniFxText').textContent = on ? '效果器 开' : '效果器 关';
    $('fxInfo').textContent = on ? `${engine.describe()} · 请戴耳机使用`
      : native ? '选好声卡后开启；有爆音就把缓冲调大一档。' : '请戴耳机使用，避免音箱啸叫。';
  }
  const togglePower = () => power(!engine.running);
  powerBtn.addEventListener('click', togglePower);
  $('miniFx').addEventListener('click', togglePower);

  // ---- 电平表
  const peaks = { in: 0, out: 0 };
  function meter(el, key, v) {
    peaks[key] = Math.max(v, peaks[key] * 0.9);
    const db = 20 * Math.log10(peaks[key] + 1e-9);
    el.style.setProperty('--meter-w', `${el.parentElement.clientWidth}px`);
    el.style.width = `${clamp((db + 60) / 60, 0, 1) * 100}%`;
  }
  function meterLoop() {
    const lv = engine.levels() ?? { in: 0, out: 0 };
    meter($('inMeter'), 'in', lv.in);
    meter($('outMeter'), 'out', lv.out);
    requestAnimationFrame(meterLoop);
  }
  requestAnimationFrame(meterLoop);
  // ---- 预设
  const presetSel = $('presetSel');
  function renderPresets() {
    presetSel.innerHTML = '';
    const g1 = document.createElement('optgroup');
    g1.label = '内置';
    for (const name of Object.keys(BUILTIN_PRESETS)) g1.appendChild(new Option(name, `b:${name}`));
    presetSel.appendChild(g1);
    const names = Object.keys(userPresets);
    if (names.length) {
      const g2 = document.createElement('optgroup');
      g2.label = '我的';
      for (const name of names) g2.appendChild(new Option(name, `u:${name}`));
      presetSel.appendChild(g2);
    }
    presetSel.value = state.preset in userPresets ? `u:${state.preset}` : `b:${state.preset}`;
    if (!presetSel.value) presetSel.selectedIndex = -1;
    $('presetDelete').disabled = !(state.preset in userPresets);
  }
  presetSel.addEventListener('change', () => {
    const [src, name] = [presetSel.value.slice(0, 1), presetSel.value.slice(2)];
    const mods = src === 'u' ? userPresets[name] : BUILTIN_PRESETS[name];
    state.modules = mergeModules(mods);
    state.preset = name;
    syncAll();
    engine.applyAll();
    renderPresets();
    persist();
  });
  $('presetSave').addEventListener('click', async () => {
    const name = await promptText('保存当前音色为预设：', state.preset in userPresets ? state.preset : '');
    if (!name) return;
    if (name in BUILTIN_PRESETS) return toast('不能覆盖内置预设，换个名字吧', true);
    userPresets[name] = structuredClone(state.modules);
    save('fxPresets', userPresets);
    state.preset = name;
    persist();
    renderPresets();
    toast(`已保存预设「${name}」`);
  });
  $('presetDelete').addEventListener('click', () => {
    if (!(state.preset in userPresets)) return;
    if (!confirm(`删除预设「${state.preset}」？`)) return;
    delete userPresets[state.preset];
    save('fxPresets', userPresets);
    toast(`已删除「${state.preset}」`);
    state.preset = '晶莹清音';
    persist();
    renderPresets();
  });

  syncAll();
  renderPresets();
  renderPower();

  return {
    native,
    get running() { return engine.running; },
    /** 测评需要音频引擎在跑；没开就按当前设置开起来 */
    async ensureRunning() {
      if (!engine.running) await power(true);
      return engine.running;
    },
    lastPoll: () => engine.last,
  };
}

function mergeModules(saved) {
  const base = defaultModuleState();
  for (const id of Object.keys(base)) Object.assign(base[id], saved?.[id]);
  return structuredClone(base);
}

function fmt(v, unit) {
  const n = Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
  if (unit === ':1') return `${n}:1`;
  if (unit === 'Hz' && v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return unit ? `${n} ${unit}` : n;
}

function debounce(fn, ms) {
  let t = 0;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}
