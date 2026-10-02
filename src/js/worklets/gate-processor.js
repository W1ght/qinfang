// 噪声门：峰值包络检测 + 迟滞 + 保持时间，开关门时平滑过渡避免咔哒声。
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -60, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 120, minValue: 5, maxValue: 2000, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.env = 0;
    this.gain = 0;
    this.hold = 0;
    this.open = false;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input.length) return true;

    const openLin = Math.pow(10, params.threshold[0] / 20);
    const closeLin = openLin * 0.5;                       // 6 dB 迟滞，避免尾音附近抖动
    const envDecay = Math.exp(-1 / (0.01 * sampleRate)); // 10ms 包络释放
    const attack = 1 - Math.exp(-1 / (0.001 * sampleRate));
    const release = 1 - Math.exp(-1 / ((params.release[0] / 1000) * sampleRate));
    const holdSamples = 0.05 * sampleRate;

    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) peak = Math.max(peak, Math.abs(input[c][i]));
      this.env = Math.max(peak, this.env * envDecay);

      if (this.env > openLin) { this.open = true; this.hold = holdSamples; }
      else if (this.env < closeLin) {
        if (this.hold > 0) this.hold--;
        else this.open = false;
      }
      const target = this.open ? 1 : 0;
      this.gain += (target - this.gain) * (this.open ? attack : release);

      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] || input[0])[i] * this.gain;
    }
    return true;
  }
}

registerProcessor('noise-gate', GateProcessor);
