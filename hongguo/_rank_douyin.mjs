import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MediaCrawler 数据目录（合并所有 search_contents 文件）
const MC_DIR = '/Users/nanhaoquan/video-workflow/MediaCrawler/data/douyin/json';
const srcFiles = fs.readdirSync(MC_DIR)
  .filter(f => f.startsWith('search_contents_') && f.endsWith('.json'))
  .sort();
if (!srcFiles.length) { console.error('❌ 未找到 MediaCrawler 搜索数据'); process.exit(1); }
const DATE = new Date().toISOString().slice(0, 10);
const OUT = path.join(__dirname, 'data', `douyin_ai_ranking_${DATE}.json`);

// 合并所有数据源
let data = [];
for (const f of srcFiles) {
  const items = JSON.parse(fs.readFileSync(path.join(MC_DIR, f), 'utf8'));
  data.push(...items);
  console.log(`📂 ${f}: ${items.length} 条`);
}
console.log(`📅 日期: ${DATE} | 合并: ${data.length} 条`);

// 只保留最近2天发布的（3/18凌晨起）
const RECENT_DAYS = 2;
const cutoffTs = new Date(DATE + 'T00:00:00+08:00').getTime() / 1000 - RECENT_DAYS * 86400;
data = data.filter(d => parseInt(d.create_time || 0, 10) >= cutoffTs);
console.log(`📌 最近${RECENT_DAYS}天内发布: ${data.length} 条`);

// 去重
const seen = new Set();
const unique = data.filter(d => {
  if (seen.has(d.aweme_id)) return false;
  seen.add(d.aweme_id);
  return true;
});
console.log(`去重: ${data.length} → ${unique.length}`);

// 过滤教程类 + 资讯 + 营销号 + 非原创
const tutKw = ['教程','教大家','教学','怎么做','如何做','零基础','新手也能','思路分享','10秒教','拆解','究竟是如何制作','全流程','制作流程','制作过程','练习AI'];
const newsKw = ['新规','过审','不过审','冲不垮','能否冲垮','能否取代','行业分析','行业报告','最先代替','会代替','取代','冲击','制作成本','高校','专业','招生'];
// 营销号/非原创剧情：纯引流话术、走流程分享、合集推荐、蹭热点
const spamKw = ['有福了','注意了','火了','走了下','走一下','流程分享','合集','盘点','你敢信','太炸了','必看','震惊','什么是真的','谁还在','剧宣','花絮','幕后'];
// 新闻/评论/吐槽/推荐（非AI短剧作品）
const nonDramaKw = ['感情是旧的','老公是新的','龙抬头','久等的','剧荒','好剧推荐','别再给我推','吐槽','口播','公告','规范','修订','焦虑','初入职场','热门短剧推荐','短剧推荐 #'];
const filtered = unique.filter(d => {
  const t = (d.title || d.desc || '');
  const nick = (d.nickname || '');
  if (tutKw.some(kw => t.includes(kw)) && (d.liked_count || 0) < 10000) return false;
  if (newsKw.some(kw => t.includes(kw))) return false;
  if (spamKw.some(kw => t.includes(kw))) return false;
  if (nonDramaKw.some(kw => t.includes(kw))) return false;
  // 营销号名/新闻号特征
  if (/娱乐|八卦|热点|资讯|剪辑号|帮忙$|新闻|报道/.test(nick)) return false;
  if ((d.liked_count || 0) < 5 && (d.share_count || 0) < 5) return false;
  return true;
});
console.log(`过滤后: ${filtered.length}`);

// 转数字 + 热度分
const num = v => parseInt(v, 10) || 0;
filtered.forEach(d => {
  d._likes = num(d.liked_count);
  d._shares = num(d.share_count);
  d._collects = num(d.collected_count);
  d._comments = num(d.comment_count);
  d.heat_score = d._likes + d._shares * 3 + d._collects * 2 + d._comments * 1.5;
});
filtered.sort((a, b) => b.heat_score - a.heat_score);

// 输出 TOP 20
console.log('\n========== 抖音 AI短剧 热度榜 ==========\n');
filtered.slice(0, 25).forEach((d, i) => {
  const fmt = n => (n || 0).toLocaleString();
  let title = (d.title || d.desc || '').split('\n')[0].substring(0, 60);
  console.log(`TOP ${i + 1} | 热度:${fmt(Math.round(d.heat_score))}`);
  console.log(`  ${title}`);
  console.log(`  作者: ${d.nickname}  👍${fmt(d._likes)} 🔄${fmt(d._shares)} ⭐${fmt(d._collects)} 💬${fmt(d._comments)}`);
  console.log(`  ${d.aweme_url}`);
  console.log(`  cover: ${d.cover_url || ''}`);
  console.log(`  video: ${d.video_download_url || ''}`);  
  console.log('');
});

// 提取集数
function extractEpisode(title) {
  const m = title.match(/第(\d+)集|[eE][pP](\d+)|(\d+)集/);
  return m ? parseInt(m[1] || m[2] || m[3], 10) : null;
}

// 标记最近2天新作
const rankTs = new Date(DATE + 'T00:00:00+08:00').getTime() / 1000;
const recentCount = filtered.filter(d => rankTs - num(d.create_time) < 2 * 86400).length;
console.log(`\n📌 最近2天新作: ${recentCount} 条`);

// 保存
const out = filtered.map((d, i) => ({
  rank: i + 1,
  title: (d.title || d.desc || '').split('\n')[0].substring(0, 80),
  nickname: d.nickname,
  aweme_id: d.aweme_id,
  aweme_url: d.aweme_url,
  liked_count: num(d.liked_count),
  share_count: num(d.share_count),
  collected_count: num(d.collected_count),
  comment_count: num(d.comment_count),
  heat_score: Math.round(d.heat_score),
  create_time: num(d.create_time),
  episode: extractEpisode((d.title || d.desc || '')),
}));
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\n已保存: ${OUT} (${out.length}条)`);
