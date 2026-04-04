// B站搜索 AI 短剧 - 提取热门视频
import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = import.meta.dirname;
const DATA_DIR = path.join(SCRIPT_DIR, 'data');
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
ensureDir(DATA_DIR);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

async function searchBili(keyword, page = 1) {
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&order=click&page=${page}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  return r.json();
}

console.log('╔══════════════════════════════════════╗');
console.log('║  B站 AI 短剧 热门搜索               ║');
console.log('╚══════════════════════════════════════╝\n');

const allResults = [];

// 多关键词搜索
const keywords = ['AI短剧', 'AI短剧 热门', 'AIGC短剧', 'AI生成短剧'];
for (const kw of keywords) {
  console.log(`🔍 搜索: "${kw}"`);
  try {
    const data = await searchBili(kw);
    if (data.code === 0 && data.data?.result?.length) {
      const results = data.data.result;
      console.log(`  ✅ ${results.length} 个结果\n`);
      for (const item of results) {
        const title = item.title.replace(/<[^>]+>/g, '');
        const play = item.play ?? 0;
        const author = item.author || '';
        const duration = item.duration || '';
        const bvid = item.bvid || '';
        const icon = play > 100000 ? '🔥' : play > 10000 ? '📺' : '▫️';
        if (!allResults.find(r => r.bvid === bvid)) {
          allResults.push({
            title, play, author, duration, bvid,
            arcurl: item.arcurl || '',
            pic: item.pic || '',
            description: item.description || '',
            tag: item.tag || '',
            pubdate: item.pubdate || 0,
          });
        }
      }
    } else {
      console.log(`  ⚠️ code=${data.code} msg=${data.message}\n`);
    }
  } catch(e) {
    console.log(`  ❌ ${e.message}\n`);
  }
}

// 排序: 按播放量降序
allResults.sort((a, b) => b.play - a.play);

console.log(`\n${'='.repeat(60)}`);
console.log(`  AI 短剧热门排行 (共 ${allResults.length} 个视频)\n`);

for (let i = 0; i < Math.min(allResults.length, 30); i++) {
  const v = allResults[i];
  const icon = v.play > 100000 ? '🔥' : v.play > 10000 ? '📺' : '▫️';
  const playStr = v.play > 10000 ? (v.play / 10000).toFixed(1) + '万' : v.play;
  console.log(`  ${String(i + 1).padStart(2)}. ${icon} ${v.title.slice(0, 45).padEnd(45)} | ${v.author.slice(0, 10).padEnd(10)} | ${playStr}播放 | ${v.duration}`);
}

// 保存
const outPath = path.join(DATA_DIR, `bili_ai_${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  source: 'bilibili_search',
  queryDate: new Date().toISOString().slice(0, 10),
  keywords,
  count: allResults.length,
  data: allResults,
}, null, 2));
console.log(`\n💾 已保存: ${outPath}`);
