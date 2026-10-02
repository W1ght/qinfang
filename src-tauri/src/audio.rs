//! 原生音频引擎：用 cpal 打开 ASIO / WASAPI 设备，输入 → 环形缓冲 → 效果链 → 输出。
//! cpal 的 Stream 不保证 Send，所以设备与流都放在一个专用线程里，通过消息控制。

use crate::dsp::{Chain, Params};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, FromSample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::HeapRb;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;
use std::sync::{Arc, Mutex};

#[derive(Serialize)]
pub struct HostInfo {
    pub id: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub default_input: Option<String>,
    pub default_output: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartCfg {
    pub host: String,
    pub input: String,
    pub output: String,
    /// 0 = 驱动默认
    pub buffer: u32,
    /// 输入通道：0 起；-1 = 前两路混合
    pub channel: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub sample_rate: u32,
    pub in_channels: u16,
    pub buffer_min: u32,
    pub buffer_max: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Poll {
    pub running: bool,
    pub in_peak: f32,
    pub out_peak: f32,
    pub frames: u32,
    pub sample_rate: u32,
    pub error: Option<String>,
    /// 测评状态：0 空闲 / 1 进行中 / 2 已结束待分析
    pub take: u8,
    /// 测评已进行的秒数（从计划起点算，含预备拍）
    pub take_pos: f32,
}

/// 测评：在 ASIO 时钟上按计划打节拍，同时录下吉他干声
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeCfg {
    /// 节拍点时间（秒，相对计划起点）
    pub clicks: Vec<f64>,
    pub accents: Vec<bool>,
    /// 计划总长（秒）
    pub length: f64,
    pub click_gain: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeResult {
    /// 时间相对计划起点（已扣除输入输出延迟）
    pub events: Vec<crate::analysis::Event>,
    pub sample_rate: u32,
    pub latency_ms: f32,
    pub seconds: f32,
}

struct TakePlan {
    clicks: Vec<(u64, bool)>,
    end: u64,
    gain: f32,
}

#[derive(Default)]
struct Shared {
    in_frame: AtomicU64,
    out_frame: AtomicU64,
    in_lat: AtomicU32,
    out_lat: AtomicU32,
    rec_on: AtomicBool,
    rec_start_in: AtomicU64,
    take_start_out: AtomicU64,
    io_off: AtomicI64,
    take_state: AtomicU8,
    take_cancel: AtomicBool,
    in_peak: AtomicU32,
    out_peak: AtomicU32,
    frames: AtomicU32,
    sample_rate: AtomicU32,
    error: Mutex<Option<String>>,
}

enum Cmd {
    Devices(Sender<Result<Vec<HostInfo>, String>>),
    Start(StartCfg, Sender<Result<StartInfo, String>>),
    Stop(Sender<()>),
    TakeStart(TakeCfg, Sender<Result<(), String>>),
    TakeResult(Sender<Result<TakeResult, String>>),
    TakeCancel(Sender<()>),
}

pub struct Audio {
    cmd: Mutex<Sender<Cmd>>,
    params_tx: Arc<Mutex<Option<Sender<Params>>>>,
    last: Arc<Mutex<Params>>,
    shared: Arc<Shared>,
    running: Arc<Mutex<bool>>,
}

impl Audio {
    pub fn new() -> Self {
        let (tx, rx) = channel();
        let shared = Arc::new(Shared::default());
        let params_tx = Arc::new(Mutex::new(None));
        let last = Arc::new(Mutex::new(Params::default()));
        let running = Arc::new(Mutex::new(false));
        {
            let (shared, params_tx, last, running) = (shared.clone(), params_tx.clone(), last.clone(), running.clone());
            std::thread::Builder::new()
                .name("audio-control".into())
                .spawn(move || control_thread(rx, shared, params_tx, last, running))
                .expect("无法创建音频线程");
        }
        Self { cmd: Mutex::new(tx), params_tx, last, shared, running }
    }

    fn ask<T>(&self, make: impl FnOnce(Sender<T>) -> Cmd) -> Result<T, String> {
        let (tx, rx) = channel();
        self.cmd.lock().unwrap().send(make(tx)).map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())
    }

    pub fn devices(&self) -> Result<Vec<HostInfo>, String> { self.ask(Cmd::Devices)? }
    pub fn start(&self, cfg: StartCfg) -> Result<StartInfo, String> { self.ask(|tx| Cmd::Start(cfg, tx))? }
    pub fn stop(&self) -> Result<(), String> { self.ask(Cmd::Stop) }
    pub fn take_start(&self, cfg: TakeCfg) -> Result<(), String> { self.ask(|tx| Cmd::TakeStart(cfg, tx))? }
    pub fn take_result(&self) -> Result<TakeResult, String> { self.ask(Cmd::TakeResult)? }
    pub fn take_cancel(&self) -> Result<(), String> { self.ask(Cmd::TakeCancel) }

    pub fn set_params(&self, p: Params) {
        if let Some(tx) = self.params_tx.lock().unwrap().as_ref() {
            let _ = tx.send(p.clone());
        }
        *self.last.lock().unwrap() = p;
    }

    pub fn poll(&self) -> Poll {
        let take = |a: &AtomicU32| f32::from_bits(a.swap(0, Ordering::Relaxed));
        Poll {
            running: *self.running.lock().unwrap(),
            in_peak: take(&self.shared.in_peak),
            out_peak: take(&self.shared.out_peak),
            frames: self.shared.frames.load(Ordering::Relaxed),
            sample_rate: self.shared.sample_rate.load(Ordering::Relaxed),
            error: self.shared.error.lock().unwrap().take(),
            take: self.shared.take_state.load(Ordering::Relaxed),
            take_pos: {
                let sr = self.shared.sample_rate.load(Ordering::Relaxed).max(1) as f32;
                let start = self.shared.take_start_out.load(Ordering::Relaxed);
                let now = self.shared.out_frame.load(Ordering::Relaxed);
                now.saturating_sub(start) as f32 / sr
            },
        }
    }
}

type RecCons = ringbuf::HeapCons<f32>;

struct Live {
    _streams: Streams,
    take_tx: Sender<TakePlan>,
    rec: RecCons,
}

fn control_thread(
    rx: Receiver<Cmd>,
    shared: Arc<Shared>,
    params_tx: Arc<Mutex<Option<Sender<Params>>>>,
    last: Arc<Mutex<Params>>,
    running: Arc<Mutex<bool>>,
) {
    let mut live: Option<Live> = None;
    let mut recorded: Vec<f32> = Vec::new();
    loop {
        // 录音期间每 15ms 把环形缓冲里的数据搬到内存
        let cmd = match rx.recv_timeout(Duration::from_millis(15)) {
            Ok(c) => Some(c),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if let Some(l) = live.as_mut() {
            drain(&mut l.rec, &mut recorded);
        }
        let Some(cmd) = cmd else { continue };
        match cmd {
            Cmd::Devices(reply) => {
                let _ = reply.send(list_devices());
            }
            Cmd::Start(cfg, reply) => {
                live = None; // 先关掉旧的（ASIO 同一时间只能加载一个驱动）
                shared.take_state.store(0, Ordering::Relaxed);
                shared.rec_on.store(false, Ordering::Relaxed);
                let (ptx, prx) = channel();
                let initial = last.lock().unwrap().clone();
                match open(&cfg, prx, initial, shared.clone()) {
                    Ok((streams, take_tx, rec, info)) => {
                        *params_tx.lock().unwrap() = Some(ptx);
                        *running.lock().unwrap() = true;
                        live = Some(Live { _streams: streams, take_tx, rec });
                        let _ = reply.send(Ok(info));
                    }
                    Err(e) => {
                        *running.lock().unwrap() = false;
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Cmd::Stop(reply) => {
                live = None;
                shared.take_state.store(0, Ordering::Relaxed);
                *params_tx.lock().unwrap() = None;
                *running.lock().unwrap() = false;
                let _ = reply.send(());
            }
            Cmd::TakeStart(cfg, reply) => {
                let Some(l) = live.as_mut() else {
                    let _ = reply.send(Err("请先开启效果器（音频引擎）".into()));
                    continue;
                };
                let sr = shared.sample_rate.load(Ordering::Relaxed) as f64;
                let mut clicks: Vec<(u64, bool)> = cfg.clicks.iter().zip(cfg.accents.iter().chain(std::iter::repeat(&false)))
                    .map(|(&t, &a)| ((t * sr).round() as u64, a))
                    .collect();
                clicks.sort_by_key(|c| c.0);
                drain(&mut l.rec, &mut Vec::new());
                recorded.clear();
                recorded.reserve((cfg.length * sr) as usize + sr as usize);
                shared.take_cancel.store(false, Ordering::Relaxed);
                shared.take_state.store(1, Ordering::Relaxed);
                let plan = TakePlan { clicks, end: (cfg.length * sr) as u64, gain: cfg.click_gain.clamp(0.0, 1.0) };
                let _ = reply.send(l.take_tx.send(plan).map_err(|e| e.to_string()));
            }
            Cmd::TakeResult(reply) => {
                if shared.take_state.load(Ordering::Relaxed) != 2 {
                    let _ = reply.send(Err("测评还没有结束".into()));
                    continue;
                }
                if let Some(l) = live.as_mut() {
                    std::thread::sleep(Duration::from_millis(30));
                    drain(&mut l.rec, &mut recorded);
                }
                shared.take_state.store(0, Ordering::Relaxed);
                let _ = reply.send(Ok(take_result(&recorded, &shared)));
            }
            Cmd::TakeCancel(reply) => {
                shared.take_cancel.store(true, Ordering::Relaxed);
                shared.rec_on.store(false, Ordering::Relaxed);
                shared.take_state.store(0, Ordering::Relaxed);
                let _ = reply.send(());
            }
        }
    }
}

fn drain(rec: &mut RecCons, out: &mut Vec<f32>) {
    let mut buf = [0f32; 4096];
    loop {
        let n = rec.pop_slice(&mut buf);
        if n == 0 {
            break;
        }
        if out.len() < 48_000 * 600 {
            out.extend_from_slice(&buf[..n]);
        }
    }
}

/// 把录音里的事件时间换算成「计划起点」坐标：
/// 你听到第 k 个节拍时，它已经在输出端走了 out_lat；你弹出的声音又要经过 in_lat 才进到录音里。
fn take_result(recorded: &[f32], shared: &Shared) -> TakeResult {
    let sr = shared.sample_rate.load(Ordering::Relaxed) as f32;
    let start = shared.take_start_out.load(Ordering::Relaxed) as i64;
    let io_off = shared.io_off.load(Ordering::Relaxed);
    let in_lat = shared.in_lat.load(Ordering::Relaxed) as i64;
    let out_lat = shared.out_lat.load(Ordering::Relaxed) as i64;
    let rec_start = shared.rec_start_in.load(Ordering::Relaxed) as i64;
    let base = start + io_off + out_lat + in_lat - rec_start;
    let mut events = crate::analysis::analyze(recorded, sr);
    for e in &mut events {
        e.t -= base as f32 / sr;
    }
    TakeResult {
        events,
        sample_rate: sr as u32,
        latency_ms: (in_lat + out_lat) as f32 / sr * 1000.0,
        seconds: recorded.len() as f32 / sr,
    }
}
fn dev_name(d: &cpal::Device) -> String {
    d.description().map(|d| d.name().to_string()).unwrap_or_else(|_| "未知设备".into())
}

fn list_devices() -> Result<Vec<HostInfo>, String> {
    let mut out = vec![];
    for id in cpal::available_hosts() {
        let Ok(host) = cpal::host_from_id(id) else { continue };
        out.push(HostInfo {
            id: id.name().to_string(),
            inputs: host.input_devices().map(|it| it.map(|d| dev_name(&d)).collect()).unwrap_or_default(),
            outputs: host.output_devices().map(|it| it.map(|d| dev_name(&d)).collect()).unwrap_or_default(),
            default_input: host.default_input_device().map(|d| dev_name(&d)),
            default_output: host.default_output_device().map(|d| dev_name(&d)),
        });
    }
    Ok(out)
}

fn find(devs: impl Iterator<Item = cpal::Device>, name: &str) -> Option<cpal::Device> {
    let devs: Vec<_> = devs.collect();
    let pos = devs.iter().position(|d| dev_name(d) == name);
    pos.map(|i| devs.into_iter().nth(i).unwrap())
}

type Streams = (cpal::Stream, cpal::Stream);

fn open(cfg: &StartCfg, prx: Receiver<Params>, initial: Params, shared: Arc<Shared>) -> Result<(Streams, Sender<TakePlan>, RecCons, StartInfo), String> {
    let id = cpal::available_hosts()
        .into_iter()
        .find(|h| h.name() == cfg.host)
        .ok_or_else(|| format!("找不到音频驱动类型 {}", cfg.host))?;
    let host = cpal::host_from_id(id).map_err(|e| e.to_string())?;

    let input = if cfg.input.is_empty() { host.default_input_device() } else {
        find(host.input_devices().map_err(|e| e.to_string())?, &cfg.input)
    }.ok_or("找不到输入设备，请检查声卡连接")?;
    let output = if cfg.output.is_empty() { host.default_output_device() } else {
        find(host.output_devices().map_err(|e| e.to_string())?, &cfg.output)
    }.ok_or("找不到输出设备")?;

    let in_sup = input.default_input_config().map_err(|e| format!("输入设备不可用：{e}"))?;
    let out_sup = output.default_output_config().map_err(|e| format!("输出设备不可用：{e}"))?;
    let sr = in_sup.sample_rate();
    if out_sup.sample_rate() != sr && cfg.host != "ASIO" {
        return Err(format!(
            "输入 {} Hz 与输出 {} Hz 采样率不同，请在 Windows 声音设置里把两个设备设成一样，或改用 ASIO",
            sr, out_sup.sample_rate()
        ));
    }

    let (bmin, bmax) = match in_sup.buffer_size() {
        SupportedBufferSize::Range { min, max } => (*min, *max),
        SupportedBufferSize::Unknown => (0, 0),
    };
    let buffer_size = if cfg.buffer > 0 && (bmax == 0 || (cfg.buffer >= bmin && cfg.buffer <= bmax)) {
        BufferSize::Fixed(cfg.buffer)
    } else {
        BufferSize::Default
    };

    let in_ch = in_sup.channels();
    let out_ch = out_sup.channels();
    let in_cfg = StreamConfig { channels: in_ch, sample_rate: sr, buffer_size };
    let out_cfg = StreamConfig { channels: out_ch, sample_rate: sr, buffer_size };

    let rb = HeapRb::<f32>::new(sr as usize / 2);
    let (prod, cons) = rb.split();
    // 测评录音：干声另走一条环形缓冲，由控制线程搬运到内存
    let (rec_prod, rec_cons) = HeapRb::<f32>::new(sr as usize * 4).split();
    let (take_tx, take_rx) = channel::<TakePlan>();
    shared.in_frame.store(0, Ordering::Relaxed);
    shared.out_frame.store(0, Ordering::Relaxed);

    shared.sample_rate.store(sr, Ordering::Relaxed);
    *shared.error.lock().unwrap() = None;

    let channel = cfg.channel;
    let in_stream = match in_sup.sample_format() {
        SampleFormat::F32 => build_input::<f32>(&input, &in_cfg, prod, rec_prod, channel, shared.clone()),
        SampleFormat::I32 => build_input::<i32>(&input, &in_cfg, prod, rec_prod, channel, shared.clone()),
        SampleFormat::I16 => build_input::<i16>(&input, &in_cfg, prod, rec_prod, channel, shared.clone()),
        f => return Err(format!("不支持的输入采样格式 {f:?}")),
    }?;

    let mut chain = Chain::new(sr as f32);
    chain.set(&initial);
    let out_stream = match out_sup.sample_format() {
        SampleFormat::F32 => build_output::<f32>(&output, &out_cfg, cons, chain, prx, take_rx, shared.clone()),
        SampleFormat::I32 => build_output::<i32>(&output, &out_cfg, cons, chain, prx, take_rx, shared.clone()),
        SampleFormat::I16 => build_output::<i16>(&output, &out_cfg, cons, chain, prx, take_rx, shared.clone()),
        f => return Err(format!("不支持的输出采样格式 {f:?}")),
    }?;

    in_stream.play().map_err(|e| e.to_string())?;
    out_stream.play().map_err(|e| e.to_string())?;

    Ok(((in_stream, out_stream), take_tx, rec_cons, StartInfo { sample_rate: sr, in_channels: in_ch, buffer_min: bmin, buffer_max: bmax }))
}

fn err_cb(shared: Arc<Shared>) -> impl FnMut(cpal::Error) + Send + 'static {
    move |e| { *shared.error.lock().unwrap() = Some(e.to_string()); }
}

#[inline]
fn store_peak(a: &AtomicU32, v: f32) {
    // 正浮点数的位模式单调递增，可以直接用整数 max
    a.fetch_max(v.to_bits(), Ordering::Relaxed);
}

/// 把非规格化浮点数当 0 处理，避免混响尾巴衰减时 CPU 飙升
#[inline]
fn flush_denormals() {
    #[cfg(target_arch = "x86_64")]
    #[allow(deprecated)]
    unsafe {
        use std::arch::x86_64::{_mm_getcsr, _mm_setcsr};
        _mm_setcsr(_mm_getcsr() | 0x8040);
    }
}

fn build_input<T>(
    dev: &cpal::Device,
    cfg: &StreamConfig,
    mut prod: impl Producer<Item = f32> + Send + 'static,
    mut rec: impl Producer<Item = f32> + Send + 'static,
    channel: i32,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let ch = cfg.channels as usize;
    let pick = if channel < 0 { usize::MAX } else { (channel as usize).min(ch - 1) };
    let sh = shared.clone();
    let mut recording = false;
    dev.build_input_stream::<T, _, _>(
        cfg.clone(),
        move |data: &[T], info| {
            let ts = info.timestamp();
            if let Some(d) = ts.callback.checked_duration_since(ts.capture) {
                let sr = sh.sample_rate.load(Ordering::Relaxed) as f64;
                sh.in_lat.store((d.as_secs_f64() * sr) as u32, Ordering::Relaxed);
            }
            let frame0 = sh.in_frame.load(Ordering::Relaxed);
            let rec_on = sh.rec_on.load(Ordering::Relaxed);
            if rec_on && !recording {
                sh.rec_start_in.store(frame0, Ordering::Relaxed);
            }
            recording = rec_on;
            for frame in data.chunks_exact(ch) {
                let x = if pick == usize::MAX {
                    let n = ch.min(2);
                    frame[..n].iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / n as f32
                } else {
                    frame[pick].to_sample::<f32>()
                };
                let _ = prod.try_push(x);
                if recording {
                    let _ = rec.try_push(x);
                }
            }
            sh.in_frame.store(frame0 + (data.len() / ch) as u64, Ordering::Relaxed);
        },
        err_cb(shared),
        None,
    )
    .map_err(|e| format!("无法打开输入：{e}"))
}

fn build_output<T>(
    dev: &cpal::Device,
    cfg: &StreamConfig,
    mut cons: impl Consumer<Item = f32> + Observer + Send + 'static,
    mut chain: Chain,
    prx: Receiver<Params>,
    take_rx: Receiver<TakePlan>,
    shared: Arc<Shared>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let ch = cfg.channels as usize;
    let meters = shared.clone();
    let sr = cfg.sample_rate as f32;
    // 节拍声：短促的正弦，重拍高一些
    let click = |hz: f32| -> Vec<f32> {
        (0..(0.03 * sr) as usize).map(|i| {
            let t = i as f32 / sr;
            (2.0 * std::f32::consts::PI * hz * t).sin() * (-t * 120.0).exp() * (1.0 - (-t * 3000.0).exp())
        }).collect()
    };
    let (click_hi, click_lo) = (click(1760.0), click(1175.0));
    let mut take: Option<(TakePlan, u64, usize)> = None; // (计划, 起点帧, 下一个节拍序号)
    let mut voice: Option<(bool, usize, f32)> = None; // (重拍, 播放位置, 音量)
    dev.build_output_stream::<T, _, _>(
        cfg.clone(),
        move |data: &mut [T], info| {
            flush_denormals();
            while let Ok(p) = prx.try_recv() {
                chain.set(&p);
            }
            let frames = data.len() / ch;
            meters.frames.store(frames as u32, Ordering::Relaxed);
            let ts = info.timestamp();
            if let Some(d) = ts.playback.checked_duration_since(ts.callback) {
                meters.out_lat.store((d.as_secs_f64() * sr as f64) as u32, Ordering::Relaxed);
            }
            let frame0 = meters.out_frame.load(Ordering::Relaxed);
            if let Ok(plan) = take_rx.try_recv() {
                // 留 0.1 秒余量，保证第一个节拍不会被截掉
                let start = frame0 + (0.1 * sr) as u64;
                let in_now = meters.in_frame.load(Ordering::Relaxed) as i64;
                meters.io_off.store(in_now - frame0 as i64, Ordering::Relaxed);
                meters.take_start_out.store(start, Ordering::Relaxed);
                meters.rec_on.store(true, Ordering::Relaxed);
                take = Some((plan, start, 0));
            }
            if meters.take_cancel.swap(false, Ordering::Relaxed) {
                take = None;
                voice = None;
            }
            // 输入比输出跑得快时丢掉积压，防止延迟越攒越大
            let queued = cons.occupied_len();
            if queued > frames * 3 {
                cons.skip(queued - frames);
            }
            let (mut pin, mut pout) = (0f32, 0f32);
            for (j, frame) in data.chunks_exact_mut(ch).enumerate() {
                let x = cons.try_pop().unwrap_or(0.0);
                let (lvl, mut l, mut r) = chain.run(x);
                if let Some((plan, start, next)) = take.as_mut() {
                    let f = frame0 + j as u64;
                    if *next < plan.clicks.len() && f >= *start + plan.clicks[*next].0 {
                        voice = Some((plan.clicks[*next].1, 0, plan.gain));
                        *next += 1;
                    }
                    if f >= *start + plan.end {
                        meters.rec_on.store(false, Ordering::Relaxed);
                        meters.take_state.store(2, Ordering::Relaxed);
                        take = None;
                    }
                }
                if let Some((accent, pos, gain)) = voice.as_mut() {
                    let w = if *accent { &click_hi } else { &click_lo };
                    let v = w[*pos] * *gain * if *accent { 0.9 } else { 0.6 };
                    l += v;
                    r += v;
                    *pos += 1;
                    if *pos >= w.len() {
                        voice = None;
                    }
                }
                pin = pin.max(lvl.abs());
                pout = pout.max(l.abs().max(r.abs()));
                frame[0] = T::from_sample(l);
                if ch > 1 {
                    frame[1] = T::from_sample(r);
                }
                for s in frame.iter_mut().skip(2) {
                    *s = T::EQUILIBRIUM;
                }
            }
            store_peak(&meters.in_peak, pin);
            store_peak(&meters.out_peak, pout);
            meters.out_frame.store(frame0 + frames as u64, Ordering::Relaxed);
        },
        err_cb(shared),
        None,
    )
    .map_err(|e| format!("无法打开输出：{e}"))
}
