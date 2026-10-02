import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  align, scoreTake, feedback, recommendBpm, addRecord, mastery, buildPlan, checkLevelUp, calibrationOffset, PASS,
} from '../src/js/practice-core.js';

const lib = JSON.parse(fs.readFileSync(new URL('../src/library/index.json', import.meta.url)));

// 120 BPM 十六分音符，32 个音
const expected = Array.from({ length: 32 }, (_, i) => ({ t: 1 + i * 0.125, midis: [45 + (i % 8)], bend: null, legato: false, bar: Math.floor(i / 16), idx: i }));
const perfect = expected.map((e) => ({ t: e.t + 0.004, midi: e.midis[0], midi_max: e.midis[0], amp: 0.8, kind: 0 }));

test('完美演奏得高分', () => {
  const s = scoreTake(align(expected, perfect, 'notes'), 'notes');
  assert.equal(s.counts.ok, 32);
  assert.equal(s.counts.miss, 0);
  assert.ok(s.total >= 95, `total=${s.total}`);
});

test('漏音、错音、多余的音都能识别', () => {
  const det = perfect.filter((_, i) => i !== 5 && i !== 6).map((d, i) => (i === 10 ? { ...d, midi: d.midi + 2 } : d));
  det.push({ t: 2.06, midi: 60, midi_max: 60, amp: 0.7, kind: 0 }); // 两个音之间的杂音
  det.sort((a, b) => a.t - b.t);
  const r = align(expected, det, 'notes');
  const s = scoreTake(r, 'notes');
  assert.equal(s.counts.miss, 2);
  assert.equal(s.counts.wrong, 1);
  assert.equal(s.counts.extra, 1);
  assert.ok(s.total < 95);
});

test('抢拍会被指出', () => {
  const det = expected.map((e) => ({ t: e.t - 0.022 + (Math.random() - 0.5) * 0.006, midi: e.midis[0], midi_max: e.midis[0], amp: 0.8, kind: 0 }));
  const s = scoreTake(align(expected, det, 'notes'), 'notes');
  assert.ok(s.meanSigned < -18 && s.meanSigned > -26, `meanSigned=${s.meanSigned}`);
  assert.ok(feedback(s, 100, 100).some((t) => t.includes('抢拍')));
});

test('推弦音准偏差', () => {
  const exp = [{ t: 1, midis: [62], bend: 64, legato: false, bar: 0, idx: 0 }];
  const r = align(exp, [{ t: 1.003, midi: 62, midi_max: 63.5, amp: 0.8, kind: 0 }], 'bend');
  assert.equal(r.notes[0].status, 'wrong');
  assert.equal(r.notes[0].cents, -50);
});

test('校准取中位数', () => {
  const det = expected.map((e) => ({ t: e.t + 0.012, midi: -1, midi_max: -1, amp: 0.5, kind: 0 }));
  assert.equal(calibrationOffset(align(expected, det, 'timing').notes), 12);
});

test('速度推荐随得分升降', () => {
  const ex = lib.exercises.find((e) => e.id === 'finger-1234');
  assert.equal(recommendBpm(ex, null), ex.start);
  assert.ok(recommendBpm(ex, { last: { bpm: 80, score: 95 } }) > 80);
  assert.equal(recommendBpm(ex, { last: { bpm: 80, score: 80 } }), 80);
  assert.ok(recommendBpm(ex, { last: { bpm: 80, score: 50 } }) < 80);
});

test('达标才计入最高速度，掌握度随之上升', () => {
  const ex = lib.exercises.find((e) => e.id === 'finger-1234');
  let r = addRecord(null, { bpm: 90, score: 70, date: 'd' });
  assert.equal(r.best, 0);
  r = addRecord(r, { bpm: 85, score: PASS, date: 'd' });
  assert.equal(r.best, 85);
  assert.ok(mastery(ex, r) > 0.3 && mastery(ex, r) < 1);
  r = addRecord(r, { bpm: ex.goal, score: 90, date: 'd' });
  assert.equal(mastery(ex, r), 1);
});

test('今日计划：热身 + 补弱 + 挑战，且不重复', () => {
  const plan = buildPlan(lib.exercises, {}, 2, lib.categories);
  assert.equal(plan[0].role, '热身');
  assert.ok(plan.some((p) => p.role === '挑战'));
  assert.equal(new Set(plan.map((p) => p.id)).size, plan.length);
  const levels = plan.map((p) => lib.exercises.find((e) => e.id === p.id).level);
  assert.ok(levels.every((l) => l <= 3), levels.join());
});

test('当前等级大部分达标后升级', () => {
  const recs = {};
  for (const e of lib.exercises.filter((x) => x.level === 1)) recs[e.id] = { best: e.goal };
  assert.equal(checkLevelUp(lib.exercises, recs, 1), 2);
  assert.equal(checkLevelUp(lib.exercises, {}, 1), 1);
});

test('超过上限后弹得好也不建议降速', () => {
  const ex = lib.exercises.find((e) => e.id === 'pick-tremolo');
  assert.equal(recommendBpm(ex, { last: { bpm: 200, score: 98 } }), 200);
  assert.ok(recommendBpm(ex, { last: { bpm: 200, score: 60 } }) < 200);
});
