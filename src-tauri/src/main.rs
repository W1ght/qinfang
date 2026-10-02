// 发布版不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analysis;
mod audio;
mod dsp;

use audio::{Audio, HostInfo, Poll, StartCfg, StartInfo, TakeCfg, TakeResult};
use dsp::Params;
use tauri::State;

#[tauri::command]
async fn audio_devices(audio: State<'_, Audio>) -> Result<Vec<HostInfo>, String> {
    audio.devices()
}

#[tauri::command]
async fn fx_start(audio: State<'_, Audio>, cfg: StartCfg) -> Result<StartInfo, String> {
    audio.start(cfg)
}

#[tauri::command]
async fn fx_stop(audio: State<'_, Audio>) -> Result<(), String> {
    audio.stop()
}

#[tauri::command]
fn fx_params(audio: State<'_, Audio>, params: Params) {
    audio.set_params(params);
}

#[tauri::command]
async fn take_start(audio: State<'_, Audio>, cfg: TakeCfg) -> Result<(), String> {
    audio.take_start(cfg)
}

#[tauri::command]
async fn take_result(audio: State<'_, Audio>) -> Result<TakeResult, String> {
    audio.take_result()
}

#[tauri::command]
async fn take_cancel(audio: State<'_, Audio>) -> Result<(), String> {
    audio.take_cancel()
}

#[tauri::command]
fn fx_poll(audio: State<'_, Audio>) -> Poll {
    audio.poll()
}

fn main() {
    tauri::Builder::default()
        .manage(Audio::new())
        .invoke_handler(tauri::generate_handler![audio_devices, fx_start, fx_stop, fx_params, fx_poll, take_start, take_result, take_cancel])
        .run(tauri::generate_context!())
        .expect("启动琴房失败");
}
