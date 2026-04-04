const res = await fetch('https://www.hongguoduanju.com/category', {
  headers: {'User-Agent': 'Mozilla/5.0'}
});
const html = await res.text();
const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
const d = JSON.parse(m[1]);
const pg = d.loaderData?.category_page || {};
const sl = pg.selectorList || [];
for (const s of sl) {
  const items = (s.items||[]).map(i=>i.show_name).join(', ');
  console.log(s.row_name + ': ' + items);
}

// search AI
console.log('\n--- search AI ---');
const all = pg.recommendList || [];
const ai = all.filter(item => {
  const s = JSON.stringify(item).toLowerCase();
  return s.includes('ai') || s.includes('虚拟') || s.includes('数字人');
});
console.log('AI related:', ai.length, 'of', all.length);
ai.slice(0,10).forEach(i => console.log(' -', i.series_name, (i.tags||[]).join(',')));

// try rank page  
console.log('\n--- rank page ---');
const r2 = await fetch('https://www.hongguoduanju.com/rank', { headers: {'User-Agent': 'Mozilla/5.0'} });
const h2 = await r2.text();
const m2 = h2.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
if (m2) {
  const d2 = JSON.parse(m2[1]);
  const pages = Object.keys(d2.loaderData || {});
  console.log('pages:', pages.join(', '));
} else { 
  console.log('no SSR data on /rank');
}
