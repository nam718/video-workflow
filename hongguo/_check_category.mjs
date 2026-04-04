// 检查红果短剧分类页面数据
import fs from 'fs';

const res = await fetch('https://www.hongguoduanju.com/category', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
});
const html = await res.text();
const match = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
const data = JSON.parse(match[1]);
const pg = data.loaderData || {};

for (const [k, v] of Object.entries(pg)) {
  if (!v || typeof v !== 'object') continue;
  console.log('=== ' + k + ' ===');
  for (const [k2, v2] of Object.entries(v)) {
    if (Array.isArray(v2)) {
      console.log('  ' + k2 + ': Array[' + v2.length + ']');
      if (v2.length > 0) console.log('    [0]:', JSON.stringify(v2[0]).slice(0, 300));
    } else if (typeof v2 === 'object' && v2) {
      console.log('  ' + k2 + ': {' + Object.keys(v2).join(', ') + '}');
    } else {
      console.log('  ' + k2 + ':', String(v2).slice(0, 100));
    }
  }
}

// 检查其他可能的页面: /rank, /search
for (const path of ['/rank', '/search?keyword=AI短剧', '/search?keyword=AI']) {
  try {
    const r = await fetch('https://www.hongguoduanju.com' + path, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
    });
    const h = await r.text();
    const m = h.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
    if (m) {
      const d = JSON.parse(m[1]);
      const pages = d.loaderData || {};
      console.log('\n=== ' + path + ' ===');
      for (const [pk, pv] of Object.entries(pages)) {
        if (!pv || typeof pv !== 'object') continue;
        const s = JSON.stringify(pv);
        console.log('  page:', pk, '(' + s.length + ' chars)');
        // 看有没有 AI 相关
        if (s.toLowerCase().includes('ai')) console.log('  >>> 含有 AI 关键词');
        for (const [k2, v2] of Object.entries(pv)) {
          if (Array.isArray(v2) && v2.length > 0) {
            console.log('  ' + k2 + ': Array[' + v2.length + ']');
            console.log('    [0]:', JSON.stringify(v2[0]).slice(0, 300));
          }
        }
      }
    } else {
      console.log('\n=== ' + path + ' === (无 _ROUTER_DATA)');
    }
  } catch (e) {
    console.log('\n=== ' + path + ' === ERROR:', e.message);
  }
}
