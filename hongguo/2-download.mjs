import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIP_DIR = path.join(__dirname, 'clips_ai');
fs.mkdirSync(CLIP_DIR, { recursive: true });

// 自动取最新排行数据
const rankFile = fs.readdirSync(path.join(__dirname, 'data'))
  .filter(f => f.startsWith('douyin_ai_ranking_') && f.endsWith('.json'))
  .sort().pop();
if (!rankFile) { console.error('❌ 请先运行 1-rank.mjs 生成排行数据'); process.exit(1); }
const RANKING = path.join(__dirname, 'data', rankFile);
const dateMatch = rankFile.match(/(\d{4}-\d{2}-\d{2})/);
const DATE = dateMatch ? dateMatch[1] : '';

// MediaCrawler 原始数据（合并所有文件，含 video_download_url）
const MC_DIR = '/Users/nanhaoquan/video-workflow/MediaCrawler/data/douyin/json';
const srcFiles = fs.readdirSync(MC_DIR)
  .filter(f => f.startsWith('search_contents_') && f.endsWith('.json'))
  .sort();

console.log(`📂 排行: ${rankFile}`);
console.log(`📂 原始: ${srcFiles.length} 个数据文件`);

// 读排行榜（已去重排序）
const ranking = JSON.parse(fs.readFileSync(RANKING, 'utf8'));
// 合并所有原始数据（含 video_download_url）
const rawMap = new Map();
for (const f of srcFiles) {
  const items = JSON.parse(fs.readFileSync(path.join(MC_DIR, f), 'utf8'));
  items.forEach(d => { if (!rawMap.has(d.aweme_id)) rawMap.set(d.aweme_id, d); });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadWithRetry(url, outFile, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      execSync(
        `curl -L -s --fail --connect-timeout 15 --max-time 180 -o "${outFile}" ` +
        `-H "Referer: https://www.douyin.com/" ` +
        `-H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" ` +
        `"${url}"`,
        { timeout: 190000 }
      );
      const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
      if (size > 100000) return size;
      lastError = new Error(`文件过小: ${size}`);
    } catch (e) {
      lastError = e;
    }

    try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch {}
    if (attempt < attempts) {
      console.log(`  → 第${attempt}次失败，2秒后重试...`);
      await sleep(2000);
    }
  }
  throw lastError;
}

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
    const sz = await downloadWithRetry(raw.video_download_url, outFile, 3);
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
