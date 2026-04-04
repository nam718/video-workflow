// 搜索红果短剧中的已知 AI 短剧
// 以及查找是否有 AI 相关的筛选接口

// 1. 在 category 页面中搜索已知 AI 短剧名
const knownAIDramas = ['霍去病', '三星堆', '万象', '山海经', '封神', '西游'];

const res = await fetch('https://www.hongguoduanju.com/category', {
  headers: {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'}
});
const html = await res.text();
const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
const data = JSON.parse(m[1]);
const pg = data.loaderData?.category_page || {};
const allDramas = pg.recommendList || [];
console.log('红果短剧总数:', allDramas.length);

// 搜索已知 AI 短剧
console.log('\n=== 搜索已知 AI 短剧 ===');
for (const name of knownAIDramas) {
  const found = allDramas.filter(d => d.series_name.includes(name));
  if (found.length) {
    for (const d of found) {
      console.log(`  ✅ ${d.series_name} | ${(d.tags||[]).join(',')} | ${d.episode_right_text}`);
    }
  } else {
    console.log(`  ❌ "${name}" 未找到`);
  }
}

// 2. 尝试 category API with different tab/filter params
console.log('\n=== 尝试分类 API ===');
const selectorList = pg.selectorList || [];
for (const sel of selectorList) {
  console.log(`${sel.row_name}: ${(sel.items||[]).map(i=>i.show_name+'('+i.selector_item_id+')').join(', ')}`);
}

// 3. 试试搜索 API
console.log('\n=== 搜索 API ===');
for (const kw of ['AI短剧', 'AI', '霍去病']) {
  try {
    const r = await fetch(`https://www.hongguoduanju.com/search?keyword=${encodeURIComponent(kw)}`, {
      headers: {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'}
    });
    const h = await r.text();
    const mm = h.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
    if (mm) {
      const d = JSON.parse(mm[1]);
      const sp = d.loaderData || {};
      for (const [k, v] of Object.entries(sp)) {
        if (!v || typeof v !== 'object') continue;
        // 找搜索结果
        for (const [k2, v2] of Object.entries(v)) {
          if (Array.isArray(v2) && v2.length > 0 && v2[0].series_name) {
            console.log(`  "${kw}": ${v2.length} 结果`);
            for (const item of v2.slice(0, 5)) {
              console.log(`    - ${item.series_name} | ${(item.tags||[]).join(',')}`);
            }
          }
        }
      }
    } else {
      console.log(`  "${kw}": 搜索页无 SSR (可能是客户端渲染)`);
    }
  } catch(e) {
    console.log(`  "${kw}": 失败 - ${e.message}`);
  }
}

// 4. 尝试看看抖音 AI 短剧话题能不能获取数据
console.log('\n=== 抖音 AI 短剧话题 ===');
try {
  const r = await fetch('https://www.douyin.com/hashtag/AI%E7%9F%AD%E5%89%A7', {
    headers: {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'},
    redirect: 'follow',
  });
  console.log('  抖音状态:', r.status, r.statusText);
  if (r.ok) {
    const h = await r.text();
    const hasData = h.includes('_ROUTER_DATA') || h.includes('RENDER_DATA');
    console.log('  有可解析数据:', hasData);
  }
} catch(e) {
  console.log('  失败:', e.message);
}
