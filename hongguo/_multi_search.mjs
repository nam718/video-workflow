/**
 * 多源搜索 AI 短剧
 * 1. 红果短剧: 可能有隐藏的 API 参数
 * 2. Bilibili: 搜索 AI短剧
 * 3. 红果短剧 category API 枚举 tab 参数
 */
import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = import.meta.dirname;
const DATA_DIR = path.join(SCRIPT_DIR, 'data');
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
ensureDir(DATA_DIR);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  return r.json();
}

async function fetchHTML(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  return r.text();
}

// ===== 1. B站搜索 AI 短剧 =====
async function searchBilibili() {
  console.log('=== Bilibili 搜索 "AI短剧" ===');
  try {
    const data = await fetchJSON(
      'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=AI%E7%9F%AD%E5%89%A7&order=click&page=1'
    );
    if (data.code === 0 && data.data?.result?.length) {
      const results = data.data.result;
      console.log(`  ✅ ${results.length} 个结果`);
      for (const item of results.slice(0, 15)) {
        const title = item.title.replace(/<[^>]+>/g, '');
        const play = item.play || 0;
        const author = item.author || '';
        console.log(`  ${play > 10000 ? play > 100000 ? '🔥' : '📺' : '▫️'} ${title.slice(0, 40)} | ${author} | ${play}播放`);
      }
      return results;
    } else {
      console.log('  ⚠️ 需要 wbi 签名:', data.code, data.message);
      // 尝试不带 wbi 的旧接口
      const data2 = await fetchJSON(
        'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=AI%E7%9F%AD%E5%89%A7&order=click&page=1'
      );
      if (data2.code === 0 && data2.data?.result?.length) {
        console.log(`  ✅ (旧接口) ${data2.data.result.length} 个结果`);
        return data2.data.result;
      }
      console.log('  ⚠️ 旧接口也失败:', data2.code, data2.message);
    }
  } catch(e) {
    console.log('  ❌', e.message);
  }
  return [];
}

// ===== 2. 红果短剧分类页 - 枚举 tab 值 =====
async function searchHongguoTabs() {
  console.log('\n=== 红果短剧 分类 API 枚举 ===');
  // 已知 tab 值: 从 query params 看到 tab 是参数之一
  // 尝试常见的 tab 值
  const tabValues = ['ai', 'AI', 'ai_drama', 'aigc', 'virtual', '0', '1', '2', '3', '4', '5'];
  
  for (const tab of tabValues) {
    try {
      const html = await fetchHTML(`https://www.hongguoduanju.com/category?tab=${tab}`);
      const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
      if (m) {
        const data = JSON.parse(m[1]);
        const pg = data.loaderData?.category_page || {};
        const list = pg.recommendList || [];
        const tabLabel = pg.query?.tab;
        if (list.length > 0 && list.length < 491) {
          console.log(`  ✅ tab=${tab}: ${list.length} 部 (tabLabel=${tabLabel})`);
          console.log(`    前3: ${list.slice(0,3).map(d=>d.series_name).join(', ')}`);
        } else {
          console.log(`  ▫️ tab=${tab}: ${list.length} 部 (同全量)`);
        }
      }
    } catch(e) {
      console.log(`  ❌ tab=${tab}:`, e.message.slice(0,60));
    }
  }

  // 尝试 el 参数 (另一个 query key)
  console.log('\n  --- el 参数 ---');
  for (const el of ['ai', 'AI短剧', 'aigc']) {
    try {
      const html = await fetchHTML(`https://www.hongguoduanju.com/category?el=${encodeURIComponent(el)}`);
      const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
      if (m) {
        const data = JSON.parse(m[1]);
        const list = data.loaderData?.category_page?.recommendList || [];
        console.log(`  el=${el}: ${list.length} 部`);
      }
    } catch {}
  }
}

// ===== 3. 红果短剧 - 搜索接口探测 =====
async function searchHongguoAPI() {
  console.log('\n=== 红果短剧 搜索接口 ===');
  // 尝试可能的搜索 API
  const endpoints = [
    'https://www.hongguoduanju.com/search?keyword=AI',
    'https://www.hongguoduanju.com/api/search?keyword=AI',
    'https://api.hongguoduanju.com/search?keyword=AI',
  ];
  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('json')) {
        const data = await r.json();
        console.log(`  ✅ ${url.slice(0,60)}: JSON (${JSON.stringify(data).length} chars)`);
      } else {
        const html = await r.text();
        const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
        if (m) {
          const data = JSON.parse(m[1]);
          const pages = Object.keys(data.loaderData || {});
          console.log(`  ✅ ${url.slice(0,60)}: SSR, pages=[${pages.join(',')}]`);
          // 查找搜索结果
          for (const [k, v] of Object.entries(data.loaderData || {})) {
            if (v && typeof v === 'object') {
              for (const [k2, v2] of Object.entries(v)) {
                if (Array.isArray(v2) && v2.length > 0 && v2[0].series_name) {
                  console.log(`    ${k}.${k2}: ${v2.length} 个结果`);
                  v2.slice(0,3).forEach(i => console.log(`      - ${i.series_name}`));
                }
              }
            }
          }
        } else {
          console.log(`  ▫️ ${url.slice(0,60)}: HTML (${html.length} bytes, no SSR)`);
        }
      }
    } catch(e) {
      console.log(`  ❌ ${url.slice(0,60)}: ${e.message.slice(0,60)}`);
    }
  }
}

// ===== 执行 =====
await searchBilibili();
await searchHongguoTabs();
await searchHongguoAPI();
