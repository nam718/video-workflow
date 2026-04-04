/**
 * chart-renderer.mjs - PPT风格动画图表渲染器
 *
 * 使用 ECharts + Playwright 生成动画数据图表视频片段
 * 输出: 1080×1080 MP4 视频（匹配 ai-video-maker 的视频区域）
 *
 * 图表:
 *   1. 赛道K线热度图 — 各标签烛台+成交量柱
 *   2. 红海蓝海机会矩阵 — 四象限散点气泡
 *
 * 用法: import { renderCharts, analyzeAllTags, buildChartNarrations } from './chart-renderer.mjs';
 */

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const CHART_W = 1080, CHART_H = 1080;
const BG = '#0d0a1f';
const RECORD_DURATION_MS = 12000; // 录制12秒（动画~6s + 静态保持~6s）

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

/* ═══════════════ 标签检测规则（扩展版） ═══════════════ */

const TAG_RULES = [
  { name: '古风',     pattern: /古风|古装|国风|古偶/ },
  { name: '仙侠玄幻', pattern: /仙侠|武侠|玄幻|修仙/ },
  { name: '恐怖惊悚', pattern: /恐怖|惊悚|克苏鲁|诡/ },
  { name: '末日丧尸', pattern: /末日|丧尸/ },
  { name: '搞笑轻喜', pattern: /搞笑|抽象|喜剧|女频/ },
  { name: '言情甜宠', pattern: /言情|恋爱|甜宠|强制爱/ },
  { name: 'IP改编',   pattern: /白雪公主|童话|赵云|三国|西游|霍去病/ },
  { name: '历史正剧', pattern: /历史|正剧/ },
  { name: '大女主',   pattern: /大女主|女性成长|女性穿越|独立女性|杀夫证道/ },
  { name: '打脸虐渣', pattern: /打脸|虐渣|复仇|恶毒女配|剧情反转/ },
  { name: '总裁豪门', pattern: /总裁|霸总|豪门/ },
  { name: '逆袭',     pattern: /逆袭|翻身|扮猪吃虎/ },
  { name: '穿越',     pattern: /穿越/ },
  { name: '师徒',     pattern: /师徒|师姐|师父/ },
  { name: '现代都市', pattern: /现代|都市|日常/ },
  { name: '虐恋',     pattern: /虐恋|虐心/ },
];

const FORMAT_RULES = [
  { name: 'AI漫剧', pattern: /漫剧/ },
  { name: 'AI真人', pattern: /真人|写实/i },
  { name: '动画风', pattern: /动画/ },
];

const TOOL_RULES = [
  { name: '即梦Seedance', pattern: /即梦|seedance/i },
  { name: '可灵',         pattern: /可灵/ },
  { name: '随变AI',       pattern: /随变/ },
  { name: '小云雀',       pattern: /小云雀/ },
];

/* ═══════════════ 数据分析 ═══════════════ */

export function analyzeAllTags(items) {
  const tagMap = {};
  for (const rule of TAG_RULES) {
    tagMap[rule.name] = { count: 0, totalHeat: 0, totalLikes: 0, totalShares: 0, items: [] };
  }

  for (const item of items) {
    const t = item.title || '';
    for (const rule of TAG_RULES) {
      if (rule.pattern.test(t)) {
        const m = tagMap[rule.name];
        m.count++;
        m.totalHeat += item.heat_score || 0;
        m.totalLikes += item.liked_count || 0;
        m.totalShares += item.share_count || 0;
        m.items.push(item);
      }
    }
  }

  const tags = Object.entries(tagMap)
    .filter(([, v]) => v.count > 0)
    .map(([name, v]) => ({
      name,
      count: v.count,
      avgHeat: Math.round(v.totalHeat / v.count),
      avgLikes: Math.round(v.totalLikes / v.count),
      avgShares: Math.round(v.totalShares / v.count),
      totalHeat: v.totalHeat,
      items: v.items,
    }))
    .sort((a, b) => b.count - a.count || b.avgHeat - a.avgHeat);

  const overallAvgHeat = tags.length
    ? tags.reduce((s, t) => s + t.avgHeat, 0) / tags.length
    : 0;

  // 格式
  const formats = [];
  for (const rule of FORMAT_RULES) {
    let count = 0;
    for (const it of items) { if (rule.pattern.test(it.title || '')) count++; }
    if (count > 0) formats.push({ name: rule.name, count });
  }
  formats.sort((a, b) => b.count - a.count);

  // 工具
  const tools = [];
  for (const rule of TOOL_RULES) {
    let count = 0;
    for (const it of items) { if (rule.pattern.test(it.title || '')) count++; }
    if (count > 0) tools.push({ name: rule.name, count });
  }
  tools.sort((a, b) => b.count - a.count);

  return { tags, formats, tools, overallAvgHeat, totalItems: items.length };
}

/* ═══════════════ ECharts 库缓存 ═══════════════ */

async function getEchartsLib(tmpDir) {
  const ecPath = path.join(tmpDir, 'echarts.min.js');
  if (fs.existsSync(ecPath) && fs.statSync(ecPath).size > 100000) {
    return fs.readFileSync(ecPath, 'utf-8');
  }
  console.log('  📦 下载 ECharts 库...');
  try {
    execSync(`curl -sL --connect-timeout 15 "https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js" -o "${ecPath}"`);
    if (fs.existsSync(ecPath) && fs.statSync(ecPath).size > 100000) {
      return fs.readFileSync(ecPath, 'utf-8');
    }
  } catch { /* fall through */ }
  console.log('  ⚠️ ECharts 下载失败');
  return null;
}

/* ═══════════════ HTML 模板: 黑马飙升榜 ═══════════════ */

function buildDarkHorseHTML(items, echartsCode, date) {
  // 计算日均互动速度
  const now = new Date(date).getTime() / 1000;
  const withSpeed = items
    .filter(it => it.create_time && it.create_time > 0)
    .map(it => {
      const days = Math.max(1, (now - it.create_time) / 86400);
      const dailyEngagement = Math.round((it.liked_count + it.share_count) / days);
      return { ...it, days: +days.toFixed(1), dailyEngagement };
    })
    .sort((a, b) => b.dailyEngagement - a.dailyEngagement)
    .slice(0, 8);

  if (withSpeed.length < 3) return null;

  const names = withSpeed.map(it => {
    const short = (it.title || '').split(/[#\n]/)[0].trim().substring(0, 12);
    return short || it.nickname;
  });
  const speeds = withSpeed.map(it => it.dailyEngagement);
  const daysData = withSpeed.map(it => it.days);
  const maxSpeed = Math.max(...speeds);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0}body{background:${BG};width:${CHART_W}px;height:${CHART_H}px;overflow:hidden}
#chart{width:${CHART_W}px;height:${CHART_H}px}
</style></head><body><div id="chart"></div>
<script>${echartsCode}</script>
<script>
var names = ${JSON.stringify(names)};
var speeds = ${JSON.stringify(speeds)};
var daysData = ${JSON.stringify(daysData)};
var maxSpeed = ${maxSpeed};

var chart = echarts.init(document.getElementById('chart'));
chart.setOption({
  backgroundColor: '${BG}',
  textStyle: { fontFamily: 'PingFang SC, Hiragino Sans GB, sans-serif' },
  title: [{
    text: '🐴 黑马飙升榜',
    left: 'center', top: 25,
    textStyle: { color: '#ff6b6b', fontSize: 36, fontWeight: 'bold' }
  }, {
    text: '${date} · 日均互动增速排名',
    left: 'center', top: 70,
    textStyle: { color: 'rgba(255,255,255,0.4)', fontSize: 20 }
  }],
  tooltip: { show: false },
  grid: { left: 200, right: 80, top: 120, bottom: 60 },
  xAxis: {
    type: 'value',
    name: '日均互动(点赞+分享)',
    nameLocation: 'center', nameGap: 35,
    nameTextStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 14 },
    axisLabel: {
      color: 'rgba(255,255,255,0.4)', fontSize: 13,
      formatter: function(v) { return v >= 10000 ? (v/10000).toFixed(0) + '万' : v; }
    },
    splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } },
    axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } }
  },
  yAxis: {
    type: 'category', data: names.slice().reverse(),
    axisLabel: { color: '#ddd', fontSize: 15, width: 170, overflow: 'truncate' },
    axisLine: { show: false }, axisTick: { show: false }
  },
  series: [{
    type: 'bar',
    data: speeds.slice().reverse().map(function(v, i) {
      var ratio = v / maxSpeed;
      var color = ratio > 0.7 ? { type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
          colorStops: [{ offset: 0, color: '#ff416c' }, { offset: 1, color: '#ff4b2b' }] }
        : ratio > 0.3 ? { type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
          colorStops: [{ offset: 0, color: '#f7971e' }, { offset: 1, color: '#ffd200' }] }
        : { type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
          colorStops: [{ offset: 0, color: '#43cea2' }, { offset: 1, color: '#185a9d' }] };
      return { value: v, itemStyle: { color: color, borderRadius: [0, 6, 6, 0] } };
    }),
    barWidth: 32,
    label: {
      show: true, position: 'right',
      formatter: function(p) {
        var idx = names.length - 1 - p.dataIndex;
        var d = daysData[idx];
        var v = p.value;
        var fmt = v >= 10000 ? (v/10000).toFixed(1) + '万/天' : v + '/天';
        return fmt + '  (' + d + '天)';
      },
      color: 'rgba(255,255,255,0.7)', fontSize: 13
    },
    animationDuration: 1500,
    animationDelay: function(idx) { return (names.length - 1 - idx) * 300 + 500; },
    animationEasing: 'cubicOut'
  }]
});

// 冠军闪烁动画
setTimeout(function() {
  chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: names.length - 1 });
}, 4500);
</script></body></html>`;
}

/* ═══════════════ HTML 模板: K线热度图 ═══════════════ */

function buildKlineHTML(analysis, echartsCode, date) {
  const tags = analysis.tags.slice(0, 10);
  if (tags.length < 2) return null;

  const overallAvg = analysis.overallAvgHeat / 10000;
  const tagNames = tags.map(t => t.name);

  // K线数据: [open, close, lowest, highest]
  // open = 总均值 (基线), close = 本赛道均值
  // → close > open = 红柱(强势), close < open = 绿柱(弱势)
  const klineData = tags.map(tag => {
    const heats = tag.items.map(it => (it.heat_score || tag.avgHeat) / 10000);
    const minH = Math.min(...heats);
    const maxH = Math.max(...heats);
    const avg = heats.reduce((a, b) => a + b, 0) / heats.length;
    const spread = maxH - minH;
    // 单条目赛道增加可见宽度
    const lo = spread < avg * 0.05 ? +(avg * 0.92).toFixed(1) : +minH.toFixed(1);
    const hi = spread < avg * 0.05 ? +(avg * 1.08).toFixed(1) : +maxH.toFixed(1);
    return [+overallAvg.toFixed(1), +avg.toFixed(1), lo, hi];
  });

  const countData = tags.map(t => t.count);
  const barW = Math.min(50, Math.max(20, Math.floor(650 / tags.length)));
  const volW = Math.min(35, Math.max(15, Math.floor(500 / tags.length)));

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0}body{background:${BG};width:${CHART_W}px;height:${CHART_H}px;overflow:hidden}
#chart{width:${CHART_W}px;height:${CHART_H}px}
</style></head><body><div id="chart"></div>
<script>${echartsCode}</script>
<script>
var tagNames = ${JSON.stringify(tagNames)};
var klineData = ${JSON.stringify(klineData)};
var countData = ${JSON.stringify(countData)};
var medianCount = countData.slice().sort(function(a,b){return a-b})[Math.floor(countData.length/2)] || 1;

var chart = echarts.init(document.getElementById('chart'));
chart.setOption({
  backgroundColor: '${BG}',
  textStyle: { fontFamily: 'PingFang SC, Hiragino Sans GB, sans-serif' },
  title: [{
    text: '📈 赛道热度K线图',
    left: 'center', top: 25,
    textStyle: { color: '#00e5ff', fontSize: 34, fontWeight: 'bold' }
  }, {
    text: '${date} · 抖音AI短剧 TOP${analysis.totalItems}',
    left: 'center', top: 68,
    textStyle: { color: 'rgba(255,255,255,0.4)', fontSize: 20 }
  }],
  tooltip: { show: false },
  grid: [
    { left: 140, right: 50, top: 120, height: '50%' },
    { left: 140, right: 50, top: '78%', height: '13%' }
  ],
  xAxis: [{
    type: 'category', data: tagNames, gridIndex: 0,
    axisLabel: { color: '#ddd', fontSize: 17, rotate: 0, interval: 0  },
    axisLine: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
    axisTick: { show: false }
  }, {
    type: 'category', data: tagNames, gridIndex: 1,
    axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false }
  }],
  yAxis: [{
    gridIndex: 0, name: '热度(万)',
    nameTextStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 14, padding: [0,50,0,0] },
    splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)', type: 'dashed' } },
    axisLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 14,
      formatter: function(v){return v>=10000?(v/10000).toFixed(0)+'亿':v>=100?v.toFixed(0):v.toFixed(1)} },
    axisLine: { show: false }
  }, {
    gridIndex: 1, name: '作品数',
    nameTextStyle: { color: 'rgba(255,255,255,0.3)', fontSize: 12 },
    splitLine: { show: false },
    axisLabel: { color: 'rgba(255,255,255,0.3)', fontSize: 12 },
    axisLine: { show: false }, min: 0
  }],
  series: [{
    type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0,
    data: klineData,
    itemStyle: {
      color: '#ef5350', color0: '#26a69a',
      borderColor: '#ef5350', borderColor0: '#26a69a',
      borderWidth: 2
    },
    barWidth: ${barW},
    animationDuration: 1200,
    animationDelay: function(idx) { return idx * 350 + 800; },
    animationEasing: 'cubicOut',
    markLine: {
      symbol: 'none',
      lineStyle: { color: '#ffab00', type: 'dashed', width: 1.5 },
      label: { color: '#ffab00', fontSize: 14, formatter: '均值 ${Math.round(overallAvg)}万' },
      data: [{ yAxis: ${overallAvg.toFixed(1)} }],
      animationDuration: 800,
      animationDelay: 4000
    }
  }, {
    type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
    data: countData.map(function(v) {
      return { value: v, itemStyle: { color: v >= medianCount ? '#ef5350' : '#26a69a', opacity: 0.8 } };
    }),
    barWidth: ${volW},
    label: { show: true, position: 'top', color: 'rgba(255,255,255,0.6)', fontSize: 13, formatter: '{c}部' },
    animationDuration: 800,
    animationDelay: function(idx) { return idx * 350 + 1500; },
    animationEasing: 'elasticOut'
  }]
});
</script></body></html>`;
}

/* ═══════════════ HTML 模板: 红海蓝海矩阵 ═══════════════ */

function buildOceanHTML(analysis, echartsCode, date) {
  const tags = analysis.tags.filter(t => t.count > 0);
  if (tags.length < 3) return null;

  // X = 竞争度(作品数), Y = 平均互动(万), Size = 平均热度
  const scatterData = tags.map(t => [
    t.count,
    +((t.avgLikes + t.avgShares) / 10000).toFixed(1),
    +(t.avgHeat / 10000).toFixed(1),
    t.name,
  ]);

  const xs = scatterData.map(d => d[0]);
  const ys = scatterData.map(d => d[1]);
  const sortedXs = xs.slice().sort((a, b) => a - b);
  const medianX = Math.max(sortedXs[Math.floor(sortedXs.length / 2)] + 0.5, 3);
  const sortedYs = ys.slice().sort((a, b) => a - b);
  const medianY = sortedYs[Math.floor(sortedYs.length / 2)] || 10;
  const maxX = Math.max(...xs) * 1.3;
  const maxY = Math.max(...ys) * 1.3;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0}body{background:${BG};width:${CHART_W}px;height:${CHART_H}px;overflow:hidden}
#chart{width:${CHART_W}px;height:${CHART_H}px}
</style></head><body><div id="chart"></div>
<script>${echartsCode}</script>
<script>
var scatterData = ${JSON.stringify(scatterData)};
var medianX = ${medianX}, medianY = ${medianY.toFixed(1)};
var maxX = ${maxX.toFixed(1)}, maxY = ${maxY.toFixed(1)};

var chart = echarts.init(document.getElementById('chart'));
chart.setOption({
  backgroundColor: '${BG}',
  textStyle: { fontFamily: 'PingFang SC, Hiragino Sans GB, sans-serif' },
  title: [{
    text: '🎯 红海蓝海机会矩阵',
    left: 'center', top: 25,
    textStyle: { color: '#00e5ff', fontSize: 34, fontWeight: 'bold' }
  }, {
    text: '${date} · 赛道竞争分析',
    left: 'center', top: 68,
    textStyle: { color: 'rgba(255,255,255,0.4)', fontSize: 20 }
  }],
  tooltip: { show: false },
  grid: { left: 120, right: 80, top: 130, bottom: 80 },
  xAxis: {
    name: '竞争强度（作品数）→',
    nameLocation: 'center', nameGap: 40,
    nameTextStyle: { color: 'rgba(255,255,255,0.6)', fontSize: 16 },
    splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)', type: 'dashed' } },
    axisLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 14 },
    axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
    min: 0, max: maxX
  },
  yAxis: {
    name: '↑ 平均互动(万)',
    nameLocation: 'end',
    nameTextStyle: { color: 'rgba(255,255,255,0.6)', fontSize: 16 },
    splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)', type: 'dashed' } },
    axisLabel: { color: 'rgba(255,255,255,0.4)', fontSize: 14 },
    axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } },
    min: 0, max: maxY
  },
  graphic: [{
    type: 'text', left: 80, top: 108,
    style: {
      text: '🔵 蓝海机会', fill: 'rgba(66,165,245,0.7)',
      font: 'bold 22px PingFang SC'
    },
    silent: true
  }, {
    type: 'text', right: 60, top: 108,
    style: {
      text: '🔴 红海激战', fill: 'rgba(239,83,80,0.7)',
      font: 'bold 22px PingFang SC'
    },
    silent: true
  }, {
    type: 'text', left: 80, bottom: 58,
    style: {
      text: '❄️ 冰海区', fill: 'rgba(120,144,156,0.5)',
      font: '20px PingFang SC'
    },
    silent: true
  }, {
    type: 'text', right: 60, bottom: 58,
    style: {
      text: '⚠️ 内卷区', fill: 'rgba(255,152,0,0.5)',
      font: '20px PingFang SC'
    },
    silent: true
  }, {
    type: 'line',
    shape: { x1: 120, y1: 0, x2: 120, y2: 1080 },
    style: { stroke: 'rgba(255,255,255,0.08)', lineWidth: 1, lineDash: [6, 4] },
    left: '50%', top: 130, bottom: 80
  }],
  series: [{
    type: 'scatter',
    data: scatterData,
    symbolSize: function(data) {
      return Math.max(35, Math.min(85, Math.sqrt(data[2]) * 4));
    },
    label: {
      show: true, position: 'inside',
      formatter: function(p) { return p.data[3]; },
      color: '#fff', fontSize: 15, fontWeight: 'bold',
      textShadowColor: 'rgba(0,0,0,0.8)', textShadowBlur: 4
    },
    itemStyle: {
      opacity: 0.85,
      borderWidth: 2,
      borderColor: 'rgba(255,255,255,0.3)',
      color: function(p) {
        var x = p.data[0], y = p.data[1];
        if (x > medianX && y > medianY) return new echarts.graphic.RadialGradient(0.5, 0.5, 0.8, [
          { offset: 0, color: '#ff6b6b' }, { offset: 1, color: '#ef5350' }
        ]);
        if (x <= medianX && y > medianY) return new echarts.graphic.RadialGradient(0.5, 0.5, 0.8, [
          { offset: 0, color: '#64b5f6' }, { offset: 1, color: '#42a5f5' }
        ]);
        if (x > medianX && y <= medianY) return new echarts.graphic.RadialGradient(0.5, 0.5, 0.8, [
          { offset: 0, color: '#ffb74d' }, { offset: 1, color: '#ff9800' }
        ]);
        return new echarts.graphic.RadialGradient(0.5, 0.5, 0.8, [
          { offset: 0, color: '#a0a8b0' }, { offset: 1, color: '#78909c' }
        ]);
      }
    },
    animationType: 'scale',
    animationDuration: 1200,
    animationDelay: function(idx) { return idx * 400 + 800; },
    animationEasing: 'elasticOut',
    markLine: {
      silent: true, symbol: 'none',
      lineStyle: { color: 'rgba(255,255,255,0.12)', type: 'dashed', width: 1.5 },
      label: { show: false },
      data: [
        { xAxis: medianX },
        { yAxis: medianY }
      ],
      animationDuration: 600,
      animationDelay: 500
    }
  }]
});
</script></body></html>`;
}

/* ═══════════════ Playwright 视频录制 ═══════════════ */

async function recordChartVideo(htmlContent, outputMp4, durationMs, tmpDir) {
  const htmlPath = path.resolve(tmpDir, `chart_${Date.now()}.html`);
  fs.writeFileSync(htmlPath, htmlContent, 'utf-8');

  const recDir = path.resolve(tmpDir, 'chart_recordings');
  ensureDir(recDir);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: CHART_W, height: CHART_H },
    recordVideo: { dir: recDir, size: { width: CHART_W, height: CHART_H } },
  });

  const page = await context.newPage();
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });
  // 等待 ECharts 初始化 + 动画播放
  await page.waitForTimeout(durationMs);

  // 关闭以保存视频
  const video = page.video();
  await page.close();
  const webmPath = await video.path();
  await context.close();
  await browser.close();

  // webm → mp4 (libx264, 30fps)
  execSync(
    `ffmpeg -y -i "${webmPath}" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -r 30 "${outputMp4}" 2>/dev/null`
  );

  // 清理临时文件
  try { fs.unlinkSync(webmPath); } catch {}
  try { fs.unlinkSync(htmlPath); } catch {}

  return outputMp4;
}

/* ═══════════════ 解说文案生成 ═══════════════ */

export function buildChartNarrations(analysis) {
  const tags = analysis.tags;
  if (!tags.length) return { klineText: '', oceanText: '' };

  const top1 = tags[0];  // 最多作品
  const hottest = tags.slice().sort((a, b) => b.avgHeat - a.avgHeat)[0]; // 最高热度

  // ─── K线解说 ───
  const bullish = tags.filter(t => t.avgHeat > analysis.overallAvgHeat);
  const bearish = tags.filter(t => t.avgHeat <= analysis.overallAvgHeat);

  let klineText = `从赛道K线来看，`;
  if (bullish.length) {
    klineText += `${bullish.slice(0, 3).map(t => t.name).join('、')}赛道热度高于均值，是当前的强势赛道。`;
  }
  if (top1) {
    klineText += `${top1.name}以${top1.count}部作品数量领跑，`;
  }
  if (hottest && hottest.name !== top1?.name) {
    klineText += `而${hottest.name}虽然只有${hottest.count}部，但平均热度最高。`;
  }
  if (bearish.length >= 2) {
    klineText += `${bearish.slice(0, 2).map(t => t.name).join('、')}等赛道热度低于均值，竞争缓和，存在差异化空间。`;
  }

  // ─── 红海蓝海解说 ───
  // 用作品数量中位数+1作为竞争分界，热度均值作为热度分界
  const sortedCounts = tags.map(t => t.count).sort((a, b) => a - b);
  const medianCount = sortedCounts[Math.floor(sortedCounts.length / 2)] || 2;
  const threshold = Math.max(medianCount + 1, 3); // 至少3部才算高竞争

  const redOcean = tags.filter(t => t.count >= threshold && t.avgHeat > analysis.overallAvgHeat);
  const blueOcean = tags.filter(t => t.count < threshold && t.avgHeat > analysis.overallAvgHeat);
  const saturated = tags.filter(t => t.count >= threshold && t.avgHeat <= analysis.overallAvgHeat);
  const niche = tags.filter(t => t.count < threshold && t.avgHeat <= analysis.overallAvgHeat);

  let oceanText = `红海蓝海分析显示，`;
  if (redOcean.length) {
    oceanText += `${redOcean.map(t => t.name).join('、')}属于红海赛道，竞争激烈但流量确实大。`;
  }
  if (blueOcean.length) {
    oceanText += `${blueOcean.map(t => t.name).join('、')}是值得关注的蓝海机会，作品不多但互动数据亮眼。`;
  }
  if (saturated.length) {
    oceanText += `${saturated.slice(0, 2).map(t => t.name).join('、')}竞争多但热度一般，属于内卷区。`;
  }
  if (!redOcean.length && !blueOcean.length) {
    oceanText += `目前各赛道竞争格局尚不明朗。`;
  }
  oceanText += `建议新创作者优先关注蓝海赛道，用差异化内容破圈。`;

  return { klineText, oceanText };
}

/* ═══════════════ 黑马解说文案 ═══════════════ */

export function buildDarkHorseNarration(items, date) {
  const now = new Date(date).getTime() / 1000;
  const withSpeed = items
    .filter(it => it.create_time && it.create_time > 0)
    .map(it => {
      const days = Math.max(1, (now - it.create_time) / 86400);
      return { ...it, days: +days.toFixed(1), dailyEngagement: Math.round((it.liked_count + it.share_count) / days) };
    })
    .sort((a, b) => b.dailyEngagement - a.dailyEngagement);

  if (withSpeed.length < 2) return '';

  const champ = withSpeed[0];
  const shortTitle = (champ.title || '').split(/[#\n]/)[0].trim().substring(0, 18);
  const fmtSpeed = n => n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);

  return `本期黑马！${shortTitle}，仅${Math.round(champ.days)}天日均互动${fmtSpeed(champ.dailyEngagement)}，增速断层第一。一起看完整榜单。`;
}

/* ═══════════════ 主入口 ═══════════════ */

/**
 * 渲染动画图表为视频文件
 * @param {Array} items - 完整排行数据
 * @param {string} tmpDir - 临时目录
 * @param {string} date - 日期标签
 * @returns {Array<{type, videoPath, narration, label}>}
 */
export async function renderCharts(items, tmpDir, date) {
  const analysis = analyzeAllTags(items);
  console.log(`  📊 标签分析: ${analysis.tags.length} 个赛道, ${analysis.formats.length} 种形式, ${analysis.tools.length} 种工具`);

  const echartsCode = await getEchartsLib(tmpDir);
  if (!echartsCode) {
    console.log('  ⚠️ 无法获取 ECharts 库，跳过图表渲染');
    return [];
  }

  const narrations = buildChartNarrations(analysis);
  const darkHorseText = buildDarkHorseNarration(items, date);
  const chartDir = path.join(tmpDir, 'charts');
  ensureDir(chartDir);
  const results = [];

  // ─── Chart 1: K线热度图 ───
  const klineMp4 = path.join(chartDir, 'kline_chart.mp4');
  if (fs.existsSync(klineMp4) && fs.statSync(klineMp4).size > 10000) {
    console.log('  ✅ K线图 (cached)');
    results.push({ type: 'chart_kline', videoPath: klineMp4, narration: narrations.klineText, label: '📈 赛道K线热度图' });
  } else {
    const html = buildKlineHTML(analysis, echartsCode, date);
    if (html) {
      try {
        console.log('  🎬 录制K线图动画...');
        await recordChartVideo(html, klineMp4, RECORD_DURATION_MS, tmpDir);
        console.log('  ✅ K线图完成');
        results.push({ type: 'chart_kline', videoPath: klineMp4, narration: narrations.klineText, label: '📈 赛道K线热度图' });
      } catch (e) { console.log(`  ❌ K线图失败: ${(e.message || '').substring(0, 200)}`); }
    }
  }

  // ─── Chart 2: 红海蓝海矩阵 ───
  const oceanMp4 = path.join(chartDir, 'ocean_chart.mp4');
  if (fs.existsSync(oceanMp4) && fs.statSync(oceanMp4).size > 10000) {
    console.log('  ✅ 红海蓝海矩阵 (cached)');
    results.push({ type: 'chart_ocean', videoPath: oceanMp4, narration: narrations.oceanText, label: '🎯 红海蓝海机会矩阵' });
  } else {
    const html = buildOceanHTML(analysis, echartsCode, date);
    if (html) {
      try {
        console.log('  🎬 录制红海蓝海矩阵动画...');
        await recordChartVideo(html, oceanMp4, RECORD_DURATION_MS, tmpDir);
        console.log('  ✅ 红海蓝海矩阵完成');
        results.push({ type: 'chart_ocean', videoPath: oceanMp4, narration: narrations.oceanText, label: '🎯 红海蓝海机会矩阵' });
      } catch (e) { console.log(`  ❌ 红海蓝海矩阵失败: ${(e.message || '').substring(0, 200)}`); }
    }
  }

  // ─── Chart 3: 黑马飙升榜（最后） ───
  const horseMp4 = path.join(chartDir, 'darkhorse_chart.mp4');
  if (fs.existsSync(horseMp4) && fs.statSync(horseMp4).size > 10000) {
    console.log('  ✅ 黑马飙升榜 (cached)');
    results.push({ type: 'chart_darkhorse', videoPath: horseMp4, narration: darkHorseText, label: '🐴 黑马飙升榜' });
  } else {
    const html = buildDarkHorseHTML(items, echartsCode, date);
    if (html) {
      try {
        console.log('  🎬 录制黑马飙升榜动画...');
        await recordChartVideo(html, horseMp4, RECORD_DURATION_MS, tmpDir);
        console.log('  ✅ 黑马飙升榜完成');
        results.push({ type: 'chart_darkhorse', videoPath: horseMp4, narration: darkHorseText, label: '🐴 黑马飙升榜' });
      } catch (e) { console.log(`  ❌ 黑马飙升榜失败: ${(e.message || '').substring(0, 200)}`); }
    }
  }

  return results;
}
