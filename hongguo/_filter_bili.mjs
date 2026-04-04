// 过滤 B站 AI 短剧搜索结果，只保留真正的 AI 短剧作品
import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = import.meta.dirname;
const DATA_DIR = path.join(SCRIPT_DIR, 'data');

// 加载搜索结果
const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('bili_ai_')).sort().reverse();
if (!files.length) { console.log('无数据'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, files[0]), 'utf8'));
const all = data.data;

// 排除关键词 (教程、评论、非短剧)
const excludePatterns = [
  /教程|教学|手把手|从0到1|入门|零基础|保姆级|学习|系统教程/,
  /锐评|点评|分析|拆解|盘点|科普|测评/,
  /制作官方|制作教|生成教|SD-官方|comfyui|stable.?diffusion/i,
  /赚钱|变现|秘籍|月入|日入|收入/,
  /^【全\d+集】.*教程/,
];

const includePatterns = [
  /第[一二三四五六七八九十\d]+集|全\d+集|EP\d|ep\d/i,
  /短剧|剧场|小剧场|科幻|冒险|悬疑|武侠|古装|穿越/,
  /AI漫剧|AIGC.*剧|AI.*制作.*剧|AI原创/i,
  /山海经|霍去病|哀牢山|觉醒|封神|西游|三国|三体|流浪地球/,
];

const filtered = all.filter(item => {
  const text = item.title + ' ' + item.description + ' ' + item.tag;
  // 排除教程类
  if (excludePatterns.some(p => p.test(text))) return false;
  // 包含短剧特征的优先
  return true;
}).filter(item => {
  // 时长过滤: 真正的短剧通常 > 30s
  const parts = (item.duration || '0:0').split(':').map(Number);
  const seconds = parts.length === 3 ? parts[0]*3600+parts[1]*60+parts[2] : parts[0]*60+(parts[1]||0);
  return seconds >= 30;
});

// 按播放量排序
filtered.sort((a, b) => b.play - a.play);

console.log('╔══════════════════════════════════════════════╗');
console.log('║  B站 AI 短剧作品排行 (过滤后)               ║');
console.log('╚══════════════════════════════════════════════╝\n');
console.log(`  总搜索: ${all.length} | 过滤后: ${filtered.length}\n`);

for (let i = 0; i < Math.min(filtered.length, 30); i++) {
  const v = filtered[i];
  const playStr = v.play > 10000 ? (v.play / 10000).toFixed(1) + '万' : v.play;
  const icon = v.play > 100000 ? '🔥' : v.play > 10000 ? '📺' : '▫️';
  console.log(`  ${String(i + 1).padStart(2)}. ${icon} ${v.title.slice(0, 50)}`);
  console.log(`      ${v.author} | ${playStr}播放 | ${v.duration} | ${v.tag?.slice(0, 40)}`);
  console.log(`      https://www.bilibili.com/video/${v.bvid}`);
  console.log();
}

// 保存过滤后的排行
const outPath = path.join(DATA_DIR, `bili_ai_filtered_${data.queryDate}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  source: 'bilibili_ai_drama_filtered',
  queryDate: data.queryDate,
  count: filtered.length,
  data: filtered,
}, null, 2));
console.log(`💾 已保存: ${outPath}`);
