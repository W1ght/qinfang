// 看谱：Guitar Pro / MusicXML / alphaTex 用 alphaTab 渲染并可播放；PDF 用 pdf.js；另支持图片与文本谱。
import { $, toast, load, save, clamp, loadAlphaTab, alphaTabSettings } from './util.js';

const AT_EXT = ['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'musicxml', 'xml', 'mxl'];
const TEX_EXT = ['tex', 'atex'];
const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const TXT_EXT = ['txt', 'tab', 'crd'];

const DEMO_TEX = `\\title "示例练习"
\\subtitle "C 大调音阶与和弦"
\\tempo 90
.
\\track "Guitar"
\\staff {score tabs}
\\ts 4 4
3.5.8 0.4.8 2.4.8 3.4.8 0.3.8 2.3.8 0.2.8 1.2.8 |
3.2.8 1.2.8 0.2.8 2.3.8 0.3.8 3.4.8 2.4.8 0.4.8 |
(0.1 1.2 0.3 2.4 3.5).2 (0.1 1.2 0.3 2.4 3.5).2 |
(3.1 3.2 0.3 0.4 2.5 3.6).2 (3.1 3.2 0.3 0.4 2.5 3.6).2 |
(0.1 1.2 2.3 2.4 0.5).2 (0.1 1.2 2.3 2.4 0.5).2 |
(1.1 1.2 2.3 3.4 3.5 1.6).2 (1.1 1.2 2.3 3.4 3.5 1.6).2 |
(0.1 1.2 0.3 2.4 3.5).1`;

export function initSheet() {
  const view = $('sheetView');
  const content = $('sheetContent');
  const empty = $('sheetEmpty');
  const prefs = load('sheet', { zoom: 1, speed: 30, night: false });

  let kind = null;        // 'at' | 'pdf' | 'img' | 'txt'
  let api = null;         // alphaTab
  let pdfDoc = null;
  let renderToken = 0;

  // ---------------- 打开文件
  $('openFile').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) openFile(f);
    e.target.value = '';
  });
  $('loadDemo').addEventListener('click', () => openTex(DEMO_TEX, '示例练习'));

  view.addEventListener('dragover', (e) => { e.preventDefault(); view.classList.add('dragover'); });
  view.addEventListener('dragleave', () => view.classList.remove('dragover'));
  view.addEventListener('drop', (e) => {
    e.preventDefault();
    view.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });

  async function openFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    try {
      if (AT_EXT.includes(ext)) await openAlphaTab(new Uint8Array(await file.arrayBuffer()), file.name);
      else if (TEX_EXT.includes(ext)) await openTex(await file.text(), file.name);
      else if (ext === 'pdf') await openPdf(await file.arrayBuffer(), file.name);
      else if (IMG_EXT.includes(ext)) openImage(file);
      else if (TXT_EXT.includes(ext)) openText(await file.text(), file.name);
      else toast(`不支持的格式：.${ext}`, true);
    } catch (err) {
      console.error(err);
      toast(`打开失败：${err.message || err}`, true);
    }
  }

  function reset(title, newKind) {
    stopAutoScroll();
    destroyAlphaTab();
    pdfDoc?.destroy();
    pdfDoc = null;
    content.innerHTML = '';
    empty.hidden = true;
    kind = newKind;
    $('sheetTitle').textContent = title;
    $('sheetTitle').title = title;
    $('gpTools').hidden = newKind !== 'at';
    view.scrollTop = 0;
  }

  // ---------------- alphaTab
  async function createAlphaTab(title) {
    reset(title, 'at');
    content.innerHTML = '<div class="loading">正在渲染谱子…</div>';
    await loadAlphaTab();
    content.innerHTML = '';
    const host = document.createElement('div');
    host.className = 'at-host';
    content.appendChild(host);
    api = new window.alphaTab.AlphaTabApi(host, alphaTabSettings(view, prefs.zoom));
    const status = $('gpStatus');
    status.textContent = '加载音色中…';
    $('gpPlay').disabled = true;
    $('gpStop').disabled = true;
    api.scoreLoaded.on((score) => {
      const sel = $('trackSel');
      sel.innerHTML = '';
      score.tracks.forEach((t, i) => sel.add(new Option(`${i + 1}. ${t.name || '音轨'}`, String(i))));
      const titleText = [score.title, score.artist].filter(Boolean).join(' - ');
      if (titleText) { $('sheetTitle').textContent = titleText; $('sheetTitle').title = titleText; }
    });
    api.playerReady.on(() => {
      status.textContent = '';
      $('gpPlay').disabled = false;
      $('gpStop').disabled = false;
    });
    api.playerStateChanged.on((e) => {
      $('gpPlay').textContent = e.state === 1 ? '暂停' : '播放';
      $('gpPlay').classList.toggle('active', e.state === 1);
    });
    api.error.on((e) => toast(`谱子解析失败：${e?.message || e}`, true));
    applyGpOptions();
    return api;
  }

  async function openAlphaTab(bytes, name) {
    const a = await createAlphaTab(name);
    a.load(bytes);
  }

  async function openTex(tex, name) {
    const a = await createAlphaTab(name);
    a.tex(tex);
  }

  function destroyAlphaTab() {
    if (!api) return;
    try { api.destroy(); } catch { /* ignore */ }
    api = null;
  }

  function applyGpOptions() {
    if (!api) return;
    api.playbackSpeed = +$('gpSpeed').value;
    api.metronomeVolume = $('gpMetro').checked ? 1 : 0;
    api.countInVolume = $('gpCountIn').checked ? 1 : 0;
  }
  $('gpSpeed').addEventListener('change', applyGpOptions);
  $('gpMetro').addEventListener('change', applyGpOptions);
  $('gpCountIn').addEventListener('change', applyGpOptions);
  $('gpPlay').addEventListener('click', () => api?.playPause());
  $('gpStop').addEventListener('click', () => api?.stop());
  $('trackSel').addEventListener('change', (e) => {
    if (!api?.score) return;
    api.renderTracks([api.score.tracks[+e.target.value]]);
  });

  // ---------------- PDF
  let pdfjs = null;
  async function openPdf(buf, name) {
    reset(name, 'pdf');
    content.innerHTML = '<div class="loading">正在打开 PDF…</div>';
    if (!pdfjs) {
      pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    }
    const vendor = new URL('../vendor/pdfjs/', import.meta.url).href;
    pdfDoc = await pdfjs.getDocument({
      data: buf,
      cMapUrl: vendor + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: vendor + 'standard_fonts/',
      wasmUrl: vendor + 'wasm/',
    }).promise;
    await renderPdf();
  }

  async function renderPdf() {
    if (!pdfDoc) return;
    const token = ++renderToken;
    const keepRatio = view.scrollTop / Math.max(1, view.scrollHeight);
    const width = Math.max(300, (view.clientWidth - 60) * prefs.zoom);
    const dpr = window.devicePixelRatio || 1;
    const canvases = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      if (token !== renderToken) return;
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: width / base.width });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      c.style.width = `${Math.floor(vp.width)}px`;
      c.style.height = `${Math.floor(vp.height)}px`;
      canvases.push([page, c, vp]);
    }
    content.innerHTML = '';
    for (const [, c] of canvases) content.appendChild(c);
    view.scrollTop = keepRatio * view.scrollHeight;
    for (const [page, c, vp] of canvases) {
      if (token !== renderToken) return;
      await page.render({
        canvas: c,
        canvasContext: c.getContext('2d'),
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      }).promise;
    }
  }

  // ---------------- 图片 / 文本
  function openImage(file) {
    reset(file.name, 'img');
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    img.onload = applyZoom;
    content.appendChild(img);
  }

  function openText(text, name) {
    reset(name, 'txt');
    const pre = document.createElement('pre');
    pre.textContent = text;
    content.appendChild(pre);
    applyZoom();
  }

  // ---------------- 缩放
  function applyZoom() {
    $('zoomVal').textContent = `${Math.round(prefs.zoom * 100)}%`;
    save('sheet', prefs);
    if (kind === 'at' && api) {
      api.settings.display.scale = prefs.zoom;
      api.updateSettings();
      api.render();
    } else if (kind === 'pdf') {
      renderPdf();
    } else if (kind === 'img') {
      const img = content.querySelector('img');
      if (img) img.style.width = `${Math.round((view.clientWidth - 60) * prefs.zoom)}px`;
    } else if (kind === 'txt') {
      const pre = content.querySelector('pre');
      if (pre) pre.style.fontSize = `${15 * prefs.zoom}px`;
    }
  }
  const zoomBy = (d) => { prefs.zoom = clamp(Math.round((prefs.zoom + d) * 10) / 10, 0.5, 3); applyZoom(); };
  $('zoomIn').addEventListener('click', () => zoomBy(0.1));
  $('zoomOut').addEventListener('click', () => zoomBy(-0.1));
  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (kind === 'pdf' || kind === 'img') applyZoom(); }, 200);
  }).observe(view);

  // ---------------- 夜间谱面
  const nightBtn = $('nightBtn');
  const applyNight = () => {
    view.classList.toggle('night', prefs.night);
    nightBtn.classList.toggle('toggled', prefs.night);
  };
  nightBtn.addEventListener('click', () => { prefs.night = !prefs.night; save('sheet', prefs); applyNight(); });
  applyNight();

  // ---------------- 自动滚动
  const speedEl = $('scrollSpeed');
  speedEl.value = prefs.speed;
  speedEl.addEventListener('input', () => { prefs.speed = +speedEl.value; save('sheet', prefs); });
  let scrolling = false, lastT = 0, carry = 0;
  function step(t) {
    if (!scrolling) return;
    const dt = lastT ? (t - lastT) / 1000 : 0;
    lastT = t;
    carry += prefs.speed * dt;
    const whole = Math.floor(carry);
    if (whole >= 1) { view.scrollTop += whole; carry -= whole; }
    if (view.scrollTop + view.clientHeight >= view.scrollHeight - 1) { stopAutoScroll(); return; }
    requestAnimationFrame(step);
  }
  function startAutoScroll() {
    if (!kind) return toast('请先打开谱子');
    scrolling = true; lastT = 0; carry = 0;
    $('autoScrollBtn').classList.add('toggled');
    requestAnimationFrame(step);
  }
  function stopAutoScroll() {
    scrolling = false;
    $('autoScrollBtn').classList.remove('toggled');
  }
  const toggleAutoScroll = () => (scrolling ? stopAutoScroll() : startAutoScroll());
  $('autoScrollBtn').addEventListener('click', toggleAutoScroll);

  // ---------------- 翻页
  function page(dir) {
    view.scrollBy({ top: dir * view.clientHeight * 0.85, behavior: 'smooth' });
  }

  $('zoomVal').textContent = `${Math.round(prefs.zoom * 100)}%`;

  return {
    handleKey(e) {
      switch (e.key) {
        case 'PageDown': case 'ArrowRight': case 'ArrowDown': page(1); return true;
        case 'PageUp': case 'ArrowLeft': case 'ArrowUp': page(-1); return true;
        case 'Home': view.scrollTo({ top: 0, behavior: 'smooth' }); return true;
        case 'End': view.scrollTo({ top: view.scrollHeight, behavior: 'smooth' }); return true;
        case 's': case 'S': toggleAutoScroll(); return true;
        case '=': case '+': if (e.ctrlKey) { zoomBy(0.1); return true; } return false;
        case '-': if (e.ctrlKey) { zoomBy(-0.1); return true; } return false;
        default: return false;
      }
    },
  };
}
