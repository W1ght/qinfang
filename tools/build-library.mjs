// 生成「练习曲库」：用 alphaTex 描述每条基本功练习，导出 Guitar Pro 7 (.gp) 文件和索引。
// 运行：node tools/build-library.mjs
import * as at from '../node_modules/@coderline/alphatab/dist/alphaTab.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../src/library');

export const CATEGORIES = [
  { id: 'finger', name: '左手 · 爬格子', desc: '手指独立性、力量与换把' },
  { id: 'picking', name: '右手 · 拨弦', desc: '交替拨弦、跨弦与速度' },
  { id: 'legato', name: '连奏', desc: '击弦、勾弦的力度与均匀度' },
  { id: 'scale', name: '音阶 · 模进', desc: '指板位置与旋律模进' },
  { id: 'arpeggio', name: '琶音 · 扫拨', desc: '和弦分解与扫拨同步' },
  { id: 'rhythm', name: '节奏 · 和弦', desc: '换和弦、扫弦与闷音节奏' },
  { id: 'bend', name: '推弦 · 颤音', desc: '推弦音准与颤音控制' },
];

// ---------------------------------------------------------------- 生成工具

const DUR_UNITS = { 1: 64, 2: 32, 4: 16, 8: 8, 16: 4, 32: 2 }; // 以 64 分音符为单位

/** 把音符列表按时值切成小节，最后一小节不足时补休止符 */
function measures(tokens, { dur = 16, tuplet = 0, beatsPerBar = 4 } = {}) {
  const unit = DUR_UNITS[dur] * (tuplet ? (tuplet === 3 ? 2 / 3 : tuplet === 6 ? 4 / 6 : 1) : 1);
  const barUnits = beatsPerBar * 16;
  const perBar = Math.round(barUnits / unit);
  const tu = tuplet ? `{tu ${tuplet}}` : '';
  const withTu = (t) => (tu ? (t.includes('{') ? t.replace('{', `{tu ${tuplet} `) : t + tu) : t);
  const bars = [];
  for (let i = 0; i < tokens.length; i += perBar) {
    const chunk = tokens.slice(i, i + perBar).map(withTu);
    let rest = '';
    if (chunk.length < perBar) {
      // 剩余部分用休止符补齐
      let left = (perBar - chunk.length) * unit;
      if (tuplet) {
        // 三连音/六连音不足一拍的部分先用同样的连音休止补齐到整拍
        const per = tuplet;
        while (chunk.length % per) { chunk.push(`r${tu}`); left -= unit; }
      }
      const rs = [];
      for (const [d, u] of [[1, 64], [2, 32], [4, 16], [8, 8], [16, 4]]) {
        while (left >= u - 0.01) { rs.push(`r.${d}`); left -= u; }
      }
      rest = ' ' + rs.join(' ');
    }
    bars.push(`:${dur} ${chunk.join(' ')}${rest}`);
  }
  return bars.join(' | ');
}

const n = (fret, string, fx = '') => `${fret}.${string}${fx ? `{${fx}}` : ''}`;
const repeat = (arr, k) => Array.from({ length: k }, () => arr).flat();
const chord = (notes, fx = '') => `(${notes.map(([f, s]) => n(f, s, fx)).join(' ')})`;

// A 自然小调 3NPS（第 5 把位）
const AMIN_3NPS = [[6, [5, 7, 8]], [5, [5, 7, 8]], [4, [5, 7, 9]], [3, [5, 7, 9]], [2, [6, 8, 10]], [1, [7, 8, 10]]];
// A 小调五声音阶第一把位
const PENTA = [[6, [5, 8]], [5, [5, 7]], [4, [5, 7]], [3, [5, 7]], [2, [5, 8]], [1, [5, 8]]];
// G 大调两个八度（第 2 把位）
const GMAJ = [[6, [3, 5]], [5, [2, 3, 5]], [4, [2, 4, 5]], [3, [2, 4, 5]], [2, [3, 5]], [1, [2, 3]]];

const flat = (shape) => shape.flatMap(([s, frets]) => frets.map((f) => [f, s]));
const toks = (pairs, fx) => pairs.map(([f, s]) => n(f, s, fx));

// ---------------------------------------------------------------- 练习定义

const EX = [];
const add = (e) => EX.push(e);

// ===== 左手 =====
add({
  id: 'finger-1234', cat: 'finger', level: 1, title: '1-2-3-4 爬格子', start: 60, goal: 110, mode: 'notes',
  tips: '每个手指负责一个品格，按完一个音手指不要急着抬起。先求干净，再求速度。',
  body: measures([
    ...[6, 5, 4, 3, 2, 1].flatMap((s) => [1, 2, 3, 4].map((f) => n(f, s))),
    ...[1, 2, 3, 4, 5, 6].flatMap((s) => [4, 3, 2, 1].map((f) => n(f, s))),
  ], { dur: 8 }),
});
add({
  id: 'finger-shift', cat: 'finger', level: 2, title: '爬格子 · 斜向换把', start: 60, goal: 120, mode: 'notes',
  tips: '每换一根弦整体上移一品。换把时食指带动整个手，拇指跟着移动。',
  body: measures([
    ...[6, 5, 4, 3, 2, 1].flatMap((s, i) => [1, 2, 3, 4].map((f) => n(f + i, s))),
    ...[1, 2, 3, 4, 5, 6].flatMap((s, i) => [4, 3, 2, 1].map((f) => n(f + 5 - i, s))),
  ]),
});
add({
  id: 'finger-perm', cat: 'finger', level: 2, title: '手指排列 1-3-2-4 / 4-2-3-1', start: 60, goal: 120, mode: 'notes',
  tips: '打乱手指顺序，专练 3、4 指的独立性。第 5 把位：食指 5 品，小指 8 品。',
  body: measures([
    ...[6, 5, 4, 3, 2, 1].flatMap((s) => [1, 3, 2, 4].map((f) => n(f + 4, s))),
    ...[1, 2, 3, 4, 5, 6].flatMap((s) => [4, 2, 3, 1].map((f) => n(f + 4, s))),
  ]),
});
add({
  id: 'finger-spider', cat: 'finger', level: 3, title: '蜘蛛爬 · 交叉手指', start: 60, goal: 120, mode: 'notes',
  tips: '1、3 指一组，2、4 指一组，在相邻两根弦上交替。不弹的手指保持贴近指板。',
  body: measures([
    ...[[6, 5], [5, 4], [4, 3], [3, 2], [2, 1]].flatMap(([a, b]) => [n(5, a), n(7, b), n(6, a), n(8, b)]),
    ...[[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]].flatMap(([a, b]) => [n(8, a), n(6, b), n(7, a), n(5, b)]),
    ...[n(5, 6), n(7, 5), n(6, 6), n(8, 5), n(5, 6), n(7, 5), n(6, 6), n(8, 5)],
  ]),
});
add({
  id: 'finger-stretch', cat: 'finger', level: 4, title: '扩张 · 五品跨度', start: 50, goal: 100, mode: 'notes',
  tips: '食指 7 品、小指 11 品，跨 5 个品格。手腕放低、拇指移到琴颈中后部，感到疼就停。',
  body: measures([
    ...[6, 5, 4, 3, 2, 1].flatMap((s) => [7, 9, 10, 11].map((f) => n(f, s))),
    ...[1, 2, 3, 4, 5, 6].flatMap((s) => [11, 10, 9, 7].map((f) => n(f, s))),
  ]),
});

// ===== 右手 =====
add({
  id: 'pick-open', cat: 'picking', level: 1, title: '空弦交替拨弦', start: 60, goal: 120, mode: 'notes',
  tips: '严格下上交替。手腕发力、动作尽量小，拨片只露出一点点。',
  body: [
    measures(repeat([n(0, 6)], 8), { dur: 8 }),
    measures(repeat([n(0, 5)], 8), { dur: 8 }),
    measures(repeat([n(0, 6)], 16)),
    measures(repeat([n(0, 5)], 16)),
  ].join(' | '),
});
add({
  id: 'pick-tremolo', cat: 'picking', level: 2, title: '四连拨 · 单弦旋律', start: 70, goal: 140, mode: 'notes',
  tips: '每个音拨四下，换音时左右手要同步。听每一下的音量是否一样。',
  body: measures([5, 7, 8, 10, 12, 10, 8, 7].flatMap((f) => repeat([n(f, 1)], 4))
    .concat([5, 7, 8, 10, 12, 10, 8, 7].flatMap((f) => repeat([n(f, 2)], 4)))),
});
add({
  id: 'pick-crossing', cat: 'picking', level: 3, title: '跨弦 · 内外侧拨弦', start: 60, goal: 130, mode: 'notes',
  tips: '每个音都换弦，体会“内侧”和“外侧”两种跨弦。拨片轨迹走小弧线，别抬太高。',
  body: measures([
    ...repeat([n(7, 2), n(5, 1)], 8),
    ...repeat([n(9, 3), n(7, 2)], 8),
    ...repeat([n(5, 2), n(8, 2), n(5, 1), n(8, 1)], 4),
    ...repeat([n(5, 3), n(7, 3), n(5, 2), n(8, 2)], 4),
  ]),
});
add({
  id: 'pick-3nps', cat: 'picking', level: 4, title: '三音一弦 · 小调音阶六连音', start: 60, goal: 130, mode: 'notes',
  tips: '每弦三个音、严格交替拨弦，所以每换一根弦拨弦方向会翻转，这正是难点。',
  body: measures(repeat([...toks(flat(AMIN_3NPS)), ...toks(flat(AMIN_3NPS).reverse())], 2), { dur: 16, tuplet: 6 }),
});
add({
  id: 'pick-skip', cat: 'picking', level: 4, title: '跳弦 · 隔弦拨奏', start: 60, goal: 120, mode: 'notes',
  tips: '每两根弦之间跳过一根。不弹的弦用左手手指侧面和右手掌根闷住。',
  body: measures(repeat([
    ...[[6, 4], [5, 3], [4, 2], [3, 1]].flatMap(([a, b]) => [n(5, a), n(8, a), n(5, b), n(7, b)]),
    ...[[1, 3], [2, 4], [3, 5], [4, 6]].flatMap(([a, b]) => [n(8, a), n(5, a), n(7, b), n(5, b)]),
  ], 2)),
});
add({
  id: 'pick-burst', cat: 'picking', level: 5, title: '速度爆发 · 六连音冲刺', start: 70, goal: 150, mode: 'notes',
  tips: '短促的六连音冲刺接休止，休止时彻底放松。冲刺要跟拍子对齐，不要抢。',
  body: [0, 1, 2, 3].map((i) => {
    const [s1, f1] = AMIN_3NPS[i], [s2, f2] = AMIN_3NPS[i + 1];
    const six = [...f1.map((f) => n(f, s1)), ...f2.map((f) => n(f, s2))].map((t) => `${t.replace(/(\{.*\})?$/, '')}{tu 6}`).join(' ');
    return `:16 ${six} :4 r :16 ${six} :4 r`;
  }).join(' | '),
});

// ===== 连奏 =====
add({
  id: 'legato-trill', cat: 'legato', level: 2, title: '击勾弦 · 颤音组合', start: 60, goal: 120, mode: 'notes',
  tips: '只拨每拍的第一个音，其余全靠击弦和勾弦。勾弦时手指要往下“勾”一点，音量才够。',
  body: measures([[5, 7], [5, 8], [5, 9], [7, 8]].flatMap(([a, b]) =>
    repeat([n(a, 3, 'h'), n(b, 3, 'h'), n(a, 3, 'h'), n(b, 3)], 4))),
});
add({
  id: 'legato-3nps', cat: 'legato', level: 3, title: '三音一弦连奏', start: 60, goal: 120, mode: 'notes',
  tips: '每根弦只拨第一个音：上行击弦、下行勾弦。目标是拨的音和连的音一样响。',
  body: measures(repeat([
    ...AMIN_3NPS.flatMap(([s, fr]) => [n(fr[0], s, 'h'), n(fr[1], s, 'h'), n(fr[2], s)]),
    ...[...AMIN_3NPS].reverse().flatMap(([s, fr]) => [n(fr[2], s, 'h'), n(fr[1], s, 'h'), n(fr[0], s)]),
  ], 2), { dur: 16, tuplet: 6 }),
});

// ===== 音阶 =====
add({
  id: 'scale-penta', cat: 'scale', level: 1, title: '小调五声音阶 · 第一把位', start: 60, goal: 120, mode: 'notes',
  tips: '摇滚和布鲁斯最常用的音阶。第 5 把位，食指 5 品、小指 8 品。',
  body: measures([...toks(flat(PENTA)), ...toks(flat(PENTA).reverse())], { dur: 8 }),
});
add({
  id: 'scale-major', cat: 'scale', level: 2, title: 'G 大调音阶 · 两个八度', start: 60, goal: 120, mode: 'notes',
  tips: '从 6 弦 3 品的 G 开始，上行再下行。边弹边唱出 do re mi，帮助记住音的位置。',
  body: measures([...toks(flat(GMAJ)), ...toks(flat(GMAJ).reverse().slice(1))], { dur: 8 }),
});
add({
  id: 'scale-penta-3s', cat: 'scale', level: 3, title: '五声音阶 · 三音模进', start: 60, goal: 120, mode: 'notes',
  tips: '三个音一组、每组往上挪一个音，用三连音弹。重音落在每组第一个音上。',
  body: (() => {
    const L = toks(flat(PENTA));
    const up = [], down = [];
    for (let i = 0; i + 2 < L.length; i++) up.push(L[i], L[i + 1], L[i + 2]);
    const R = [...L].reverse();
    for (let i = 0; i + 2 < R.length; i++) down.push(R[i], R[i + 1], R[i + 2]);
    return measures([...up, ...down], { dur: 8, tuplet: 3 });
  })(),
});
add({
  id: 'scale-4s', cat: 'scale', level: 4, title: '大调音阶 · 四音模进', start: 60, goal: 120, mode: 'notes',
  tips: '1234、2345、3456…… 四个音一组。很多经典独奏乐句都是这样串起来的。',
  body: (() => {
    const L = toks(flat(GMAJ));
    const up = [], down = [];
    for (let i = 0; i + 3 < L.length; i++) up.push(...L.slice(i, i + 4));
    const R = [...L].reverse();
    for (let i = 0; i + 3 < R.length; i++) down.push(...R.slice(i, i + 4));
    return measures([...up, ...down]);
  })(),
});

// ===== 琶音 =====
add({
  id: 'arp-3string', cat: 'arpeggio', level: 3, title: '三弦扫拨 · Am C G F', start: 60, goal: 120, mode: 'notes',
  tips: '下行一笔扫过三根弦，每个音弹完立刻抬起手指闷音，避免几个音糊成一个和弦。',
  body: measures([
    [[14, 3], [13, 2], [12, 1], [13, 2]], [[17, 3], [17, 2], [15, 1], [17, 2]],
    [[12, 3], [12, 2], [10, 1], [12, 2]], [[10, 3], [10, 2], [8, 1], [10, 2]],
  ].flatMap((shape) => repeat(toks(shape), 4))),
});
add({
  id: 'arp-5string', cat: 'arpeggio', level: 5, title: '五弦扫拨 · Am 与 C', start: 50, goal: 100, mode: 'notes',
  tips: '下扫一笔到底，顶端用击勾弦掉头再上扫。先 50 BPM 把每个音弹清楚，扫拨最忌糊。',
  body: (() => {
    const am = [n(12, 5, 'h'), n(15, 5), n(14, 4), n(14, 3), n(13, 2), n(12, 1, 'h'), n(17, 1, 'h'), n(12, 1), n(13, 2), n(14, 3), n(14, 4), n(15, 5)];
    const c = [n(15, 5, 'h'), n(19, 5), n(17, 4), n(17, 3), n(17, 2), n(15, 1, 'h'), n(20, 1, 'h'), n(15, 1), n(17, 2), n(17, 3), n(17, 4), n(19, 5)];
    return measures([...am, ...am, ...c, ...c], { dur: 16, beatsPerBar: 3 });
  })(),
  ts: '3 4',
});

// ===== 节奏 =====
const PM = 'pm';
const E5 = [[0, 6], [2, 5]], G5 = [[3, 6], [5, 5]], A5 = [[5, 6], [7, 5]], C5 = [[8, 6], [10, 5]];
add({
  id: 'rhythm-power', cat: 'rhythm', level: 1, title: '强力和弦 · 闷音八分', start: 70, goal: 140, mode: 'timing',
  tips: '全部下拨，右手掌根轻搭在琴桥上闷音。换和弦时手形整体平移，不要拆开重按。',
  body: [E5, G5, A5, C5].map((c) => measures(repeat([chord(c, PM)], 8), { dur: 8 })).join(' | '),
});
add({
  id: 'rhythm-open', cat: 'rhythm', level: 1, title: '开放和弦转换 · G C D Em', start: 60, goal: 120, mode: 'timing',
  tips: '每拍一下。第四拍就要开始换和弦，提前看好下一个和弦的指型。',
  body: [
    [[3, 6], [2, 5], [0, 4], [0, 3], [0, 2], [3, 1]],
    [[3, 5], [2, 4], [0, 3], [1, 2], [0, 1]],
    [[0, 4], [2, 3], [3, 2], [2, 1]],
    [[0, 6], [2, 5], [2, 4], [0, 3], [0, 2], [0, 1]],
  ].map((c) => measures(repeat([chord(c)], 4), { dur: 4 })).join(' | '),
});
add({
  id: 'rhythm-16th', cat: 'rhythm', level: 2, title: '十六分扫弦 · Em C G D', start: 60, goal: 100, mode: 'timing',
  tips: '右手保持下上下上不停，像钟摆一样。重音放在每拍第一下。',
  body: [
    [[0, 6], [2, 5], [2, 4], [0, 3], [0, 2], [0, 1]],
    [[3, 5], [2, 4], [0, 3], [1, 2], [0, 1]],
    [[3, 6], [2, 5], [0, 4], [0, 3], [0, 2], [3, 1]],
    [[0, 4], [2, 3], [3, 2], [2, 1]],
  ].map((c) => measures(repeat([chord(c)], 16))).join(' | '),
});
add({
  id: 'rhythm-barre', cat: 'rhythm', level: 2, title: '横按和弦 · F Bm Am E', start: 60, goal: 110, mode: 'timing',
  tips: '食指用外侧（靠拇指那边）横按，力量来自手臂往后拉，而不是拇指死捏。',
  body: [
    [[1, 6], [3, 5], [3, 4], [2, 3], [1, 2], [1, 1]],
    [[2, 5], [4, 4], [4, 3], [3, 2], [2, 1]],
    [[5, 6], [7, 5], [7, 4], [5, 3], [5, 2], [5, 1]],
    [[0, 6], [2, 5], [2, 4], [1, 3], [0, 2], [0, 1]],
  ].map((c) => `:4 ${chord(c)} :8 ${chord(c)} ${chord(c)} :4 ${chord(c)} :8 ${chord(c)} ${chord(c)}`).join(' | '),
});
add({
  id: 'rhythm-gallop', cat: 'rhythm', level: 3, title: '金属马蹄节奏', start: 80, goal: 160, mode: 'timing',
  tips: '“哒-哒哒”：下-下上。闷音要紧，三个音的音量尽量一样。',
  body: [E5, E5, G5, A5].map((c) => repeat([`:8 ${chord(c, PM)} :16 ${chord(c, PM)} ${chord(c, PM)}`], 4).join(' ')).join(' | '),
});

// ===== 推弦 =====
add({
  id: 'bend-pitch', cat: 'bend', level: 2, title: '推弦音准 · 全音与半音', start: 60, goal: 90, mode: 'bend',
  tips: '先弹目标音记住音高，再推弦推到同样的音高。用 2、3 指一起推，测评会显示推高了还是推低了。',
  body: [
    `:4 9.3 7.3{b (0 4)} r r`, `:4 9.3 7.3{b (0 4)} r r`,
    `:4 10.2 8.2{b (0 4)} r r`, `:4 8.2 7.2{b (0 2)} r r`,
    `:4 10.1 8.1{b (0 4)} r r`, `:4 8.1 7.1{b (0 2)} r r`,
  ].join(' | '),
});
add({
  id: 'bend-vibrato', cat: 'bend', level: 3, title: '颤音 · 五声音阶长音', start: 60, goal: 100, mode: 'notes',
  tips: '颤音的幅度和速度要均匀。先慢颤（每拍两次），再加快到每拍四次。',
  body: measures([[7, 3], [8, 2], [5, 1], [8, 1], [7, 2], [5, 2], [7, 3], [5, 3]].map(([f, s]) => n(f, s, 'v')), { dur: 2 }),
});

// ---------------------------------------------------------------- 导出

const settings = new at.Settings();
fs.mkdirSync(OUT, { recursive: true });
const index = { categories: CATEGORIES, exercises: [] };
let failed = 0;
for (const e of EX) {
  const cat = CATEGORIES.find((c) => c.id === e.cat);
  const tex = `\\title "${e.title}" \\subtitle "${cat.name} · 难度 ${e.level}" \\tempo ${e.start} `
    + `\\track "Guitar" \\staff {score tabs} \\ts (${e.ts ?? '4 4'}) ${e.body}`;
  const imp = new at.importer.AlphaTexImporter();
  imp.initFromString(tex, settings);
  let score;
  try {
    score = imp.readScore();
  } catch (err) {
    failed++;
    const c = err.cause ?? err;
    console.error(`✗ ${e.id}`);
    for (const k of ['lexerDiagnostics', 'parserDiagnostics', 'semanticDiagnostics']) {
      for (const d of c[k]?.items ?? []) console.error(`   ${d.message} @${d.start?.col}`);
    }
    continue;
  }
  // 检查每小节时值是否填满
  const bars = score.tracks[0].staves[0].bars;
  const bad = bars.map((b, i) => [i, b]).filter(([, b]) => Math.abs(b.calculateDuration() - b.masterBar.calculateDuration()) > 1);
  if (bad.length) console.warn(`! ${e.id} 小节时值不对：${bad.map(([i]) => i + 1).join(',')}`);
  const notes = bars.flatMap((b) => b.voices[0].beats).filter((bt) => !bt.isRest).length;
  fs.writeFileSync(path.join(OUT, `${e.id}.gp`), new at.exporter.Gp7Exporter().export(score, settings));
  const { body, ...meta } = e;
  index.exercises.push({ ...meta, bars: bars.length, notes });
  console.log(`✓ ${e.id.padEnd(16)} L${e.level} ${String(bars.length).padStart(2)} 小节 ${String(notes).padStart(3)} 拍点  ${e.title}`);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1));
console.log(`\n共 ${index.exercises.length} 条，失败 ${failed} 条 → ${OUT}`);
if (failed) process.exit(1);
