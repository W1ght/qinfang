// 公共工具：共享 AudioContext、本地存储、提示。

let audioCtx = null;

/** 节拍器与效果器共用一个低延迟 AudioContext。 */
export function getAudioContext() {
  if (!audioCtx) audioCtx = new AudioContext({ latencyHint: 'interactive' });
  return audioCtx;
}

const PREFIX = 'qinfang.';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

export function loadRaw(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* 存储不可用时忽略 */ }
}

let toastTimer = 0;
export function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 4000 : 2200);
}

export const $ = (id) => document.getElementById(id);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const dbToGain = (db) => Math.pow(10, db / 20);

/** 弹出输入框，返回字符串或 null。 */
export function promptText(label, initial = '') {
  const dlg = $('promptDlg');
  $('promptText').textContent = label;
  const input = $('promptInput');
  input.value = initial;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null);
    }, { once: true });
    dlg.returnValue = '';
    dlg.showModal();
    input.select();
  });
}

let atLoading = null;
/** 按需加载 alphaTab（1MB 多，启动时不加载） */
export function loadAlphaTab() {
  if (window.alphaTab) return Promise.resolve(window.alphaTab);
  atLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/alphatab/alphaTab.min.js';
    s.onload = () => resolve(window.alphaTab);
    s.onerror = () => reject(new Error('alphaTab 加载失败'));
    document.head.appendChild(s);
  });
  return atLoading;
}

/** 两个页面共用的 alphaTab 基础设置 */
export function alphaTabSettings(scrollElement, scale = 1) {
  const base = new URL('vendor/alphatab/', location.href).href;
  return {
    core: { fontDirectory: base + 'font/', scriptFile: base + 'alphaTab.min.js' },
    display: { scale, layoutMode: 'page' },
    player: {
      enablePlayer: true,
      enableCursor: true,
      enableUserInteraction: true,
      soundFont: base + 'soundfont/sonivox.sf2',
      scrollElement,
      scrollOffsetY: -60,
    },
  };
}
