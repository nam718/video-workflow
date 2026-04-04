import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'MediaCrawler', 'data', 'douyin', 'json', 'search_contents_2026-03-19.json');
const RANKING = path.join(__dirname, 'data', 'douyin_ai_ranking_2026-03-19.json');
const CLIP_DIR = path.join(__dirname, 'clips_ai');

fs.mkdirSync(CLIP_DIR, { recursive: true });

// 读排行榜（已去重排序）
const ranking = JSON.parse(fs.readFileSync(RANKING, 'utf8'));
// 读原始数据（含 video_download_url）
const rawData = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const rawMap = new Map();
rawData.forEach(d => { if (!rawMap.has(d.aweme_id)) rawMap.set(d.aweme_id, d); });

const TOP = 10;

for (let i = 0; i < Math.min(TOP, ranking.length); i++) {
  const r = ranking[i];
  const raw = rawMap.get(r.aweme_id);
  if (!raw || !raw.video_download_url) {
    console.log(`#${i + 1} ${r.title.substring(0, 30)} — 无下载链接，跳过`);
    continue;
  }

  const outFile = path.join(CLIP_DIR, `top${String(i + 1).padStart(2, '0')}_${r.aweme_id}.mp4`);
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 100000) {
    console.log(`#${i + 1} 已存在 ${path.basename(outFile)} (${(fs.statSync(outFile).size / 1048576).toFixed(1)}MB)`);
    continue;
  }

  console.log(`#${i + 1} 下载中: ${r.title.substring(0, 40)}...`);
  try {
    execSync(`curl -L -s -o "${outFile}" -H "Referer: https://www.douyin.com/" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" "${raw.video_download_url}"`, { timeout: 60000 });
    const sz = fs.statSync(outFile).size;
    console.log(`  → ${path.basename(outFile)} (${(sz / 1048576).toFixed(1)}MB)`);
  } catch (e) {
    console.log(`  → 下载失败: ${e.message}`);
  }
}

// 也下载封面图
const COVER_DIR = path.join(CLIP_DIR, 'covers');
fs.mkdirSync(COVER_DIR, { recursive: true });

for (let i = 0; i < Math.min(TOP, ranking.length); i++) {
  const r = ranking[i];
  const raw = rawMap.get(r.aweme_id);
  if (!raw || !raw.cover_url) continue;

  const outFile = path.join(COVER_DIR, `top${String(i + 1).padStart(2, '0')}_${r.aweme_id}.jpg`);
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1000) continue;

  try {
    execSync(`curl -L -s -o "${outFile}" "${raw.cover_url}"`, { timeout: 15000 });
  } catch (e) { /* ignore */ }
}

console.log('\n下载完成！');
console.log('视频:', fs.readdirSync(CLIP_DIR).filter(f => f.endsWith('.mp4')).length, '个');
console.log('封面:', fs.readdirSync(COVER_DIR).filter(f => f.endsWith('.jpg')).length, '个');
