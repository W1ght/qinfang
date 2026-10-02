// 列出所有音频主机与设备，用于排查声卡/驱动问题：cargo run --example probe
use cpal::traits::{DeviceTrait, HostTrait};

fn main() {
    for id in cpal::available_hosts() {
        println!("== {}", id.name());
        let host = match cpal::host_from_id(id) {
            Ok(h) => h,
            Err(e) => { println!("  无法打开: {e}"); continue; }
        };
        if let Ok(devs) = host.devices() {
            for d in devs {
                let name = d.description().map(|d| d.name().to_string()).unwrap_or_default();
                let i = d.default_input_config().map(|c| format!("{}ch {}Hz {:?} {:?}", c.channels(), c.sample_rate(), c.sample_format(), c.buffer_size())).unwrap_or_else(|e| format!("- ({e})"));
                let o = d.default_output_config().map(|c| format!("{}ch {}Hz {:?} {:?}", c.channels(), c.sample_rate(), c.sample_format(), c.buffer_size())).unwrap_or_else(|e| format!("- ({e})"));
                println!("  {name}\n     in : {i}\n     out: {o}");
            }
        }
    }
}
