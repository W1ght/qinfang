// 练习页：基本功曲库、自适应练琴路线、演奏测评。
import { $, toast, loadRaw, save, clamp, loadAlphaTab, alphaTabSettings } from './util.js';
import {
  LEVELS, PASS, recommendBpm, mastery, addRecord, categoryMastery, checkLevelUp, levelProgress, buildPlan,
  align, scoreTake, feedback, calibrationOffset,
} from './practice-core.js';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

export async function initPractice({ fx, metro }) {
  const state = loadRaw('practice', { level: 0, records: {}, plan: null, calib: null, current: null, openCat: null });
  state.records ??= {};
  const persist = () => save('practice', state);

  let lib;
  try {
    lib = await (await fetch('library/index.json')).json();
  } catch (e) {
    toast('练习曲库加载失败', true);
    return;
  }
  const EX = lib.exercises;
  const exById = Object.fromEntries(EX.map((e) => [e.id, e]));
  const catById = Object.fromEntries(lib.categories.map((c) => [c.id, c]));

  // ---------------------------------------------------------------- 等级与计划
  function ensurePlan() {
    if (state.level && (!state.plan || state.plan.date !== today() || state.plan.level !== state.level)) {
      state.plan = { date: today(), level: state.level, items: buildPlan(EX, state.records, state.level, lib.categories) };
      persist();
    }
  }

  function renderLevel() {
    const lv = state.level || 1;
    $('lvBadge').textContent = `Lv.${lv}`;
    $('lvName').textContent = LEVELS[lv];
    if (lv >= 5) {
      $('lvProgress').textContent = '最高等级，继续把速度推上去';
      $('lvBar').style.width = '100%';
    } else {
      const { ok, need } = levelProgress(EX, state.records, lv);
      $('lvProgress').textContent = `本级达标 ${ok}/${need} 条即可升级`;
      $('lvBar').style.width = `${(ok / need) * 100}%`;
    }
  }

  function renderPlan() {
    const list = $('planList');
    list.innerHTML = '';
    $('planDate').textContent = state.plan?.date?.slice(5).replace('-', '/') ?? '';
    for (const item of state.plan?.items ?? []) {
      const ex = exById[item.id];
      if (!ex) continue;
      const li = document.createElement('li');
      li.className = `plan-item${item.done ? ' done' : ''}${state.current === ex.id ? ' current' : ''}`;
      li.innerHTML = `<span class="plan-check">${item.done ? '✓' : ''}</span>
        <span class="plan-title">${ex.title}<small>${item.role} · ${item.bpm} BPM</small></span>
        <span class="plan-score">${item.score != null ? `${item.score} 分` : ''}</span>`;
      li.addEventListener('click', () => select(ex.id));
      list.appendChild(li);
    }
  }

  function renderCats() {
    const box = $('catList');
    box.innerHTML = '';
    const lv = state.level || 1;
    for (const c of lib.categories) {
      const m = categoryMastery(EX, state.records, c.id, 5) ?? 0;
      const row = document.createElement('div');
      row.className = `cat-row${state.openCat === c.id ? ' open' : ''}`;
      row.innerHTML = `<button class="cat-btn" title="${c.desc}">
          <span class="cat-name">${c.name}</span><span class="cat-pct">${Math.round(m * 100)}%</span>
          <span class="progress"><span class="progress-fill" style="width:${m * 100}%;display:block"></span></span>
        </button><div class="ex-items"></div>`;
      row.querySelector('.cat-btn').addEventListener('click', () => {
        state.openCat = state.openCat === c.id ? null : c.id;
        persist();
        renderCats();
      });
      const items = row.querySelector('.ex-items');
      for (const ex of EX.filter((e) => e.cat === c.id).sort((a, b) => a.level - b.level)) {
        const r = state.records[ex.id];
        const b = document.createElement('button');
        b.className = `ex-item${state.current === ex.id ? ' current' : ''}${ex.level > lv + 1 ? ' locked' : ''}`;
        b.innerHTML = `<span>${ex.title}</span><span class="stars">${stars(ex.level)}</span>
          <span class="ex-sub">${r?.best ? `达标 ${r.best}` : '未达标'} / 目标 ${ex.goal} BPM</span>`;
        if (ex.level > lv + 1) b.title = '难度高于你当前等级两级以上，建议先练基础';
        b.addEventListener('click', () => select(ex.id));
        items.appendChild(b);
      }
      box.appendChild(row);
    }
  }

  const renderSide = () => { renderLevel(); renderPlan(); renderCats(); };

  // 等级选择
  const levelDlg = $('levelDlg');
  levelDlg.addEventListener('close', () => {
    const v = +levelDlg.returnValue;
    if (v >= 1 && v <= 5) {
      state.level = v;
      state.plan = null;
      ensurePlan();
      persist();
      renderSide();
      if (!state.current) select(state.plan.items[0].id);
    } else if (!state.level) {
      state.level = 1;
      ensurePlan();
      persist();
      renderSide();
    }
  });
  $('lvChange').addEventListener('click', () => levelDlg.showModal());

  // ---------------------------------------------------------------- 谱面
  let api = null;
  let scoreReady = null;
  let loadedId = null;

  async function ensureApi() {
    if (api) return api;
    await loadAlphaTab();
    const settings = alphaTabSettings($('tab-practice'), 0.95);
    settings.player.scrollOffsetY = -140;
    api = new window.alphaTab.AlphaTabApi($('exScore'), settings);
    api.playerStateChanged.on((e) => {
      if (!taking) $('exListen').textContent = e.state === 1 ? '停止试听' : '试听';
    });
    api.error.on((e) => toast(`谱子加载失败：${e?.message || e}`, true));
    return api;
  }

  async function loadScore(id) {
    if (loadedId === id && api?.score) return api.score;
    const a = await ensureApi();
    const buf = await (await fetch(`library/${id}.gp`)).arrayBuffer();
    scoreReady = new Promise((resolve) => {
      const h = (score) => { a.scoreLoaded.off(h); resolve(score); };
      a.scoreLoaded.on(h);
    });
    a.load(new Uint8Array(buf));
    loadedId = id;
    return scoreReady;
  }

  /** 从谱面里取出每个要弹的拍点 */
  function expectedFrom(score) {
    const mbars = score.masterBars;
    const events = [];
    for (const bar of score.tracks[0].staves[0].bars) {
      for (const beat of bar.voices[0].beats) {
        if (beat.isRest) continue;
        const notes = beat.notes.filter((n) => !n.isTieDestination);
        if (!notes.length) continue;
        const bendNote = notes.find((n) => n.hasBend && n.maxBendPoint);
        events.push({
          tq: beat.absolutePlaybackStart / 960,
          midis: notes.filter((n) => !n.isDead).map((n) => n.realValue),
          bend: bendNote ? bendNote.realValue + bendNote.maxBendPoint.value / 2 : null,
          legato: notes.some((n) => n.isHammerPullDestination),
          bar: bar.index,
          notes,
        });
      }
    }
    const lengthQ = mbars.reduce((s, mb) => s + mb.calculateDuration(), 0) / 960;
    return { events, lengthQ, num: mbars[0].timeSignatureNumerator, den: mbars[0].timeSignatureDenominator, bars: mbars.length };
  }

  // ---------------------------------------------------------------- 选择练习
  const bpmInput = $('exBpm');
  const curEx = () => exById[state.current];

  async function select(id) {
    if (taking) return;
    const ex = exById[id];
    if (!ex) return;
    state.current = id;
    state.openCat = ex.cat;
    persist();
    stopListen();
    const planItem = state.plan?.items.find((p) => p.id === id);
    const rec = recommendBpm(ex, state.records[id]);
    bpmInput.value = planItem && !planItem.done ? planItem.bpm : rec;
    $('exMeta').textContent = `${catById[ex.cat].name} · ${stars(ex.level)} · ${LEVELS[ex.level]}`;
    $('exTitle').textContent = ex.title;
    $('exTips').textContent = ex.tips;
    $('exRecommend').textContent = `推荐 ${rec} · 目标 ${ex.goal}`;
    renderBest();
    $('resultCard').hidden = true;
    renderSide();
    try {
      await loadScore(id);
    } catch (e) {
      toast(`谱子加载失败：${e.message || e}`, true);
    }
  }

  function renderBest() {
    const ex = curEx();
    const r = state.records[ex.id];
    const parts = [];
    if (r?.best) parts.push(`最高达标 ${r.best} BPM`);
    if (r?.history?.length) parts.push(`练过 ${r.history.length} 次`);
    if (r?.last) parts.push(`上次 ${r.last.bpm} BPM · ${r.last.score} 分`);
    parts.push(`掌握度 ${Math.round(mastery(ex, r) * 100)}%`);
    if (fx.native && state.calib == null) parts.push('建议先做一次「延迟校准」，节奏分析会更准');
    $('exBest').textContent = parts.join(' · ');
  }

  const setBpm = (v) => { bpmInput.value = clamp(Math.round(v), 30, 300); };
  $('exSlower').addEventListener('click', () => setBpm(+bpmInput.value - 2));
  $('exFaster').addEventListener('click', () => setBpm(+bpmInput.value + 2));
  bpmInput.addEventListener('change', () => setBpm(+bpmInput.value || 60));

  // ---------------------------------------------------------------- 试听
  async function toggleListen() {
    if (!curEx()) return;
    const a = await ensureApi();
    const score = await loadScore(state.current);
    if (a.playerState === 1) return stopListen();
    metro.stop();
    a.masterVolume = 1;
    a.metronomeVolume = 1;
    a.countInVolume = 1;
    a.isLooping = true;
    a.playbackSpeed = +bpmInput.value / score.tempo;
    a.play();
  }
  function stopListen() {
    if (api?.playerState === 1) api.stop();
  }
  $('exListen').addEventListener('click', toggleListen);

  // ---------------------------------------------------------------- 测评
  let taking = null; // { kind, plan, expected, bpm, T0, length, ... }

  if (!fx.native) {
    for (const id of ['exTake', 'exCalib']) {
      $(id).disabled = true;
      $(id).title = '测评需要桌面版（通过声卡 ASIO 录音分析）';
    }
  }

  function buildTake(info, bpm, reps) {
    const spq = 60 / bpm;
    const beatQ = 4 / info.den;
    const beatSec = beatQ * spq;
    const clicks = [], accents = [];
    for (let k = 0; k < info.num; k++) { clicks.push(k * beatSec); accents.push(k === 0); }
    const T0 = info.num * beatSec;
    const beatsPerRep = Math.round(info.lengthQ / beatQ);
    const expected = [];
    for (let r = 0; r < reps; r++) {
      const base = T0 + r * info.lengthQ * spq;
      for (let b = 0; b < beatsPerRep; b++) { clicks.push(base + b * beatSec); accents.push(b % info.num === 0); }
      info.events.forEach((e, i) => expected.push({ ...e, t: base + e.tq * spq, rep: r, i }));
    }
    return { clicks, accents, expected, T0, beatSec, num: info.num, length: T0 + reps * info.lengthQ * spq + 0.5 };
  }

  async function startTake(kind) {
    if (taking) return;
    const ex = curEx();
    if (kind === 'exercise' && !ex) return;
    stopListen();
    metro.stop();
    try {
      if (!(await fx.ensureRunning())) return;
    } catch {
      return;
    }
    let plan, bpm, mode, info = null;
    if (kind === 'calib') {
      bpm = 80;
      mode = 'timing';
      const events = Array.from({ length: 16 }, (_, i) => ({ tq: i, midis: [], bend: null, legato: false, bar: Math.floor(i / 4) }));
      info = { events, lengthQ: 16, num: 4, den: 4 };
      plan = buildTake(info, bpm, 1);
    } else {
      bpm = +bpmInput.value;
      mode = ex.mode;
      const score = await loadScore(ex.id);
      info = expectedFrom(score);
      plan = buildTake(info, bpm, +$('exReps').value);
    }
    try {
      await window.__TAURI__.core.invoke('take_start', {
        cfg: { clicks: plan.clicks, accents: plan.accents, length: plan.length, clickGain: 0.8 },
      });
    } catch (e) {
      toast(`无法开始测评：${e}`, true);
      return;
    }
    taking = { kind, plan, bpm, mode, ex, cursorStarted: false, reps: kind === 'calib' ? 1 : +$('exReps').value };
    $('takeOverlay').hidden = false;
    $('resultCard').hidden = true;
    $('exTake').disabled = true;
    if (kind === 'calib') {
      $('takeLabel').textContent = '校准：跟着节拍弹空弦';
    }
    requestAnimationFrame(watchTake);
  }

  async function watchTake() {
    if (!taking) return;
    const p = fx.lastPoll();
    const { plan } = taking;
    if (p && p.take !== 0 && p.takePos != null) {
      const pos = p.takePos;
      if (pos < plan.T0) {
        $('takeCount').textContent = Math.max(1, plan.num - Math.floor(pos / plan.beatSec));
        if (taking.kind !== 'calib') $('takeLabel').textContent = '预备';
        $('takeBar').style.width = '0%';
      } else {
        const prog = (pos - plan.T0) / (plan.length - 0.5 - plan.T0);
        const rep = Math.min(taking.reps, Math.floor(prog * taking.reps) + 1);
        $('takeCount').textContent = '●';
        if (taking.kind !== 'calib') $('takeLabel').textContent = taking.reps > 1 ? `第 ${rep}/${taking.reps} 遍` : '演奏中';
        $('takeBar').style.width = `${clamp(prog, 0, 1) * 100}%`;
        if (!taking.cursorStarted && taking.kind === 'exercise' && api?.isReadyForPlayback) {
          // 静音播放谱面，只为了让光标跟着走
          taking.cursorStarted = true;
          api.masterVolume = 0;
          api.metronomeVolume = 0;
          api.countInVolume = 0;
          api.isLooping = taking.reps > 1;
          api.playbackSpeed = taking.bpm / api.score.tempo;
          api.play();
        }
      }
    }
    if (p?.take === 2) return finishTake();
    requestAnimationFrame(watchTake);
  }

  async function finishTake() {
    const t = taking;
    let res;
    try {
      res = await window.__TAURI__.core.invoke('take_result');
    } catch (e) {
      toast(`分析失败：${e}`, true);
      return endTake();
    }
    endTake();
    const calib = t.kind === 'calib' ? 0 : (state.calib ?? 0);
    const det = res.events
      .map((e) => ({ ...e, t: e.t - calib / 1000 }))
      .filter((e) => e.t > t.plan.T0 - 0.3 && e.t < t.plan.length);
    const aligned = align(t.plan.expected, det, t.mode);

    if (t.kind === 'calib') {
      const off = calibrationOffset(aligned.notes);
      if (off == null) return toast('没听到足够的声音，请确认吉他有输入，再试一次', true);
      state.calib = off;
      persist();
      renderBest();
      return toast(`校准完成：固定延迟 ${off > 0 ? '+' : ''}${off} ms（之后的测评会自动扣除）`);
    }

    const s = scoreTake(aligned, t.mode);
    const ex = t.ex;
    state.records[ex.id] = addRecord(state.records[ex.id], { bpm: t.bpm, score: s.total, date: today() });
    const item = state.plan?.items.find((p) => p.id === ex.id);
    if (item) { item.done = true; item.score = Math.max(item.score ?? 0, s.total); }
    const next = recommendBpm(ex, state.records[ex.id]);
    const newLevel = checkLevelUp(EX, state.records, state.level || 1);
    if (newLevel > (state.level || 1)) {
      state.level = newLevel;
      toast(`升级了！现在是 Lv.${newLevel} ${LEVELS[newLevel]}，明天的计划会更有挑战`);
    }
    persist();
    showResult(s, aligned, t, next, res);
    colorScore(aligned.notes);
    renderSide();
    renderBest();
    $('exRecommend').textContent = `推荐 ${next} · 目标 ${ex.goal}`;
  }

  function endTake() {
    taking = null;
    $('takeOverlay').hidden = true;
    $('exTake').disabled = !fx.native;
    $('takeLabel').textContent = '预备';
    if (api) {
      api.stop();
      api.masterVolume = 1;
      api.isLooping = false;
    }
  }

  $('exTake').addEventListener('click', () => startTake('exercise'));
  $('exCalib').addEventListener('click', () => startTake('calib'));
  $('takeCancel').addEventListener('click', async () => {
    await window.__TAURI__?.core.invoke('take_cancel').catch(() => {});
    endTake();
  });

  // 不测评，自己确认
  $('exManual').addEventListener('click', () => {
    const ex = curEx();
    if (!ex) return;
    const bpm = +bpmInput.value;
    state.records[ex.id] = addRecord(state.records[ex.id], { bpm, score: PASS + 3, date: today() });
    const item = state.plan?.items.find((p) => p.id === ex.id);
    if (item) item.done = true;
    const lv = checkLevelUp(EX, state.records, state.level || 1);
    if (lv > (state.level || 1)) { state.level = lv; toast(`升级了！现在是 Lv.${lv} ${LEVELS[lv]}`); }
    persist();
    renderSide();
    renderBest();
    const next = recommendBpm(ex, state.records[ex.id]);
    $('exRecommend').textContent = `推荐 ${next} · 目标 ${ex.goal}`;
    toast(`已记录 ${bpm} BPM，下次建议 ${next} BPM`);
  });

  // ---------------------------------------------------------------- 结果
  function showResult(s, aligned, t, next, res) {
    $('resultCard').hidden = false;
    const ring = $('resScore');
    ring.textContent = s.total;
    ring.style.setProperty('--p', s.total);
    ring.style.setProperty('--ring', s.total >= PASS ? 'var(--ok)' : s.total >= 70 ? 'var(--accent)' : 'var(--warn)');

    const m = [];
    const metric = (label, value, cls = '') => m.push(`<div class="metric ${cls}"><b>${value}</b><span>${label}</span></div>`);
    const pct = (v) => `${Math.round(v * 100)}%`;
    metric(t.mode === 'timing' ? '弹响的拍点' : '音准正确', pct(s.accuracy), s.accuracy >= 0.95 ? 'good' : s.accuracy < 0.8 ? 'bad' : '');
    const lean = s.meanSigned < -5 ? '抢' : s.meanSigned > 5 ? '拖' : '准';
    metric(`平均节奏偏差（${lean}）`, `${Math.round(s.meanAbs)} ms`, s.meanAbs <= 15 ? 'good' : s.meanAbs > 30 ? 'bad' : '');
    metric('节奏稳定度（波动）', `±${Math.round(s.spread)} ms`, s.spread <= 12 ? 'good' : s.spread > 25 ? 'bad' : '');
    if (s.legatoRatio != null) metric('连奏音量 / 拨弦音量', pct(s.legatoRatio), s.legatoRatio >= 0.8 ? 'good' : s.legatoRatio < 0.6 ? 'bad' : '');
    else if (t.mode !== 'timing') metric('力度波动', pct(s.cv), s.cv <= 0.2 ? 'good' : s.cv > 0.4 ? 'bad' : '');
    if (s.bendCents != null) metric('推弦平均偏差', `${s.bendCents > 0 ? '+' : ''}${Math.round(s.bendCents)} 音分`, Math.abs(s.bendCents) <= 20 ? 'good' : 'bad');
    metric('漏音 / 错音 / 多余', `${s.counts.miss} / ${s.counts.wrong} / ${s.counts.extra}`, s.counts.miss + s.counts.wrong + s.counts.extra === 0 ? 'good' : '');
    metric(`${t.bpm} BPM · ${t.reps} 遍`, `${s.counts.n} 个音`);
    $('resMetrics').innerHTML = m.join('');

    const tips = feedback(s, next, t.bpm);
    if (state.calib == null) tips.push('还没做过延迟校准，节奏偏差里可能含有声卡延迟，建议先校准一次。');
    $('resTips').innerHTML = tips.map((x) => `<li>${x}</li>`).join('');
    drawChart(aligned.notes, t);
    $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function drawChart(notes, t) {
    const cv = $('resChart');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    const pad = { l: 40, r: 10, t: 14, b: 18 };
    const RANGE = 80;
    const Y = (ms) => pad.t + ((clamp(ms, -RANGE, RANGE) + RANGE) / (2 * RANGE)) * (h - pad.t - pad.b);
    const t0 = t.plan.T0, t1 = t.plan.length - 0.5;
    const X = (time) => pad.l + ((time - t0) / (t1 - t0)) * (w - pad.l - pad.r);
    // 早（负）在上，晚（正）在下

    // 「准」区间 ±15ms
    g.fillStyle = 'rgba(95, 211, 141, 0.10)';
    g.fillRect(pad.l, Y(15), w - pad.l - pad.r, Y(-15) - Y(15));
    g.strokeStyle = col('--line');
    g.lineWidth = 1;
    g.font = '10px Segoe UI, sans-serif';
    g.fillStyle = col('--muted');
    for (const ms of [-60, -30, 0, 30, 60]) {
      g.globalAlpha = ms === 0 ? 0.9 : 0.35;
      g.beginPath(); g.moveTo(pad.l, Y(ms)); g.lineTo(w - pad.r, Y(ms)); g.stroke();
      g.globalAlpha = 1;
      g.fillText(ms < 0 ? `早${-ms}` : ms > 0 ? `晚${ms}` : '0', 4, Y(ms) + 3);
    }
    // 小节线
    const barStarts = new Map();
    for (const n of notes) if (!barStarts.has(`${n.rep}:${n.bar}`)) barStarts.set(`${n.rep}:${n.bar}`, n);
    g.globalAlpha = 0.25;
    for (const n of barStarts.values()) {
      g.beginPath(); g.moveTo(X(n.t) - 3, pad.t); g.lineTo(X(n.t) - 3, h - pad.b); g.stroke();
    }
    g.globalAlpha = 1;
    for (const n of barStarts.values()) g.fillText(String(n.bar + 1), X(n.t), h - 4);

    for (const n of notes) {
      const x = X(n.t);
      if (n.status === 'miss') {
        g.fillStyle = col('--warn');
        g.font = 'bold 12px Segoe UI, sans-serif';
        g.fillText('×', x - 3, pad.t + 4);
        g.font = '10px Segoe UI, sans-serif';
        continue;
      }
      const a = Math.abs(n.dt);
      const c = a <= 15 ? col('--ok') : a <= 35 ? '#e6c14a' : '#ff9147';
      g.beginPath();
      g.arc(x, Y(n.dt), 3.2, 0, Math.PI * 2);
      if (n.status === 'wrong') {
        g.strokeStyle = col('--warn');
        g.lineWidth = 2;
        g.stroke();
        g.lineWidth = 1;
        g.strokeStyle = col('--line');
      } else {
        g.fillStyle = c;
        g.fill();
      }
    }
  }

  /** 在谱面上给每个音上色（多遍取最差的一次） */
  function colorScore(notes) {
    const A = window.alphaTab;
    if (!api?.score || !A?.model?.NoteStyle) return;
    const worst = new Map();
    const rank = { ok: 0, unknown: 0, late: 1, wrong: 2, miss: 3 };
    for (const n of notes) {
      const st = n.status === 'ok' && Math.abs(n.dt) > 35 ? 'late' : n.status;
      const prev = worst.get(n.i);
      if (!prev || rank[st] > rank[prev]) worst.set(n.i, st);
    }
    const colors = { ok: '#1f9d55', unknown: '#1f9d55', late: '#d98a00', wrong: '#d6336c', miss: '#d6336c' };
    try {
      const evs = expectedFrom(api.score).events;
      evs.forEach((e, i) => {
        const c = A.model.Color.fromJson(colors[worst.get(i) ?? 'ok']);
        for (const note of e.notes) {
          note.style = new A.model.NoteStyle();
          note.style.colors.set(A.model.NoteSubElement.GuitarTabFretNumber, c);
          note.style.colors.set(A.model.NoteSubElement.StandardNotationNoteHead, c);
        }
      });
      api.render();
    } catch (err) {
      console.warn('谱面上色失败', err);
    }
  }

  $('resAgain').addEventListener('click', () => {
    setBpm(recommendBpm(curEx(), state.records[state.current]));
    startTake('exercise');
  });
  $('resNext').addEventListener('click', () => {
    const items = state.plan?.items ?? [];
    const nextPlan = items.find((p) => !p.done && p.id !== state.current);
    if (nextPlan) return select(nextPlan.id);
    const same = EX.filter((e) => e.cat === curEx().cat);
    const i = same.findIndex((e) => e.id === state.current);
    select((same[i + 1] ?? same[0]).id);
  });

  // ---------------------------------------------------------------- 启动
  ensurePlan();
  renderSide();
  if (!state.level) levelDlg.showModal();
  else select(state.current && exById[state.current] ? state.current : state.plan.items[0].id);

  return {
    isTaking: () => !!taking,
    handleKey(e) {
      if (e.key === 'Enter' && !taking && fx.native && e.target.tagName !== 'BUTTON') { startTake('exercise'); return true; }
      if (e.key === 'Escape' && taking) { $('takeCancel').click(); return true; }
      return false;
    },
  };
}
