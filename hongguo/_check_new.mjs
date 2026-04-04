import fs from 'fs';
const MC_DIR = '/Users/nanhaoquan/video-workflow/MediaCrawler/data/douyin/json';
const files = fs.readdirSync(MC_DIR).filter(f => f.startsWith('search_contents_') && f.endsWith('.json')).sort();
let data = [];
for (const f of files) { data.push(...JSON.parse(fs.readFileSync(MC_DIR + '/' + f, 'utf8'))); }
console.log('合并总条数:', data.length);
const seen = new Set();
const d = data.filter(x => { if (seen.has(x.aweme_id)) return false; seen.add(x.aweme_id); return true; });
console.log('去重后:', d.length);
const cutoff18 = new Date('2026-03-18T00:00:00+08:00').getTime() / 1000;
const since18 = d.filter(x => parseInt(x.create_time || 0, 10) >= cutoff18);
console.log('3/18后:', since18.length);
const num = v => parseInt(v, 10) || 0;
since18.sort((a, b) => {
  const ha = num(a.liked_count) + num(a.share_count) * 3 + num(a.collected_count) * 2;
  const hb = num(b.liked_count) + num(b.share_count) * 3 + num(b.collected_count) * 2;
  return hb - ha;
});
since18.forEach((x, i) => {
  const ct = new Date(parseInt(x.create_time) * 1000);
  const dateStr = `${ct.getMonth() + 1}/${ct.getDate()} ${ct.getHours()}:${String(ct.getMinutes()).padStart(2, '0')}`;
  const ep = (x.title || '').match(/第(\d+)集|[eE][pP](\d+)|(\d+)集/);
  const epStr = ep ? ' 第' + (ep[1] || ep[2] || ep[3]) + '集' : '';
  const heat = num(x.liked_count) + num(x.share_count) * 3 + num(x.collected_count) * 2;
  console.log(`${i + 1}. ${dateStr} | 👍${x.liked_count} 🔄${x.share_count} | 热度${heat}${epStr} | ${(x.title || '').slice(0, 50)}`);
});
