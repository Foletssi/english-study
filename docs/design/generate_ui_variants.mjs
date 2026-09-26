import fs from 'node:fs';
import path from 'node:path';

const outDir = 'F:/英语网页重构/docs/design/ui-variants-20260926';
fs.mkdirSync(outDir, { recursive: true });

const themes = [
  { id: '01-mist-blue', name: '雾蓝瓷白', bg: '#F5F9FD', surface: '#FFFFFF', ink: '#173454', muted: '#58708D', line: '#D8E5F1', primary: '#347DB9', soft: '#E8F2FC', highlight: '#C47F16', highlightBg: '#FFF0CC', dark: false },
  { id: '02-rose-cream', name: '玫瑰奶油', bg: '#FFF8F6', surface: '#FFFFFF', ink: '#4A2E3E', muted: '#8B6475', line: '#F0DDE4', primary: '#B65F83', soft: '#FCEAF1', highlight: '#B06B14', highlightBg: '#FFF0CF', dark: false },
  { id: '03-sage-ivory', name: '鼠尾草象牙', bg: '#F7FAF5', surface: '#FFFFFF', ink: '#243D37', muted: '#6C847B', line: '#DDE9E0', primary: '#568A78', soft: '#E8F3EC', highlight: '#A36D18', highlightBg: '#FFF2D1', dark: false },
  { id: '04-lavender-gray', name: '灰紫雾面', bg: '#F8F7FC', surface: '#FFFFFF', ink: '#302C4C', muted: '#746E94', line: '#E3E0F1', primary: '#7564AE', soft: '#EFECFA', highlight: '#A36C16', highlightBg: '#FFF0CD', dark: false },
  { id: '05-coral-sand', name: '珊瑚米杏', bg: '#FFF9F3', surface: '#FFFFFF', ink: '#493127', muted: '#906C5B', line: '#F0DED0', primary: '#D3735B', soft: '#FDEBE3', highlight: '#A76515', highlightBg: '#FFF0CF', dark: false },
  { id: '06-midnight-blue', name: '深海蓝夜', bg: '#102239', surface: '#182E49', ink: '#F4F8FC', muted: '#A8BDD2', line: '#31516D', primary: '#61B1EE', soft: '#214563', highlight: '#F0BB58', highlightBg: '#4B3B25', dark: true }
];

const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (x, y, value, size, fill, weight = 400, anchor = 'start', family = 'Arial, Microsoft YaHei, sans-serif') =>
  `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(value)}</text>`;
const rect = (x, y, w, h, fill, stroke = 'none', r = 0, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" ${extra}/>`;
const line = (x1, y1, x2, y2, stroke, width = 1) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"/>`;
const icon = (x, y, kind, stroke, fill = 'none') => {
  const common = `stroke="${stroke}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="${fill}"`;
  if (kind === 'back') return `<path d="M${x+15} ${y+8} L${x+8} ${y+16} L${x+15} ${y+24}" ${common}/>`;
  if (kind === 'sun') return `<circle cx="${x+16}" cy="${y+16}" r="5" ${common}/><path d="M${x+16} ${y+3}v5m0 16v5M${x+3} ${y+16}h5m16 0h5M${x+7} ${y+7}l4 4m10 10l4 4M${x+25} ${y+7}l-4 4M${x+11} ${y+21}l-4 4" ${common}/>`;
  if (kind === 'play') return `<path d="M${x+11} ${y+8} L${x+25} ${y+16} L${x+11} ${y+24} Z" fill="${stroke}"/>`;
  if (kind === 'pause') return `<path d="M${x+11} ${y+9}v14M${x+21} ${y+9}v14" ${common}/>`;
  if (kind === 'next') return `<path d="M${x+8} ${y+8}v16M${x+11} ${y+16}l10-8v16z" ${common}/>`;
  if (kind === 'prev') return `<path d="M${x+24} ${y+8}v16M${x+21} ${y+16}l-10-8v16z" ${common}/>`;
  if (kind === 'speaker') return `<path d="M${x+6} ${y+13}h5l6-5v16l-6-5H${x+6}zM${x+21} ${y+12}q6 4 0 8M${x+24} ${y+8}q9 8 0 16" ${common}/>`;
  if (kind === 'star') return `<path d="M${x+16} ${y+5}l3.4 6.8 7.5 1.1-5.4 5.3 1.3 7.5-6.8-3.5-6.8 3.5 1.3-7.5-5.4-5.3 7.5-1.1z" ${common}/>`;
  if (kind === 'more') return `<circle cx="${x+8}" cy="${y+16}" r="2" fill="${stroke}"/><circle cx="${x+16}" cy="${y+16}" r="2" fill="${stroke}"/><circle cx="${x+24}" cy="${y+16}" r="2" fill="${stroke}"/>`;
  if (kind === 'copy') return `<rect x="${x+9}" y="${y+8}" width="12" height="14" rx="2" ${common}/><path d="M${x+13} ${y+5}h8a2 2 0 0 1 2 2v11" ${common}/>`;
  if (kind === 'bookmark') return `<path d="M${x+9} ${y+6}h14v22l-7-4-7 4z" ${common}/>`;
  return '';
};

function playerScreen(t, x, y) {
  const w = 390, h = 844;
  let s = rect(x, y, w, h, t.surface, t.line, 28, `stroke-width="2"`);
  s += rect(x+7, y+7, w-14, h-14, t.surface, t.line, 22, `stroke-width="1"`);
  s += text(x+28, y+42, '9:41', 12, t.ink, 700);
  s += icon(x+24, y+54, 'back', t.primary);
  s += text(x+54, y+76, '忙碌的一天生活 Vlog', 15, t.ink, 700);
  s += icon(x+w-50, y+59, 'sun', t.primary);
  s += line(x+8, y+91, x+w-8, y+91, t.line);
  s += rect(x+8, y+92, w-16, 218, '#152331', 'none', 0);
  s += rect(x+8, y+92, w-16, 218, '#243C50', 'none', 0, `opacity="0.28"`);
  s += text(x+24, y+293, '01:35 / 10:43', 12, '#FFFFFF', 700);
  s += text(x+w-24, y+293, '⛶', 24, '#FFFFFF', 400, 'end');
  const modes = ['连续播放', '逐句暂停', '单句循环', '听写填空'];
  let mx = x+18;
  modes.forEach((m, i) => { const mw = [67, 67, 67, 82][i]; s += rect(mx, y+318, mw, 30, i === 0 ? t.soft : 'transparent', i === 0 ? t.primary : t.line, 15, `stroke-width="1"`); s += text(mx+mw/2, y+338, m, 11, i === 0 ? t.primary : t.muted, 700, 'middle'); mx += mw+5; });
  const rows = [
    ['I have a few things to do today.', '今天有几件事要做。', '01:29'],
    ["I’m trying to make the most of my morning.", '我想充分利用早上的时间。', '01:35'],
    ['Then I’m heading out to meet a friend.', '然后我要出门见一位朋友。', '01:40']
  ];
  rows.forEach((r, i) => {
    const ry = y+363+i*87;
    if (i === 1) s += rect(x+8, ry-16, w-16, 78, t.soft, 'none', 0) + rect(x+8, ry-16, 4, 78, t.primary, 'none', 0);
    s += text(x+26, ry, r[2], 11, t.muted, 500);
    if (i === 1) {
      const before = 'I’m trying to ';
      s += text(x+70, ry, before, 14, t.ink, 500, 'start', 'Georgia, serif');
      const bx = x+70 + 89;
      s += text(bx, ry, 'make the most of', 14, t.highlight, 700, 'start', 'Georgia, serif');
      s += line(bx, ry+4, bx+107, ry+4, t.highlight, 2);
      s += text(bx+110, ry, ' my morning.', 14, t.ink, 500, 'start', 'Georgia, serif');
    } else s += text(x+70, ry, r[0], 14, t.ink, 500, 'start', 'Georgia, serif');
    s += text(x+70, ry+23, r[1], 12, t.muted, 400);
    s += icon(x+w-68, ry+4, 'speaker', t.primary);
    s += icon(x+w-38, ry+4, 'star', t.primary);
    s += line(x+24, ry+43, x+w-24, ry+43, t.line);
  });
  s += text(x+25, y+634, '01:35', 11, t.muted, 500);
  s += rect(x+70, y+625, 225, 6, t.line, 'none', 3) + rect(x+70, y+625, 102, 6, t.primary, 'none', 3) + `<circle cx="${x+172}" cy="${y+628}" r="7" fill="${t.primary}"/>`;
  s += text(x+w-25, y+634, '10:43', 11, t.muted, 500, 'end');
  const actions = [['速倍', '↻'], ['盲听', '◌'], ['上句', '◀'], ['播放', 'play'], ['下句', '▶'], ['更多', 'more']];
  const ax = [x+43, x+101, x+158, x+194, x+247, x+321];
  actions.forEach((a, i) => {
    if (a[1] === 'play') { s += `<circle cx="${ax[i]}" cy="${y+690}" r="25" fill="${t.primary}"/>`; s += icon(ax[i]-16, y+674, 'play', '#FFFFFF'); }
    else if (a[1] === 'more') { s += icon(ax[i]-16, y+674, 'more', t.primary); }
    else s += text(ax[i], y+693, a[1], 20, t.primary, 700, 'middle');
    s += text(ax[i], y+721, a[0], 10, t.muted, 600, 'middle');
  });
  s += line(x+22, y+744, x+w-22, y+744, t.line);
  const stats = [['重点词', '28'], ['生词本', '3'], ['标记已学', '✓'], ['视频目录', '›']];
  stats.forEach((a, i) => { const sx = x+54+i*91; s += text(sx, y+772, a[0], 10, t.muted, 600, 'middle'); s += text(sx+28, y+772, a[1], 10, t.primary, 700, 'middle'); });
  s += `<rect x="${x+145}" y="${y+823}" width="100" height="4" rx="2" fill="${t.muted}" opacity="0.65"/>`;
  return s;
}

function cardScreen(t, x, y) {
  const w = 390, h = 844;
  let s = rect(x, y, w, h, t.surface, t.line, 28, `stroke-width="2"`);
  s += rect(x+7, y+7, w-14, h-14, t.surface, t.line, 22, `stroke-width="1"`);
  s += text(x+28, y+43, '词卡', 18, t.ink, 700);
  s += icon(x+w-51, y+26, 'more', t.muted);
  s += line(x+24, y+63, x+w-24, y+63, t.line);
  s += text(x+28, y+112, 'play it by ear', 27, t.highlight, 700, 'start', 'Georgia, serif');
  s += text(x+28, y+139, '/pleɪ ɪt baɪ ɪr/', 13, t.muted, 500, 'start', 'Consolas, monospace');
  s += `<circle cx="${x+w-65}" cy="${y+109}" r="24" fill="${t.soft}"/>` + icon(x+w-81, y+93, 'speaker', t.primary);
  s += `<circle cx="${x+w-31}" cy="${y+40}" r="15" fill="${t.soft}"/>` + text(x+w-31, y+46, '×', 24, t.primary, 400, 'middle');
  s += rect(x+28, y+158, 52, 25, t.soft, 'none', 13) + text(x+54, y+175, '习语', 12, t.primary, 700, 'middle');
  s += line(x+28, y+207, x+w-28, y+207, t.line);
  s += text(x+28, y+239, '核心释义', 11, t.muted, 700);
  s += text(x+28, y+272, '随机应变；看情况再决定', 18, t.ink, 600);
  s += text(x+28, y+320, '语境理解', 11, t.muted, 700);
  s += text(x+28, y+353, '先不把计划定死，到时候再看怎么安排。', 15, t.ink, 500);
  s += rect(x+28, y+389, w-56, 116, t.soft, 'none', 14);
  s += text(x+45, y+426, "We don't need a fixed plan.", 15, t.ink, 500, 'start', 'Georgia, serif');
  s += text(x+45, y+451, "Let's", 15, t.ink, 500, 'start', 'Georgia, serif');
  s += text(x+87, y+451, ' play it by ear.', 15, t.highlight, 700, 'start', 'Georgia, serif');
  s += line(x+87, y+455, x+188, y+455, t.highlight, 2);
  s += text(x+45, y+480, '不用提前定死计划，到时候再看吧。', 12, t.muted, 400);
  const buttons = [['播放原句', 'play'], ['复制', 'copy'], ['加入生词本', 'bookmark']];
  const bx = [x+28, x+142, x+253];
  buttons.forEach((b, i) => { const bw = i === 2 ? 109 : 95; s += rect(bx[i], y+535, bw, 42, i === 2 ? t.primary : 'transparent', i === 2 ? t.primary : t.line, 13, `stroke-width="1"`); s += icon(bx[i]+10, y+544, b[1], i === 2 ? '#FFFFFF' : t.primary); s += text(bx[i]+bw/2+8, y+561, b[0], 12, i === 2 ? '#FFFFFF' : t.primary, 700, 'middle'); });
  s += line(x+28, y+608, x+w-28, y+608, t.line);
  s += text(x+28, y+639, '发音状态', 11, t.muted, 700);
  [['speaker', '发音'], ['more', '加载中'], ['speaker', '播放中'], ['replay', '重试']].forEach((a, i) => { const cx=x+72+i*82; s += `<circle cx="${cx}" cy="${y+689}" r="22" fill="${i===2?t.primary:t.soft}"/>`; s += icon(cx-16,y+673,a[0],i===2?'#FFFFFF':t.primary); s += text(cx,y+731,a[1],10,t.muted,600,'middle'); });
  s += `<rect x="${x+145}" y="${y+823}" width="100" height="4" rx="2" fill="${t.muted}" opacity="0.65"/>`;
  return s;
}

for (const t of themes) {
  const titleFill = t.dark ? '#DCEBFA' : t.ink;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1080" viewBox="0 0 1600 1080">
<rect width="1600" height="1080" fill="${t.bg}"/>
${text(800, 54, `Eastudy · ${t.name}`, 28, titleFill, 700, 'middle')}
${text(800, 82, '移动播放器 + 词卡 · 保持成熟版按钮排布', 13, t.muted, 500, 'middle')}
${text(325, 118, '播放器详情页', 15, t.muted, 700, 'middle')}
${text(1075, 118, '词卡界面', 15, t.muted, 700, 'middle')}
${playerScreen(t, 130, 140)}
${cardScreen(t, 760, 140)}
${text(800, 1030, '重点词颜色固定 · 字幕独立滚动 · 底部控制条固定 · 触控区不变形', 12, t.muted, 500, 'middle')}
</svg>`;
  fs.writeFileSync(path.join(outDir, `eastudy-${t.id}.svg`), svg, 'utf8');
}
console.log(`generated ${themes.length} SVG UI variants in ${outDir}`);
