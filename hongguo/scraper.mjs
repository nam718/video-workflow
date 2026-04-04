/**
 * 红果短剧排行榜爬虫
 *
 * 数据来源: hongguoduanju.com 首页 SSR 数据（无需认证）
 * 输出: data/ 目录下的 JSON 文件，格式兼容 video-maker
 *
 * 用法:
 *   node hongguo/scraper.mjs              # 爬取热门榜 TOP10
 *   node hongguo/scraper.mjs --top 20     # 爬取 TOP20
 *   node hongguo/scraper.mjs --detail     # 同时抓取详情（演员表等）
 */

import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = import.meta.dirname;
const DATA_DIR = path.join(SCRIPT_DIR, 'data');
const BASE_URL = 'https://www.hongguoduanju.com';

// ─── 解析命令行参数 ───────────────────────
const args = process.argv.slice(2);
const topN = parseInt(args.find((_, i, a) => a[i - 1] === '--top') || '10');
const withDetail = args.includes('--detail');

// ─── 工具函数 ─────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

function extractRouterData(html) {
  const match = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!match) throw new Error('未找到 _ROUTER_DATA');
  return JSON.parse(match[1]);
}

// ─── 首页热门列表 ─────────────────────────
async function fetchHotList() {
  console.log('  📡 正在获取红果短剧首页数据...');
  const html = await fetchPage(BASE_URL + '/');
  const routerData = extractRouterData(html);
  const page = routerData.loaderData?.page || {};

  const list = page.homeData?.detail?.list || [];
  console.log(`  ✅ 获取到 ${list.length} 部短剧`);
  return list;
}

// ─── 详情页数据 ─────────────────────────────
async function fetchDetail(seriesId) {
  const html = await fetchPage(`${BASE_URL}/detail?series_id=${seriesId}`);
  const routerData = extractRouterData(html);
  return routerData.loaderData?.detail_page?.seriesDetail || null;
}

// ─── 转换为统一数据格式 ───────────────────
function normalizeItem(item, rank, detail) {
  return {
    ranking: rank,
    playletName: item.series_name,
    playletId: item.series_id,
    coverOss: item.series_cover,
    playletTags: item.tags || [],
    episodeCount: item.episode_right_text || '',
    intro: item.series_intro || detail?.series_intro || '',
    celebrities: detail?.celebrities || [],
    source: '红果短剧',
  };
}

// ─── 保存数据 ─────────────────────────────
function saveData(items) {
  ensureDir(DATA_DIR);
  const today = new Date().toISOString().slice(0, 10);
  const filePath = path.join(DATA_DIR, `hot_${today}.json`);
  const payload = {
    source: '红果短剧',
    rankName: '热门榜',
    queryDate: today,
    count: items.length,
    scrapedAt: new Date().toISOString(),
    data: items,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  console.log(`  💾 已保存: ${filePath}`);
  return filePath;
}

// ─── 主流程 ───────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  红果短剧热门榜爬虫 TOP${topN}        ║`);
  console.log(`╚══════════════════════════════════╝\n`);

  const hotList = await fetchHotList();
  const top = hotList.slice(0, topN);

  const results = [];
  for (let i = 0; i < top.length; i++) {
    const item = top[i];
    let detail = null;
    if (withDetail) {
      console.log(`  🔍 [${i + 1}/${top.length}] 获取详情: ${item.series_name}`);
      try {
        detail = await fetchDetail(item.series_id);
      } catch (e) {
        console.log(`  ⚠️ 详情获取失败: ${e.message}`);
      }
    }
    results.push(normalizeItem(item, i + 1, detail));
  }

  const savedPath = saveData(results);

  console.log('\n  📊 TOP10 预览:');
  results.slice(0, 10).forEach(item => {
    const tags = item.playletTags.slice(0, 3).join(' · ');
    console.log(`  ${String(item.ranking).padStart(2)}. ${item.playletName}  [${item.episodeCount}]  ${tags}`);
  });

  console.log(`\n  ✅ 完成！共 ${results.length} 条数据\n`);
  return savedPath;
}

main().catch(e => {
  console.error('❌ 爬取失败:', e.message);
  process.exit(1);
});
