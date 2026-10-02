//! 吉他效果链 DSP：噪声门 → 压缩 → 箱头/过载 → 均衡 → 箱体 → 合唱 → 延迟 → 混响 → 限幅。
//! 全部在音频线程逐采样处理，构造时分配好内存，处理过程中不分配。

use serde::Deserialize;
use std::f32::consts::PI;

// ---------------------------------------------------------------- 参数（与前端 state 结构一致）

#[derive(Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Params {
    pub input_gain: f32,
    pub master: f32,
    pub bpm: f32,
    pub modules: Modules,
}
impl Default for Params {
    fn default() -> Self {
        Self { input_gain: 0.0, master: -6.0, bpm: 120.0, modules: Modules::default() }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Modules {
    pub gate: GateP,
    pub comp: CompP,
    pub drive: DriveP,
    pub eq: EqP,
    pub cab: CabP,
    pub chorus: ChorusP,
    pub delay: DelayP,
    pub reverb: ReverbP,
}

macro_rules! params {
    ($name:ident { $($field:ident : $ty:ty = $def:expr),* $(,)? }) => {
        #[derive(Deserialize, Clone, Debug)]
        #[serde(default, rename_all = "camelCase")]
        pub struct $name { pub on: bool, $(pub $field: $ty),* }
        impl Default for $name {
            fn default() -> Self { Self { on: false, $($field: $def),* } }
        }
    };
}

params!(GateP { threshold: f32 = -62.0, release: f32 = 120.0 });
params!(CompP { threshold: f32 = -24.0, ratio: f32 = 4.0, attack: f32 = 8.0, release: f32 = 200.0, makeup: f32 = 6.0 });
params!(EqP { low: f32 = 0.0, mid: f32 = 0.0, mid_freq: f32 = 800.0, high: f32 = 0.0 });
params!(ChorusP { rate: f32 = 0.8, depth: f32 = 50.0, mix: f32 = 50.0 });
params!(DelayP { sync: String = "off".into(), time: f32 = 380.0, feedback: f32 = 35.0, tone: f32 = 4500.0, mix: f32 = 30.0 });
params!(ReverbP { decay: f32 = 2.2, predelay: f32 = 15.0, tone: f32 = 6000.0, mix: f32 = 25.0 });

// "type" 是关键字，单独写
#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct DriveP {
    pub on: bool,
    #[serde(rename = "type")]
    pub kind: String,
    pub gain: f32,
    pub tone: f32,
    pub level: f32,
}
impl Default for DriveP {
    fn default() -> Self { Self { on: false, kind: "od".into(), gain: 50.0, tone: 55.0, level: 0.0 } }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct CabP {
    pub on: bool,
    #[serde(rename = "type")]
    pub kind: String,
    pub cut: f32,
}
impl Default for CabP {
    fn default() -> Self { Self { on: false, kind: "combo".into(), cut: 5500.0 } }
}

// ---------------------------------------------------------------- 基础构件

#[inline]
fn db(x: f32) -> f32 { 10f32.powf(x / 20.0) }

#[derive(Clone, Copy, Default)]
pub struct Biquad { b0: f32, b1: f32, b2: f32, a1: f32, a2: f32, z1: f32, z2: f32 }

#[derive(Clone, Copy)]
pub enum Kind { LowPass, HighPass, Peak, LowShelf, HighShelf }

impl Biquad {
    pub fn new(kind: Kind, fs: f32, f0: f32, q: f32, gain_db: f32) -> Self {
        let mut b = Self::default();
        b.set(kind, fs, f0, q, gain_db);
        b
    }

    /// RBJ Audio EQ Cookbook
    pub fn set(&mut self, kind: Kind, fs: f32, f0: f32, q: f32, gain_db: f32) {
        let f0 = f0.clamp(10.0, fs * 0.45);
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * f0 / fs;
        let (sn, cs) = w0.sin_cos();
        let alpha = sn / (2.0 * q);
        let sa = 2.0 * a.sqrt() * alpha;
        let (b0, b1, b2, a0, a1, a2) = match kind {
            Kind::LowPass => ((1.0 - cs) / 2.0, 1.0 - cs, (1.0 - cs) / 2.0, 1.0 + alpha, -2.0 * cs, 1.0 - alpha),
            Kind::HighPass => ((1.0 + cs) / 2.0, -(1.0 + cs), (1.0 + cs) / 2.0, 1.0 + alpha, -2.0 * cs, 1.0 - alpha),
            Kind::Peak => (1.0 + alpha * a, -2.0 * cs, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * cs, 1.0 - alpha / a),
            Kind::LowShelf => (
                a * ((a + 1.0) - (a - 1.0) * cs + sa),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cs),
                a * ((a + 1.0) - (a - 1.0) * cs - sa),
                (a + 1.0) + (a - 1.0) * cs + sa,
                -2.0 * ((a - 1.0) + (a + 1.0) * cs),
                (a + 1.0) + (a - 1.0) * cs - sa,
            ),
            Kind::HighShelf => (
                a * ((a + 1.0) + (a - 1.0) * cs + sa),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cs),
                a * ((a + 1.0) + (a - 1.0) * cs - sa),
                (a + 1.0) - (a - 1.0) * cs + sa,
                2.0 * ((a - 1.0) - (a + 1.0) * cs),
                (a + 1.0) - (a - 1.0) * cs - sa,
            ),
        };
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    #[inline]
    pub fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// 一阶低通（也可取 x - lp 当高通用）
#[derive(Clone, Copy, Default)]
struct OnePole { a: f32, y: f32 }
impl OnePole {
    fn new(fs: f32, f: f32) -> Self { let mut o = Self::default(); o.set(fs, f); o }
    fn set(&mut self, fs: f32, f: f32) { self.a = 1.0 - (-2.0 * PI * f / fs).exp(); }
    #[inline] fn lp(&mut self, x: f32) -> f32 { self.y += self.a * (x - self.y); self.y }
    #[inline] fn hp(&mut self, x: f32) -> f32 { x - self.lp(x) }
}

/// 参数平滑，避免拖动滑杆时的拉链噪声
#[derive(Clone, Copy)]
struct Smooth { cur: f32, target: f32, k: f32 }
impl Smooth {
    fn new(fs: f32, v: f32, ms: f32) -> Self { Self { cur: v, target: v, k: 1.0 - (-1.0 / (ms * 0.001 * fs)).exp() } }
    #[inline] fn next(&mut self) -> f32 { self.cur += (self.target - self.cur) * self.k; self.cur }
}

// ---------------------------------------------------------------- 噪声门

struct Gate { env: f32, gain: f32, hold: f32, open: bool, thr: f32, rel: f32, att: f32, env_dec: f32, hold_n: f32 }
impl Gate {
    fn new(fs: f32) -> Self {
        Self {
            env: 0.0, gain: 0.0, hold: 0.0, open: false, thr: db(-62.0), rel: 0.0,
            att: 1.0 - (-1.0 / (0.001 * fs)).exp(),
            env_dec: (-1.0 / (0.01 * fs)).exp(),
            hold_n: 0.05 * fs,
        }
    }
    fn set(&mut self, fs: f32, p: &GateP) {
        self.thr = db(p.threshold);
        self.rel = 1.0 - (-1.0 / (p.release.max(5.0) * 0.001 * fs)).exp();
    }
    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        self.env = x.abs().max(self.env * self.env_dec);
        if self.env > self.thr {
            self.open = true;
            self.hold = self.hold_n;
        } else if self.env < self.thr * 0.5 {
            if self.hold > 0.0 { self.hold -= 1.0 } else { self.open = false }
        }
        let (t, k) = if self.open { (1.0, self.att) } else { (0.0, self.rel) };
        self.gain += (t - self.gain) * k;
        x * self.gain
    }
}

// ---------------------------------------------------------------- 压缩

struct Comp { env: f32, thr: f32, ratio: f32, att: f32, rel: f32, makeup: f32 }
impl Comp {
    fn new() -> Self { Self { env: 0.0, thr: -24.0, ratio: 4.0, att: 0.0, rel: 0.0, makeup: 0.0 } }
    fn set(&mut self, fs: f32, p: &CompP) {
        self.thr = p.threshold;
        self.ratio = p.ratio.max(1.0);
        self.att = (-1.0 / (p.attack.max(0.1) * 0.001 * fs)).exp();
        self.rel = (-1.0 / (p.release.max(1.0) * 0.001 * fs)).exp();
        self.makeup = p.makeup;
    }
    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let l = x.abs();
        let c = if l > self.env { self.att } else { self.rel };
        self.env = c * self.env + (1.0 - c) * l;
        let over = 20.0 * (self.env + 1e-9).log10() - self.thr;
        const KNEE: f32 = 6.0;
        let slope = 1.0 / self.ratio - 1.0;
        let gr = if 2.0 * over < -KNEE {
            0.0
        } else if 2.0 * over.abs() <= KNEE {
            slope * (over + KNEE / 2.0).powi(2) / (2.0 * KNEE)
        } else {
            slope * over
        };
        x * db(gr + self.makeup)
    }
}

// ---------------------------------------------------------------- 箱头 / 过载

const OS: usize = 4; // 失真部分 4 倍过采样，压住混叠带来的刺耳毛刺

#[derive(Clone, Copy, PartialEq)]
enum Shape { Soft, Hard, Fuzz }

struct Voice {
    tight: f32, tight_q: f32, tight2: bool,
    pre_f: f32, pre_db: f32,
    gain_lo: f32, gain_hi: f32,
    stages: usize, stage_gain: f32, inter_lp: f32, bias: f32, shape: Shape,
    bass: f32, mid_f: f32, mid: f32, treble: f32,
    /// 输出补偿（dB），让各类型在「音量 0 dB」时响度接近
    trim: f32,
}

fn voice(kind: &str) -> Voice {
    match kind {
        // 清音箱头：轻微染色和压缩感
        "clean" => Voice { tight: 60.0, tight_q: 0.7, tight2: false, pre_f: 800.0, pre_db: 0.0, gain_lo: 0.0, gain_hi: 20.0,
            stages: 1, stage_gain: 1.0, inter_lp: 12000.0, bias: 0.1, shape: Shape::Soft, bass: 2.0, mid_f: 600.0, mid: 0.0, treble: 2.5, trim: -8.0 },
        // 绿色过载（TS 类）：中频鼓包、低频收紧
        "od" => Voice { tight: 160.0, tight_q: 0.5, tight2: false, pre_f: 720.0, pre_db: 7.0, gain_lo: 6.0, gain_hi: 38.0,
            stages: 1, stage_gain: 1.0, inter_lp: 6000.0, bias: 0.15, shape: Shape::Soft, bass: 0.0, mid_f: 800.0, mid: 1.0, treble: 0.0, trim: -9.0 },
        // 英式 Crunch：两级管子推动，明亮
        "crunch" => Voice { tight: 90.0, tight_q: 0.6, tight2: false, pre_f: 1000.0, pre_db: 3.0, gain_lo: 8.0, gain_hi: 36.0,
            stages: 2, stage_gain: 3.0, inter_lp: 7000.0, bias: 0.12, shape: Shape::Soft, bass: 3.0, mid_f: 700.0, mid: 2.0, treble: 2.5, trim: -17.0 },
        // 失真：现代高增益箱头
        "dist" => Voice { tight: 110.0, tight_q: 0.6, tight2: false, pre_f: 800.0, pre_db: 3.0, gain_lo: 16.0, gain_hi: 46.0,
            stages: 2, stage_gain: 6.0, inter_lp: 6000.0, bias: 0.08, shape: Shape::Hard, bass: 3.0, mid_f: 650.0, mid: -2.0, treble: 2.0, trim: -19.0 },
        // 金属：前级推子 + 三级增益，低频非常紧、中频挖空
        "metal" => Voice { tight: 200.0, tight_q: 0.6, tight2: true, pre_f: 1200.0, pre_db: 6.0, gain_lo: 22.0, gain_hi: 54.0,
            stages: 3, stage_gain: 5.0, inter_lp: 5500.0, bias: 0.05, shape: Shape::Hard, bass: 5.0, mid_f: 550.0, mid: -6.0, treble: 3.0, trim: -19.0 },
        // 法兹：粗糙、不对称、中频挖空
        _ => Voice { tight: 40.0, tight_q: 0.7, tight2: false, pre_f: 800.0, pre_db: 0.0, gain_lo: 20.0, gain_hi: 50.0,
            stages: 2, stage_gain: 4.0, inter_lp: 4500.0, bias: 0.3, shape: Shape::Fuzz, bass: 2.0, mid_f: 800.0, mid: -5.0, treble: 0.0, trim: -18.0 },
    }
}

#[inline]
fn shape(s: Shape, x: f32) -> f32 {
    match s {
        Shape::Soft => x.tanh(),
        // 平滑的硬削波
        Shape::Hard => x / (1.0 + x.abs().powf(2.5)).powf(0.4),
        Shape::Fuzz => if x > 0.0 { (1.5 * x).tanh() } else { -0.7 * (1.0 - (1.2 * x).exp()) },
    }
}

struct Drive {
    fs: f32,
    tight1: Biquad, tight2: Biquad, tight2_on: bool,
    pre: Biquad,
    pre_gain: Smooth,
    up: [Biquad; 3], down: [Biquad; 3],
    inter_lp: [OnePole; 3], inter_hp: [OnePole; 3],
    stages: usize, stage_gain: f32, bias: f32, bias_dc: f32, shape: Shape,
    bass: Biquad, mid: Biquad, treble: Biquad, tone: Biquad,
    dc: OnePole,
    level: Smooth,
}

impl Drive {
    fn new(fs: f32) -> Self {
        let fo = fs * OS as f32;
        let aa = |q| Biquad::new(Kind::LowPass, fo, fs * 0.42, q, 0.0);
        // 6 阶巴特沃斯（三段二阶）
        let qs = [0.5176, 0.7071, 1.9319];
        Self {
            fs,
            tight1: Biquad::default(), tight2: Biquad::default(), tight2_on: false,
            pre: Biquad::default(),
            pre_gain: Smooth::new(fs, 1.0, 20.0),
            up: qs.map(aa), down: qs.map(aa),
            inter_lp: [OnePole::default(); 3], inter_hp: [OnePole::new(fo, 25.0); 3],
            stages: 1, stage_gain: 1.0, bias: 0.0, bias_dc: 0.0, shape: Shape::Soft,
            bass: Biquad::default(), mid: Biquad::default(), treble: Biquad::default(), tone: Biquad::default(),
            dc: OnePole::new(fs, 10.0),
            level: Smooth::new(fs, 0.2, 20.0),
        }
    }

    fn set(&mut self, p: &DriveP) {
        let fs = self.fs;
        let fo = fs * OS as f32;
        let v = voice(&p.kind);
        self.tight1.set(Kind::HighPass, fs, v.tight, v.tight_q, 0.0);
        self.tight2.set(Kind::HighPass, fs, v.tight, v.tight_q, 0.0);
        self.tight2_on = v.tight2;
        self.pre.set(Kind::Peak, fs, v.pre_f, 0.7, v.pre_db);
        self.pre_gain.target = db(v.gain_lo + (v.gain_hi - v.gain_lo) * p.gain.clamp(0.0, 100.0) / 100.0);
        for f in &mut self.inter_lp { f.set(fo, v.inter_lp) }
        self.stages = v.stages;
        self.stage_gain = v.stage_gain;
        self.bias = v.bias;
        self.bias_dc = shape(v.shape, v.bias);
        self.shape = v.shape;
        self.bass.set(Kind::LowShelf, fs, 120.0, 0.707, v.bass);
        self.mid.set(Kind::Peak, fs, v.mid_f, 0.8, v.mid);
        self.treble.set(Kind::HighShelf, fs, 3000.0, 0.707, v.treble);
        self.tone.set(Kind::LowPass, fs, 1500.0 * 2f32.powf(p.tone.clamp(0.0, 100.0) / 100.0 * 3.0), 0.6, 0.0);
        self.level.target = db(p.level + v.trim);
    }

    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let mut s = self.tight1.run(x);
        if self.tight2_on { s = self.tight2.run(s) }
        s = self.pre.run(s) * self.pre_gain.next();

        let mut out = 0.0;
        for k in 0..OS {
            let mut u = if k == 0 { s * OS as f32 } else { 0.0 };
            for f in &mut self.up { u = f.run(u) }
            for i in 0..self.stages {
                u = shape(self.shape, u + self.bias) - self.bias_dc;
                u = self.inter_hp[i].hp(u);
                u = self.inter_lp[i].lp(u);
                if i + 1 < self.stages { u *= self.stage_gain }
            }
            for f in &mut self.down { u = f.run(u) }
            out = u;
        }

        let mut y = self.bass.run(out);
        y = self.mid.run(y);
        y = self.treble.run(y);
        y = self.tone.run(y);
        y = self.dc.hp(y);
        y * self.level.next()
    }
}

// ---------------------------------------------------------------- 均衡

struct Eq { low: Biquad, mid: Biquad, high: Biquad }
impl Eq {
    fn set(&mut self, fs: f32, p: &EqP) {
        self.low.set(Kind::LowShelf, fs, 120.0, 0.707, p.low);
        self.mid.set(Kind::Peak, fs, p.mid_freq, 0.9, p.mid);
        self.high.set(Kind::HighShelf, fs, 3200.0, 0.707, p.high);
    }
    #[inline] fn run(&mut self, x: f32) -> f32 { self.high.run(self.mid.run(self.low.run(x))) }
}

// ---------------------------------------------------------------- 箱体

struct Cab { f: [Biquad; 7] }
impl Cab {
    fn set(&mut self, fs: f32, kind: &str, cut: f32) {
        // (共振频率, 共振增益, 箱声 500Hz, 临场频率, 临场增益, 4k 刺耳频段)
        let (rf, rg, bx, pf, pg, fizz) = match kind {
            "open" => (100.0, 2.0, 0.0, 3000.0, 3.0, -1.0),
            "stack" => (95.0, 5.0, -4.0, 2700.0, 4.0, -4.0),
            _ => (120.0, 3.0, -1.0, 2200.0, 4.0, -2.0),
        };
        self.f[0].set(Kind::HighPass, fs, 75.0, 0.7, 0.0);
        self.f[1].set(Kind::Peak, fs, rf, 1.2, rg);
        self.f[2].set(Kind::Peak, fs, 500.0, 1.0, bx);
        self.f[3].set(Kind::Peak, fs, pf, 1.2, pg);
        self.f[4].set(Kind::Peak, fs, 4200.0, 2.0, fizz);
        self.f[5].set(Kind::LowPass, fs, cut, 0.7, 0.0);
        self.f[6].set(Kind::LowPass, fs, cut * 1.15, 0.6, 0.0);
    }
    #[inline] fn run(&mut self, x: f32) -> f32 { self.f.iter_mut().fold(x, |s, f| f.run(s)) }
}

// ---------------------------------------------------------------- 合唱

struct Chorus { buf: Vec<f32>, w: usize, phase: f32, inc: f32, depth: f32 }
impl Chorus {
    fn new() -> Self { Self { buf: vec![0.0; 1 << 14], w: 0, phase: 0.0, inc: 0.0, depth: 0.0 } }
    fn set(&mut self, fs: f32, p: &ChorusP) {
        self.inc = p.rate / fs;
        self.depth = p.depth / 100.0 * 0.004 * fs;
    }
    #[inline]
    fn read(&self, delay: f32) -> f32 {
        let mask = self.buf.len() - 1;
        let pos = self.w as f32 - delay;
        let i = pos.floor();
        let frac = pos - i;
        let i = (i as isize).rem_euclid(self.buf.len() as isize) as usize;
        self.buf[i] * (1.0 - frac) + self.buf[(i + 1) & mask] * frac
    }
    #[inline]
    fn run(&mut self, x: f32, fs: f32) -> (f32, f32) {
        let mask = self.buf.len() - 1;
        self.buf[self.w] = x;
        let base = 0.012 * fs;
        let lfo = (2.0 * PI * self.phase).sin();
        self.phase = (self.phase + self.inc).fract();
        let l = self.read(base + self.depth * lfo);
        let r = self.read(base - self.depth * lfo); // 左右反相，展开立体声
        self.w = (self.w + 1) & mask;
        (l, r)
    }
}

// ---------------------------------------------------------------- 延迟

struct Delay { buf: Vec<f32>, w: usize, time: Smooth, fb: f32, tone: OnePole }
impl Delay {
    fn new(fs: f32) -> Self {
        Self { buf: vec![0.0; (fs * 3.0) as usize + 4], w: 0, time: Smooth::new(fs, 0.38 * fs, 60.0), fb: 0.35, tone: OnePole::new(fs, 4500.0) }
    }
    fn set(&mut self, fs: f32, p: &DelayP, bpm: f32) {
        let beats = match p.sync.as_str() { "1/4" => 1.0, "1/8." => 0.75, "1/8" => 0.5, "1/16" => 0.25, _ => 0.0 };
        let secs = if beats > 0.0 { 60.0 / bpm.max(30.0) * beats } else { p.time / 1000.0 };
        self.time.target = (secs * fs).clamp(1.0, self.buf.len() as f32 - 2.0);
        self.fb = (p.feedback / 100.0).clamp(0.0, 0.95);
        self.tone.set(fs, p.tone);
    }
    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let n = self.buf.len();
        let d = self.time.next();
        let pos = self.w as f32 - d;
        let i = pos.floor();
        let frac = pos - i;
        let i = (i as isize).rem_euclid(n as isize) as usize;
        let y = self.buf[i] * (1.0 - frac) + self.buf[(i + 1) % n] * frac;
        let y = self.tone.lp(y);
        self.buf[self.w] = x + y * self.fb;
        self.w = (self.w + 1) % n;
        y
    }
}

// ---------------------------------------------------------------- 混响（Freeverb）

struct Comb { buf: Vec<f32>, i: usize, store: f32 }
impl Comb {
    #[inline]
    fn run(&mut self, x: f32, fb: f32, damp: f32) -> f32 {
        let y = self.buf[self.i];
        self.store = y * (1.0 - damp) + self.store * damp;
        self.buf[self.i] = x + self.store * fb;
        self.i = (self.i + 1) % self.buf.len();
        y
    }
}
struct Allpass { buf: Vec<f32>, i: usize }
impl Allpass {
    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let b = self.buf[self.i];
        self.buf[self.i] = x + b * 0.5;
        self.i = (self.i + 1) % self.buf.len();
        b - x
    }
}

struct Reverb { combs: [Vec<Comb>; 2], aps: [Vec<Allpass>; 2], pre: Vec<f32>, pw: usize, pre_n: usize, fb: f32, damp: f32, tone: [OnePole; 2] }
impl Reverb {
    fn new(fs: f32) -> Self {
        const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
        const APS: [usize; 4] = [556, 441, 341, 225];
        let sc = fs / 44100.0;
        let mk = |spread: usize| {
            (
                COMBS.iter().map(|&n| Comb { buf: vec![0.0; ((n + spread) as f32 * sc) as usize], i: 0, store: 0.0 }).collect(),
                APS.iter().map(|&n| Allpass { buf: vec![0.0; ((n + spread) as f32 * sc) as usize], i: 0 }).collect(),
            )
        };
        let (cl, al) = mk(0);
        let (cr, ar) = mk(23);
        Self { combs: [cl, cr], aps: [al, ar], pre: vec![0.0; (fs * 0.2) as usize], pw: 0, pre_n: 1, fb: 0.84, damp: 0.3, tone: [OnePole::new(fs, 6000.0); 2] }
    }
    fn set(&mut self, fs: f32, p: &ReverbP) {
        let t = ((p.decay - 0.3) / 7.7).clamp(0.0, 1.0);
        self.fb = 0.7 + 0.285 * t.sqrt();
        self.damp = (1.0 - (p.tone - 1000.0) / 11000.0).clamp(0.05, 0.9) * 0.6;
        self.pre_n = ((p.predelay / 1000.0 * fs) as usize).clamp(1, self.pre.len() - 1);
        for f in &mut self.tone { f.set(fs, p.tone) }
    }
    #[inline]
    fn run(&mut self, x: f32) -> (f32, f32) {
        let n = self.pre.len();
        self.pre[self.pw] = x;
        let xin = self.pre[(self.pw + n - self.pre_n) % n] * 0.015;
        self.pw = (self.pw + 1) % n;
        let mut out = [0.0f32; 2];
        for ch in 0..2 {
            let mut s = 0.0;
            for c in &mut self.combs[ch] { s += c.run(xin, self.fb, self.damp) }
            for a in &mut self.aps[ch] { s = a.run(s) }
            out[ch] = self.tone[ch].lp(s);
        }
        (out[0] * 3.0, out[1] * 3.0)
    }
}

// ---------------------------------------------------------------- 整条效果链

pub struct Chain {
    fs: f32,
    in_gain: Smooth,
    master: Smooth,
    gate: Gate, gate_w: Smooth,
    comp: Comp, comp_w: Smooth,
    drive: Drive, drive_w: Smooth,
    eq: Eq, eq_w: Smooth,
    cab: Cab, cab_w: Smooth,
    chorus: Chorus, chorus_w: Smooth,
    delay: Delay, delay_w: Smooth,
    reverb: Reverb, reverb_w: Smooth,
}

impl Chain {
    pub fn new(fs: f32) -> Self {
        let w = || Smooth::new(fs, 0.0, 15.0);
        let mut c = Self {
            fs,
            in_gain: Smooth::new(fs, 1.0, 20.0),
            master: Smooth::new(fs, 0.5, 20.0),
            gate: Gate::new(fs), gate_w: w(),
            comp: Comp::new(), comp_w: w(),
            drive: Drive::new(fs), drive_w: w(),
            eq: Eq { low: Biquad::default(), mid: Biquad::default(), high: Biquad::default() }, eq_w: w(),
            cab: Cab { f: [Biquad::default(); 7] }, cab_w: w(),
            chorus: Chorus::new(), chorus_w: w(),
            delay: Delay::new(fs), delay_w: w(),
            reverb: Reverb::new(fs), reverb_w: w(),
        };
        c.set(&Params::default());
        c
    }

    pub fn set(&mut self, p: &Params) {
        let fs = self.fs;
        let m = &p.modules;
        self.in_gain.target = db(p.input_gain);
        self.master.target = db(p.master);
        self.gate.set(fs, &m.gate);
        self.comp.set(fs, &m.comp);
        self.drive.set(&m.drive);
        self.eq.set(fs, &m.eq);
        self.cab.set(fs, &m.cab.kind, m.cab.cut);
        self.chorus.set(fs, &m.chorus);
        self.delay.set(fs, &m.delay, p.bpm);
        self.reverb.set(fs, &m.reverb);
        let on = |b: bool| if b { 1.0 } else { 0.0 };
        self.gate_w.target = on(m.gate.on);
        self.comp_w.target = on(m.comp.on);
        self.drive_w.target = on(m.drive.on);
        self.eq_w.target = on(m.eq.on);
        self.cab_w.target = on(m.cab.on);
        self.chorus_w.target = on(m.chorus.on) * m.chorus.mix / 100.0;
        self.delay_w.target = on(m.delay.on) * m.delay.mix / 100.0;
        self.reverb_w.target = on(m.reverb.on) * m.reverb.mix / 100.0;
    }

    /// 输入单声道，返回 (输入电平, 左, 右)
    #[inline]
    pub fn run(&mut self, x: f32) -> (f32, f32, f32) {
        #[inline]
        fn ins(x: f32, fx: f32, w: f32) -> f32 { x + (fx - x) * w }

        let x = x * self.in_gain.next();
        let mut s = x;
        s = ins(s, self.gate.run(s), self.gate_w.next());
        s = ins(s, self.comp.run(s), self.comp_w.next());
        s = ins(s, self.drive.run(s), self.drive_w.next());
        s = ins(s, self.eq.run(s), self.eq_w.next());
        s = ins(s, self.cab.run(s), self.cab_w.next());

        let (cl, cr) = self.chorus.run(s, self.fs);
        let cw = self.chorus_w.next();
        let (mut l, mut r) = (s + cl * cw, s + cr * cw);

        let mono = (l + r) * 0.5;
        let d = self.delay.run(mono) * self.delay_w.next();
        l += d;
        r += d;

        let (rl, rr) = self.reverb.run((l + r) * 0.5);
        let rw = self.reverb_w.next();
        l += rl * rw;
        r += rr * rw;

        let g = self.master.next();
        (x, limit(l * g), limit(r * g))
    }
}

/// 软限幅：-1 dBFS 以下线性，以上平滑压到 0 dBFS 内，保护耳朵和音箱
#[inline]
fn limit(x: f32) -> f32 {
    const K: f32 = 0.89;
    let a = x.abs();
    if a <= K { x } else { x.signum() * (K + (1.0 - K) * ((a - K) / (1.0 - K)).tanh()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 模拟拨弦：A 弦基频加泛音、指数衰减，峰值约 -12 dBFS
    fn pluck(fs: f32, secs: f32) -> Vec<f32> {
        let n = (fs * secs) as usize;
        let mut v: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / fs;
                let tt = t % 1.0; // 每秒拨一次
                (1..=12).map(|k| (2.0 * PI * 110.0 * k as f32 * tt).sin() / k as f32 * (-tt * (1.5 + k as f32 * 0.4)).exp()).sum::<f32>()
            })
            .collect();
        let pk = v.iter().fold(0f32, |m, x| m.max(x.abs()));
        v.iter_mut().for_each(|x| *x *= 0.25 / pk);
        v
    }

    fn rms_db(xs: &[f32]) -> f32 {
        (10.0 * (xs.iter().map(|x| x * x).sum::<f32>() / xs.len() as f32).log10()) as f32
    }

    #[test]
    fn loudness_by_type() {
        let fs = 44100.0;
        let input = pluck(fs, 4.0);
        println!("输入 RMS {:.1} dBFS", rms_db(&input));
        for kind in ["clean", "od", "crunch", "dist", "metal", "fuzz"] {
            for gain in [20.0, 50.0, 80.0] {
                let mut p = Params::default();
                p.master = 0.0;
                p.modules.drive = DriveP { on: true, kind: kind.into(), gain, tone: 55.0, level: 0.0 };
                p.modules.cab.on = true;
                p.modules.cab.kind = "stack".into();
                let mut c = Chain::new(fs);
                c.set(&p);
                let t0 = std::time::Instant::now();
                let out: Vec<f32> = input.iter().map(|&x| c.run(x).1).collect();
                let cpu = t0.elapsed().as_secs_f32() / 4.0 * 100.0;
                assert!(out.iter().all(|x| x.is_finite() && x.abs() <= 1.0));
                println!("{kind:7} gain {gain:3}: RMS {:6.1} dBFS  CPU {cpu:.2}%", rms_db(&out[fs as usize..]));
            }
        }
    }

    #[test]
    fn full_chain_stable() {
        let fs = 48000.0;
        let input = pluck(fs, 3.0);
        let mut p = Params::default();
        let m = &mut p.modules;
        m.gate.on = true; m.comp.on = true; m.drive.on = true; m.eq.on = true; m.cab.on = true;
        m.chorus.on = true; m.delay.on = true; m.reverb.on = true;
        m.delay.feedback = 90.0; m.reverb.decay = 8.0;
        let mut c = Chain::new(fs);
        c.set(&p);
        let t0 = std::time::Instant::now();
        for &x in &input { let (_, l, r) = c.run(x); assert!(l.is_finite() && r.is_finite()); }
        println!("全链 CPU {:.2}%", t0.elapsed().as_secs_f32() / 3.0 * 100.0);
    }
}
