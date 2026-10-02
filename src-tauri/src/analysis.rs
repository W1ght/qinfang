//! 演奏分析：从录下的吉他干声里找出每个音的起音时间、音高和力度。
//! - 起音：对数频谱通量 + 自适应阈值，再在包络上精确定位到毫秒级
//! - 音高：基于 FFT 的 YIN
//! - 连奏：击弦/勾弦几乎没有拨弦瞬态，用音高跳变补充检测

use rustfft::{num_complex::Complex32, FftPlanner};
use serde::Serialize;
use std::f32::consts::PI;

#[derive(Serialize, Clone, Debug)]
pub struct Event {
    /// 相对录音开头的秒数
    pub t: f32,
    /// 起音后的稳定音高（MIDI，无法识别时为 -1）
    pub midi: f32,
    /// 这个音持续期间的最高音高（推弦用）
    pub midi_max: f32,
    /// 起音峰值（归一化后，0..1）
    pub amp: f32,
    /// 0 = 拨弦起音，1 = 音高跳变（连奏）
    pub kind: u8,
}

const N: usize = 1024; // 频谱通量窗长
const H: usize = 128; // 频谱通量步长（44.1k 下约 2.9ms）
const PW: usize = 2048; // 音高窗长
const PH: usize = 256; // 音高步长

pub fn analyze(raw: &[f32], sr: f32) -> Vec<Event> {
    if raw.len() < PW * 2 {
        return vec![];
    }
    // 去直流 + 40Hz 高通
    let mut x = Vec::with_capacity(raw.len());
    let a = (-2.0 * PI * 40.0 / sr).exp();
    let (mut px, mut py) = (0f32, 0f32);
    for &s in raw {
        py = a * (py + s - px);
        px = s;
        x.push(py);
    }
    let peak = x.iter().fold(0f32, |m, v| m.max(v.abs())).max(1e-6);
    x.iter_mut().for_each(|v| *v /= peak);

    let mut planner = FftPlanner::<f32>::new();
    let onsets = detect_onsets(&x, sr, &mut planner);
    let pitch = pitch_track(&x, sr, &mut planner);

    let frame_of = |sample: usize| (sample as f32 / PH as f32).round() as usize;
    let pitch_at = |from: usize, to: usize| -> (f32, f32) {
        // 区间内有效音高的中位数与 90 分位
        let mut v: Vec<f32> = (frame_of(from)..=frame_of(to).min(pitch.len().saturating_sub(1)))
            .filter_map(|f| pitch.get(f).copied().flatten())
            .collect();
        if v.is_empty() {
            return (-1.0, -1.0);
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (v[v.len() / 2], v[(v.len() * 9 / 10).min(v.len() - 1)])
    };
    // 音高窗中心 = 帧起点 + PW/2，换算成“窗口主要覆盖的样本区间”
    let half = PW / 2;
    let ms = |m: f32| (m * 0.001 * sr) as usize;

    let mut events: Vec<Event> = vec![];
    for (i, &s) in onsets.iter().enumerate() {
        let next = onsets.get(i + 1).copied().unwrap_or(x.len());
        // 稳定段：起音后 15ms 起，到下个音前 5ms，最长 90ms
        let a0 = s + ms(15.0);
        let a1 = (s + ms(90.0)).min(next.saturating_sub(ms(5.0))).max(a0);
        let (midi, _) = pitch_at(a0.saturating_sub(half), a1.saturating_sub(half));
        let midi_max = max_pitch(&pitch, frame_of(a0.saturating_sub(half)), frame_of(next.saturating_sub(half + ms(5.0))), midi);
        let amp = x[s..(s + ms(30.0)).min(x.len())].iter().fold(0f32, |m, v| m.max(v.abs()));
        events.push(Event { t: s as f32 / sr, midi, midi_max, amp, kind: 0 });
    }

    // 连奏：稳定音高之间的跳变，附近没有拨弦起音时补一个事件
    let stable = stable_segments(&pitch);
    for w in stable.windows(2) {
        let (prev, cur) = (&w[0], &w[1]);
        if (cur.midi - prev.midi).abs() < 0.8 {
            continue;
        }
        // 新音占到窗口一半多时音高才会跳过去，起点大约在跳变帧中心往前 1/4 窗
        let s = (cur.start * PH + half).saturating_sub(PW / 4);
        let near = onsets.iter().any(|&o| (o as isize - s as isize).unsigned_abs() < ms(50.0));
        if near {
            continue;
        }
        let t = s as f32 / sr;
        let amp = x[s.min(x.len() - 1)..(s + ms(30.0)).min(x.len())].iter().fold(0f32, |m, v| m.max(v.abs()));
        events.push(Event { t, midi: cur.midi, midi_max: cur.max, amp, kind: 1 });
    }
    events.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    events
}

/// 音符持续期间的最高音高（推弦），只认基准音高往下 1、往上 4 个半音以内的值，排除倍频误判
fn max_pitch(p: &[Option<f32>], from: usize, to: usize, base: f32) -> f32 {
    if base < 0.0 {
        return -1.0;
    }
    let mut v: Vec<f32> = (from..=to.min(p.len().saturating_sub(1)))
        .filter_map(|f| p.get(f).copied().flatten())
        .filter(|m| *m > base - 1.0 && *m < base + 4.0)
        .collect();
    if v.is_empty() {
        return base;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[(v.len() * 9 / 10).min(v.len() - 1)]
}

fn hann(n: usize) -> Vec<f32> {
    (0..n).map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / n as f32).cos()).collect()
}

/// 返回起音的样本位置
fn detect_onsets(x: &[f32], sr: f32, planner: &mut FftPlanner<f32>) -> Vec<usize> {
    let fft = planner.plan_fft_forward(N);
    let win = hann(N);
    let bins_hi = ((6000.0 / sr) * N as f32) as usize;
    let frames = (x.len() - N) / H;
    let mut prev = vec![0f32; N / 2];
    let mut flux = vec![0f32; frames];
    let mut rms = vec![0f32; frames];
    let mut buf = vec![Complex32::new(0.0, 0.0); N];
    for f in 0..frames {
        let off = f * H;
        let mut e = 0.0;
        for i in 0..N {
            let v = x[off + i];
            e += v * v;
            buf[i] = Complex32::new(v * win[i], 0.0);
        }
        rms[f] = (e / N as f32).sqrt();
        fft.process(&mut buf);
        let mut s = 0.0;
        for k in 2..bins_hi {
            let m = (1.0 + 100.0 * buf[k].norm()).ln();
            s += (m - prev[k]).max(0.0);
            prev[k] = m;
        }
        flux[f] = s;
    }
    let fmax = flux.iter().fold(0f32, |m, &v| m.max(v)).max(1e-9);
    flux.iter_mut().for_each(|v| *v /= fmax);
    let rmax = rms.iter().fold(0f32, |m, &v| m.max(v));
    let floor = rmax * 0.01; // -40 dB 以下当作静音

    let w = ((0.06 * sr) as usize / H).max(3); // 前后 60ms 的局部均值
    let min_gap = ((0.03 * sr) as usize / H).max(2);
    let mut out = vec![];
    let mut last: isize = -(min_gap as isize) * 2;
    for f in 1..frames.saturating_sub(1) {
        let lo = f.saturating_sub(w);
        let hi = (f + w).min(frames - 1);
        let mean = flux[lo..=hi].iter().sum::<f32>() / (hi - lo + 1) as f32;
        let local_max = flux[f.saturating_sub(3)..=(f + 3).min(frames - 1)].iter().fold(0f32, |m, &v| m.max(v));
        let thr = mean * 1.4 + 0.05;
        if flux[f] >= local_max && flux[f] > thr && rms[(f + 2).min(frames - 1)] > floor && f as isize - last >= min_gap as isize {
            out.push(refine(x, f * H, sr));
            last = f as isize;
        }
    }
    out.sort_unstable();
    out.dedup_by(|a, b| (*a as isize - *b as isize).abs() < (0.02 * sr) as isize);
    out
}

/// 通量峰值帧里找包络上升最陡的点，精确到约 1ms。
/// 起音刚进入窗口后半段时通量最大，所以搜索范围是整帧再往后一点。
fn refine(x: &[f32], frame_start: usize, sr: f32) -> usize {
    let from = frame_start.saturating_sub(H * 2);
    let to = (frame_start + N + H * 2).min(x.len());
    let center = frame_start + N / 2;
    let step = ((0.0005 * sr) as usize).max(8);
    let win = step * 4;
    let env = |i: usize| x[i..(i + win).min(x.len())].iter().map(|v| v * v).sum::<f32>();
    let mut best = center.min(x.len() - 1);
    let mut best_rise = 0.0;
    let mut i = from;
    while i + 2 * win < to {
        let rise = env(i + win) - env(i);
        if rise > best_rise {
            best_rise = rise;
            best = i + win;
        }
        i += step;
    }
    best
}

/// 每帧音高（MIDI），无音高为 None
fn pitch_track(x: &[f32], sr: f32, planner: &mut FftPlanner<f32>) -> Vec<Option<f32>> {
    let size = PW * 2;
    let fwd = planner.plan_fft_forward(size);
    let inv = planner.plan_fft_inverse(size);
    let tau_min = (sr / 1400.0) as usize;
    let tau_max = ((sr / 70.0) as usize).min(PW - 1);
    let frames = (x.len() - PW) / PH;
    let rmax = x.iter().fold(0f32, |m, v| m.max(v.abs()));
    let mut out = Vec::with_capacity(frames);
    let mut buf = vec![Complex32::new(0.0, 0.0); size];
    let mut buf2 = vec![Complex32::new(0.0, 0.0); size];
    let mut d = vec![0f32; tau_max + 1];
    for f in 0..frames {
        let seg = &x[f * PH..f * PH + PW];
        let e: f32 = seg.iter().map(|v| v * v).sum();
        if (e / PW as f32).sqrt() < rmax * 0.01 {
            out.push(None);
            continue;
        }
        // 差分函数 d(τ) = Σ_{i<w} (x_i − x_{i+τ})² = Σx_i² + Σx_{i+τ}² − 2r(τ)
        // r(τ) 是前 w 个样本与整段的互相关，用 FFT 算：IFFT(conj(A)·B)
        let w = PW - tau_max;
        for i in 0..size {
            buf[i] = Complex32::new(if i < w { seg[i] } else { 0.0 }, 0.0);
            buf2[i] = Complex32::new(if i < PW { seg[i] } else { 0.0 }, 0.0);
        }
        fwd.process(&mut buf);
        fwd.process(&mut buf2);
        for (a, b) in buf.iter_mut().zip(buf2.iter()) {
            *a = a.conj() * b;
        }
        inv.process(&mut buf);
        let r = |t: usize| buf[t].re / size as f32;
        let mut cum = vec![0f32; PW + 1];
        for i in 0..PW {
            cum[i + 1] = cum[i] + seg[i] * seg[i];
        }
        let e0 = cum[w];
        for t in 1..=tau_max {
            let et = cum[t + w] - cum[t];
            d[t] = (e0 + et - 2.0 * r(t)).max(0.0);
        }
        // 累积均值归一化
        let mut sum = 0.0;
        let mut cmnd = vec![1f32; tau_max + 1];
        for t in 1..=tau_max {
            sum += d[t];
            cmnd[t] = if sum > 0.0 { d[t] * t as f32 / sum } else { 1.0 };
        }
        let mut tau = 0;
        for t in tau_min..tau_max {
            if cmnd[t] < 0.15 {
                let mut tt = t;
                while tt + 1 < tau_max && cmnd[tt + 1] < cmnd[tt] {
                    tt += 1;
                }
                tau = tt;
                break;
            }
        }
        if tau == 0 {
            out.push(None);
            continue;
        }
        // 抛物线插值
        let (a, b, c) = (cmnd[tau - 1], cmnd[tau], cmnd[(tau + 1).min(tau_max)]);
        let den = a - 2.0 * b + c;
        let shift = if den.abs() > 1e-9 { 0.5 * (a - c) / den } else { 0.0 };
        let hz = sr / (tau as f32 + shift.clamp(-0.5, 0.5));
        out.push(Some(69.0 + 12.0 * (hz / 440.0).log2()));
    }
    out
}

struct Segment { start: usize, midi: f32, max: f32 }

/// 连续至少 3 帧、帧间变化小于 0.4 半音的音高段
fn stable_segments(p: &[Option<f32>]) -> Vec<Segment> {
    let mut out = vec![];
    let mut i = 0;
    while i < p.len() {
        let Some(m0) = p[i] else { i += 1; continue };
        let mut j = i + 1;
        let mut vals = vec![m0];
        while j < p.len() {
            match p[j] {
                Some(m) if (m - vals[vals.len() - 1]).abs() < 0.4 => { vals.push(m); j += 1; }
                _ => break,
            }
        }
        if vals.len() >= 3 {
            let mut s = vals.clone();
            s.sort_by(|a, b| a.partial_cmp(b).unwrap());
            out.push(Segment { start: i, midi: s[s.len() / 2], max: s[s.len() - 1] });
        }
        i = j;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成拨弦音：基频 + 泛音，带起音瞬态和衰减
    fn note(buf: &mut [f32], sr: f32, at: f32, midi: f32, dur: f32, amp: f32, attack: bool) {
        let f0 = 440.0 * 2f32.powf((midi - 69.0) / 12.0);
        let s0 = (at * sr) as usize;
        let n = (dur * sr) as usize;
        let mut phase = vec![0f32; 8];
        for i in 0..n {
            let t = i as f32 / sr;
            let env = if attack { (-t * 6.0).exp() } else { 0.6 * (-t * 6.0).exp() } * (1.0 - (-t * 800.0).exp());
            let mut v = 0.0;
            for k in 1..=6 {
                phase[k] += 2.0 * PI * f0 * k as f32 / sr;
                v += phase[k].sin() / k as f32;
            }
            if attack && i < (0.004 * sr) as usize {
                v += ((i * 7919 % 1000) as f32 / 500.0 - 1.0) * 1.5; // 拨弦噪声
            }
            if s0 + i < buf.len() {
                buf[s0 + i] += v * env * amp;
            }
        }
    }

    #[test]
    fn detects_notes_and_pitch() {
        let sr = 44100.0;
        let mut x = vec![0f32; (sr * 4.0) as usize];
        // 120 BPM 十六分音符（125ms）：A2 B2 C3 D3 …
        let midis = [45.0, 47.0, 48.0, 50.0, 52.0, 53.0, 55.0, 57.0];
        let times: Vec<f32> = (0..midis.len()).map(|i| 0.5 + i as f32 * 0.125).collect();
        for (i, &m) in midis.iter().enumerate() {
            note(&mut x, sr, times[i], m, 0.125, 0.3, true);
        }
        // 连奏：1.8s 拨 E3，1.95s 击弦到 F#3（无瞬态）
        note(&mut x, sr, 1.8, 52.0, 0.15, 0.3, true);
        note(&mut x, sr, 1.95, 54.0, 0.3, 0.3, false);
        let ev = analyze(&x, sr);
        for e in &ev {
            println!("t={:.4} midi={:.2} max={:.2} amp={:.2} kind={}", e.t, e.midi, e.midi_max, e.amp, e.kind);
        }
        for (i, &t) in times.iter().enumerate() {
            let hit = ev.iter().find(|e| (e.t - t).abs() < 0.012).unwrap_or_else(|| panic!("漏检 {t}"));
            assert!((hit.midi - midis[i]).abs() < 0.5, "音高错 {} vs {}", hit.midi, midis[i]);
        }
        assert!(ev.iter().any(|e| (e.t - 1.95).abs() < 0.03 && (e.midi - 54.0).abs() < 0.5), "连奏音没识别出来");
    }
}
