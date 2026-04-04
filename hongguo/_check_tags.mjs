// 检查红果短剧平台的所有标签，看有没有 AI 短剧分类
import fs from 'fs';

const res = await fetch('https://www.hongguoduanju.com/', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
});
const html = await res.text();
const match = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
const data = JSON.parse(match[1]);
const home = data.loaderData?.home_page?.homeData?.detail;

// 所有标签
const allTags = new Set();
for (const item of (home?.list || [])) {
  for (const t of (item.tags || [])) allTags.add(t);
}
console.log('=== 所有标签 (共' + allTags.size + '个) ===');
console.log([...allTags].sort().join(', '));

// 搜索 AI 相关
console.log('\n=== AI相关剧集 ===');
const aiItems = (home?.list || []).filter(item => {
  const s = JSON.stringify(item).toLowerCase();
  return s.includes('ai') || s.includes('虚拟') || s.includes('数字人');
});
console.log('数量:', aiItems.length);
for (const item of aiItems.slice(0, 20)) {
  console.log(` - ${item.series_name} | ${(item.tags || []).join(', ')}`);
}

// 检查有没有分类页面
console.log('\n=== 页面结构 ===');
const pages = data.loaderData || {};
for (const [key, val] of Object.entries(pages)) {
  if (val && typeof val === 'object') {
    const keys = Object.keys(val).join(', ');
    console.log(`${key}: ${keys}`);
  }
}

// 检查是否有 category 或 rank 的 URL
const links = html.match(/href="\/[^"]*"/g) || [];
const unique = [...new Set(links)].filter(l => l.includes('rank') || l.includes('categ') || l.includes('list') || l.includes('ai') || l.includes('tab'));
console.log('\n=== 相关链接 ===');
unique.forEach(l => console.log(l));
