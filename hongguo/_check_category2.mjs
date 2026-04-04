// 提取分类页筛选器列表
import fs from 'fs';

const res = await fetch('https://www.hongguoduanju.com/category', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
});
const html = await res.text();
const match = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
const data = JSON.parse(match[1]);
const pg = data.loaderData?.category_page || {};

// 所有筛选器
const selectorList = pg.selectorList || [];
console.log('=== 筛选器 (' + selectorList.length + '个) ===');
for (const sel of selectorList) {
  const items = (sel.items || []).map(i => i.show_name).join(', ');
  console.log(sel.row_id + '. ' + sel.row_name + ': ' + items);
}

// 搜索 AI 关键词
const allItems = (pg.recommendList || []);
console.log('\n=== 总计 ' + allItems.length + ' 部剧 ===');

// 找 AI 相关
const aiDramas = allItems.filter(item => {
  const s = (item.series_name + ' ' + item.series_intro + ' ' + (item.tags || []).join(' ')).toLowerCase();
  return s.includes('ai') || s.includes('虚拟') || s.includes('数字人') || s.includes('人工智能');
});
console.log('\n=== AI相关 (' + aiDramas.length + '部) ===');
for (const d of aiDramas.slice(0, 20)) {
  console.log(' - ' + d.series_name + ' | ' + (d.tags || []).join(', '));
}

// 试试搜索 AI 短剧
console.log('\n=== 搜索 AI 短剧 ===');
try {
  const r2 = await fetch('https://www.hongguoduanju.com/search?keyword=AI%E7%9F%AD%E5%89%A7', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
  });
  const h2 = await r2.text();
  const m2 = h2.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (m2) {
    const d2 = JSON.parse(m2[1]);
    const sp = d2.loaderData?.search_page || d2.loaderData?.page || {};
    for (const [k, v] of Object.entries(sp)) {
      if (Array.isArray(v) && v.length) {
        console.log(k + ': ' + v.length + ' results');
        for (const item of v.slice(0, 5)) {
          console.log('  - ' + (item.series_name || item.name || JSON.stringify(item).slice(0, 100)));
        }
      }
    }
    if (Object.keys(sp).length === 0) {
      // 尝试其他结构
      for (const [k, v] of Object.entries(d2.loaderData || {})) {
        const s = JSON.stringify(v || {});
        if (s.length > 100) console.log(' page: ' + k + ' (' + s.length + ' chars)');
      }
    }
  } else {
    console.log('  搜索页无 SSR 数据');
  }
} catch (e) {
  console.log('  搜索失败: ' + e.message);
}

// 试试 /rank 页面
console.log('\n=== 排行页 /rank ===');
try {
  const r3 = await fetch('https://www.hongguoduanju.com/rank', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
  });
  const h3 = await r3.text();
  const m3 = h3.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (m3) {
    const d3 = JSON.parse(m3[1]);
    for (const [k, v] of Object.entries(d3.loaderData || {})) {
      if (!v || typeof v !== 'object') continue;
      console.log(' page: ' + k);
      for (const [k2, v2] of Object.entries(v)) {
        if (Array.isArray(v2)) {
          console.log('   ' + k2 + ': Array[' + v2.length + ']');
          if (v2[0]) console.log('     [0]:', JSON.stringify(v2[0]).slice(0, 200));
        } else if (typeof v2 === 'string') {
          console.log('   ' + k2 + ': ' + v2.slice(0, 100));
        }
      }
    }
  } else {
    console.log('  排行页无 SSR 数据');
  }
} catch (e) {
  console.log('  失败: ' + e.message);
}
