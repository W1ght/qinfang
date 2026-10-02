import { Metronome, initMetronomeUI } from './metronome.js';
import { initSheet } from './sheet.js';
import { initEffects } from './effects.js';
import { initPractice } from './practice.js';
import { $, load, save } from './util.js';

const metro = new Metronome();
const metroUI = initMetronomeUI(metro);
const sheet = initSheet();
const fx = initEffects({
  getBpm: () => metro.state.bpm,
  onBpmChange: (fn) => metro.addEventListener('change', (e) => { if ('bpm' in e.detail) fn(); }),
});

// ---- 标签页
const tabs = [...document.querySelectorAll('.tab')];
let current = load('ui', { tab: 'practice' }).tab;
let practice = null;
initPractice({ fx, metro }).then((p) => { practice = p; });
function showTab(name) {
  current = name;
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', String(on));
    $(`tab-${t.dataset.tab}`).hidden = !on;
  }
  save('ui', { tab: name });
  if (name === 'sheet') $('sheetView').focus({ preventScroll: true });
}
tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
showTab(tabs.some((t) => t.dataset.tab === current) ? current : 'practice');

// ---- 快捷键
window.addEventListener('keydown', (e) => {
  const el = e.target;
  const typing = el.matches?.('input[type="text"], input[type="number"], textarea, select') || el.isContentEditable;
  if (typing || document.querySelector('dialog[open]')) return;

  // Ctrl+1~4 切换页面
  if (e.ctrlKey && ['1', '2', '3', '4'].includes(e.key)) {
    showTab(['practice', 'metronome', 'sheet', 'fx'][+e.key - 1]);
    e.preventDefault();
    return;
  }
  if (current === 'practice' && practice?.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if (e.code === 'Space') {
    if (practice?.isTaking()) return;
    metro.toggle();
    e.preventDefault();
    return;
  }
  // 滑杆获得焦点时方向键留给滑杆
  if (el.matches?.('input[type="range"]') && e.key.startsWith('Arrow')) return;

  if (current === 'sheet' && sheet.handleKey(e)) {
    e.preventDefault();
    return;
  }
  if (current === 'metronome') {
    const step = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { metroUI.nudge(step); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { metroUI.nudge(-step); e.preventDefault(); }
    else if (e.key === 't' || e.key === 'T') metroUI.tap();
  }
});

// 防止拖入文件时浏览器直接打开它
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
