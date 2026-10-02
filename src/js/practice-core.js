// 练习路线与测评打分的纯逻辑（不依赖 DOM，便于单独测试）。

export const LEVELS = ['', '入门', '初级', '中级', '中高级', '高级'];
/** 得分达到这个分数才算“弹干净了”，计入最高速度 */
export const PASS = 85;

// ---------------------------------------------------------------- 自适应路线

/** 每次加速的步长：练习速度区间的 1/8，至少 2 BPM */
const stepOf = (ex) => Math.max(2, Math.round((ex.goal - ex.start) / 8));

/** 根据上次表现推荐本次速度 */
export function recommendBpm(ex, rec) {
  const last = rec?.last;
  if (!last) return ex.start;
  const step = stepOf(ex);
  let bpm = last.bpm;
  if (last.score >= 92) bpm += step;
  else if (last.score >= PASS) bpm += Math.ceil(step / 2);
  else if (last.score < 70) bpm -= step;
  const lo = Math.round(ex.start * 0.7);
  const hi = Math.round(ex.goal * 1.25);
  bpm = Math.min(hi, Math.max(lo, bpm));
  // 弹得好就不往回降（哪怕已经超过建议上限）
  return last.score >= PASS ? Math.max(bpm, last.bpm) : bpm;
}

/** 掌握度 0..1：达标速度在「起始速度的 90%」到「目标速度」之间的位置 */
export function mastery(ex, rec) {
  const best = rec?.best ?? 0;
  if (!best) return 0;
  if (best >= ex.goal) return 1;
  const lo = ex.start * 0.9;
  return Math.max(0.05, Math.min(1, (best - lo) / (ex.goal - lo)));
}

/** 记录一次练习结果，返回更新后的记录 */
export function addRecord(rec, { bpm, score, date }) {
  const r = rec ? { ...rec, history: [...(rec.history ?? [])] } : { best: 0, history: [] };
  r.last = { bpm, score, date };
  if (score >= PASS && bpm > (r.best ?? 0)) r.best = bpm;
  r.history.push({ bpm, score, date });
  if (r.history.length > 60) r.history.splice(0, r.history.length - 60);
  return r;
}

export function categoryMastery(exercises, records, cat, level) {
  const list = exercises.filter((e) => e.cat === cat && e.level <= level);
  if (!list.length) return null;
  return list.reduce((s, e) => s + mastery(e, records[e.id]), 0) / list.length;
}

/** 当前等级 60% 以上的练习掌握度 ≥ 0.8 就升级 */
export function checkLevelUp(exercises, records, level) {
  if (level >= 5) return level;
  const cur = exercises.filter((e) => e.level === level);
  if (!cur.length) return level + 1;
  const ok = cur.filter((e) => mastery(e, records[e.id]) >= 0.8).length;
  return ok >= Math.ceil(cur.length * 0.6) ? level + 1 : level;
}

export function levelProgress(exercises, records, level) {
  const cur = exercises.filter((e) => e.level === level);
  const need = Math.ceil(cur.length * 0.6);
  const ok = cur.filter((e) => mastery(e, records[e.id]) >= 0.8).length;
  return { ok: Math.min(ok, need), need };
}

/**
 * 今日计划：热身（左手）+ 最弱的三个类别各一条 + 一条挑战。
 * 同一天内保持不变，练完一项打勾。
 */
export function buildPlan(exercises, records, level, categories) {
  const pick = (list) => [...list].sort((a, b) =>
    mastery(a, records[a.id]) - mastery(b, records[b.id]) || b.level - a.level)[0];
  const items = [];
  const used = new Set();
  const push = (ex, role) => {
    if (!ex || used.has(ex.id)) return;
    used.add(ex.id);
    items.push({ id: ex.id, role, bpm: recommendBpm(ex, records[ex.id]), done: false, score: null });
  };

  push(pick(exercises.filter((e) => e.cat === 'finger' && e.level <= level)), '热身');

  const weak = categories
    .filter((c) => c.id !== 'finger')
    .map((c) => ({ c, m: categoryMastery(exercises, records, c.id, level) }))
    .filter((x) => x.m !== null)
    .sort((a, b) => a.m - b.m)
    .slice(0, 3);
  for (const { c } of weak) {
    // 优先当前等级的练习，没有就用更低等级里最弱的
    const sameLevel = exercises.filter((e) => e.cat === c.id && e.level === level && mastery(e, records[e.id]) < 1);
    push(pick(sameLevel.length ? sameLevel : exercises.filter((e) => e.cat === c.id && e.level <= level)), '补弱');
  }

  const challenge = exercises.filter((e) => e.level === Math.min(5, level + 1) && !used.has(e.id));
  push(pick(challenge.length ? challenge : exercises.filter((e) => !used.has(e.id) && e.level <= level)), '挑战');
  return items;
}

// ---------------------------------------------------------------- 测评：对齐

/**
 * expected: [{ t, midis:[], bend: 目标MIDI|null, legato, bar, idx }]
 * detected: [{ t, midi, midi_max, amp, kind }]
 * 用动态规划求最优单调对齐，允许漏音和多余的音。
 */
export function align(expected, detected, mode) {
  const n = expected.length, m = detected.length;
  const amps = detected.map((d) => d.amp).sort((a, b) => a - b);
  const medAmp = amps[Math.floor(amps.length / 2)] ?? 0.1;
  const win = expected.map((e, i) => {
    const prev = i > 0 ? e.t - expected[i - 1].t : 1;
    const next = i < n - 1 ? expected[i + 1].t - e.t : 1;
    return Math.min(0.15, Math.max(0.035, 0.45 * Math.min(prev, next)));
  });
  const C_MISS = 1.0;
  const extraCost = (d) => (d.amp > medAmp * 0.25 ? 0.7 : 0.15);

  const INF = 1e9;
  const W = m + 1;
  const dp = new Float64Array((n + 1) * W).fill(INF);
  const from = new Uint8Array((n + 1) * W); // 1 漏音, 2 多余, 3 匹配
  dp[0] = 0;
  for (let j = 1; j <= m; j++) { dp[j] = dp[j - 1] + extraCost(detected[j - 1]); from[j] = 2; }
  for (let i = 1; i <= n; i++) {
    dp[i * W] = dp[(i - 1) * W] + C_MISS;
    from[i * W] = 1;
    const e = expected[i - 1];
    for (let j = 1; j <= m; j++) {
      const d = detected[j - 1];
      let best = dp[(i - 1) * W + j] + C_MISS, f = 1;
      const c2 = dp[i * W + j - 1] + extraCost(d);
      if (c2 < best) { best = c2; f = 2; }
      const dt = d.t - e.t;
      if (Math.abs(dt) <= win[i - 1]) {
        const pc = pitchStatus(e, d, mode);
        const c3 = dp[(i - 1) * W + j - 1] + (dt / win[i - 1]) ** 2 * 0.8 + (pc.status === 'wrong' ? 0.6 : pc.status === 'unknown' ? 0.15 : 0);
        if (c3 < best) { best = c3; f = 3; }
      }
      dp[i * W + j] = best;
      from[i * W + j] = f;
    }
  }

  const notes = expected.map((e) => ({ ...e, status: 'miss', dt: null, amp: null, det: null }));
  const extras = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const f = from[i * W + j];
    if (f === 3) {
      const e = notes[i - 1], d = detected[j - 1];
      const pc = pitchStatus(e, d, mode);
      Object.assign(e, { status: pc.status, cents: pc.cents, dt: (d.t - e.t) * 1000, amp: d.amp, det: d });
      i--; j--;
    } else if (f === 1 || j === 0) {
      i--;
    } else {
      if (detected[j - 1].amp > medAmp * 0.25) extras.push(detected[j - 1]);
      j--;
    }
  }
  return { notes, extras: extras.reverse() };
}

/** 音高判定：'ok' | 'wrong' | 'unknown'；推弦额外给出音分偏差 */
export function pitchStatus(e, d, mode) {
  if (mode === 'timing' || !e.midis.length) return { status: 'ok' };
  if (e.bend != null) {
    if (d.midi_max < 0) return { status: 'unknown' };
    const cents = Math.round((d.midi_max - e.bend) * 100);
    return { status: Math.abs(cents) <= 40 ? 'ok' : 'wrong', cents };
  }
  if (d.midi < 0) return { status: 'unknown' };
  // 允许八度误判（低音弦上音高检测常见）
  const diff = Math.min(...e.midis.flatMap((m) => [m, m - 12, m + 12].map((x) => Math.abs(d.midi - x))));
  return { status: diff <= 0.6 ? 'ok' : 'wrong' };
}

// ---------------------------------------------------------------- 测评：打分

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function scoreTake({ notes, extras }, mode) {
  const n = notes.length || 1;
  const matched = notes.filter((x) => x.status !== 'miss');
  const ok = notes.filter((x) => x.status === 'ok' || x.status === 'unknown');
  const wrong = notes.filter((x) => x.status === 'wrong');
  const miss = notes.filter((x) => x.status === 'miss');
  const dts = matched.map((x) => x.dt);
  // 去掉最离谱的 5% 再算稳定度，避免一两个意外把整体拉垮
  const sorted = [...dts].sort((a, b) => Math.abs(a) - Math.abs(b));
  const core = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.95)));

  const meanSigned = mean(core);
  const meanAbs = mean(core.map(Math.abs));
  const spread = std(core);

  const picked = matched.filter((x) => !x.legato).map((x) => x.amp);
  const legato = matched.filter((x) => x.legato).map((x) => x.amp);
  const cv = picked.length > 3 ? std(picked) / (mean(picked) || 1) : 0;
  const legatoRatio = legato.length && picked.length ? mean(legato) / (mean(picked) || 1) : null;
  const bends = matched.filter((x) => x.cents != null).map((x) => x.cents);

  const accuracy = ok.length / n;
  const timingScore = clamp01(1 - (meanAbs - 8) / 42);
  const steadyScore = clamp01(1 - (spread - 6) / 34);
  const evenScore = legatoRatio != null
    ? clamp01(1 - Math.max(0, 0.85 - legatoRatio) / 0.5) * 0.5 + clamp01(1 - (cv - 0.15) / 0.45) * 0.5
    : clamp01(1 - (cv - 0.15) / 0.45);
  const extraPenalty = Math.min(0.15, (extras.length / n) * 0.5);
  const total = Math.round(100 * clamp01(0.45 * accuracy + 0.25 * timingScore + 0.15 * steadyScore + 0.15 * evenScore - extraPenalty));

  // 按小节汇总问题
  const bars = new Map();
  for (const x of notes) {
    const b = bars.get(x.bar) ?? { bar: x.bar, bad: 0, n: 0 };
    b.n++;
    if (x.status === 'miss' || x.status === 'wrong' || Math.abs(x.dt ?? 0) > 35) b.bad++;
    bars.set(x.bar, b);
  }
  const worstBars = [...bars.values()].filter((b) => b.bad / b.n >= 0.25).sort((a, b) => b.bad / b.n - a.bad / a.n).slice(0, 3).map((b) => b.bar + 1);

  return {
    total, accuracy, timingScore, steadyScore, evenScore,
    meanSigned, meanAbs, spread, cv, legatoRatio,
    bendCents: bends.length ? mean(bends) : null,
    counts: { n: notes.length, ok: ok.length, wrong: wrong.length, miss: miss.length, extra: extras.length },
    worstBars, mode,
  };
}

export function feedback(s, nextBpm, bpm) {
  const tips = [];
  const ms = (v) => `${Math.round(Math.abs(v))} ms`;
  if (s.counts.miss / s.counts.n > 0.05) tips.push(`有 ${s.counts.miss} 个音没弹出来或声音太小${s.worstBars.length ? `，集中在第 ${s.worstBars.join('、')} 小节` : ''}。`);
  if (s.counts.wrong / s.counts.n > 0.05) tips.push(s.bendCents != null
    ? `推弦音准偏${s.bendCents < 0 ? '低' : '高'}约 ${Math.abs(Math.round(s.bendCents))} 音分，${s.bendCents < 0 ? '推得还不够' : '推过头了'}。`
    : `有 ${s.counts.wrong} 个音音高不对（按错品、没按实或碰到别的弦）。`);
  if (s.meanSigned < -10) tips.push(`整体抢拍约 ${ms(s.meanSigned)}，放松一点，让音落在节拍器上。`);
  else if (s.meanSigned > 10) tips.push(`整体拖拍约 ${ms(s.meanSigned)}，右手提前做好准备。`);
  if (s.spread > 20) tips.push(`节奏不够稳，前后波动约 ±${ms(s.spread)}。建议降速 10% 把每个音放准。`);
  if (s.legatoRatio != null && s.legatoRatio < 0.65) tips.push('击弦和勾弦的音偏弱，手指落弦要更果断、勾弦往下带一点。');
  else if (s.cv > 0.35 && s.mode !== 'timing') tips.push('力度不均匀，注意下拨和上拨的音量要一样。');
  if (s.counts.extra / s.counts.n > 0.08) tips.push(`有 ${s.counts.extra} 处多余的声音，注意闷住不弹的弦。`);
  if (!tips.length) tips.push(s.total >= 92 ? '非常干净！可以加速了。' : '整体不错，保持这个速度再巩固几遍。');
  if (nextBpm > bpm) tips.push(`下次建议 ${nextBpm} BPM。`);
  else if (nextBpm < bpm) tips.push(`下次建议先降到 ${nextBpm} BPM。`);
  return tips;
}

/** 校准：取所有匹配上的音的时间偏差中位数 */
export function calibrationOffset(notes) {
  const dts = notes.filter((x) => x.dt != null).map((x) => x.dt).sort((a, b) => a - b);
  if (dts.length < 6) return null;
  return Math.round(dts[Math.floor(dts.length / 2)]);
}
