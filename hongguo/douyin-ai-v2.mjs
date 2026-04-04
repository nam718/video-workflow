/**
 * 抖音 AI 短剧搜索 - 从 RENDER_DATA 提取视频数据
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = import.meta.dirname;
const DATA_DIR = path.join(SCRIPT_DIR, 'data');
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

async function main() {
  ensureDir(DATA_DIR);
  console.log('  🌐 打开抖音搜索页...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  await page.goto('https://www.douyin.com/search/AI%E7%9F%AD%E5%89%A7?type=video', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(8000);

  // 提取 RENDER_DATA
  const renderDataRaw = await page.evaluate(() => {
    const el = document.getElementById('RENDER_DATA');
    return el ? el.textContent : null;
  });

  if (renderDataRaw) {
    const decoded = decodeURIComponent(renderDataRaw);
    fs.writeFileSync(path.join(DATA_DIR, '_render_data.json'), decoded);
    console.log('  ✅ RENDER_DATA:', (decoded.length / 1024).toFixed(0) + 'KB');

    const data = JSON.parse(decoded);

    // 深度搜索视频数据
    const videos = [];
    const findVideos = (obj, path = '') => {
      if (!obj || typeof obj !== 'object') return;
      // 检查是否是视频对象
      if (obj.awemeId || obj.aweme_id) {
        videos.push({ ...obj, _path: path });
        return;
      }
      // 检查是否有 desc 和 video 属性
      if (obj.desc && (obj.video || obj.videoId)) {
        videos.push({ ...obj, _path: path });
        return;
      }
      if (Array.isArray(obj)) {
        obj.forEach((item, i) => findVideos(item, path + '[' + i + ']'));
      } else {
        for (const [k, v] of Object.entries(obj)) {
          findVideos(v, path + '.' + k);
        }
      }
    };
    findVideos(data);

    console.log('  📹 找到视频:', videos.length);
    for (const v of videos.slice(0, 10)) {
      const id = v.awemeId || v.aweme_id || v.videoId || '?';
      const desc = v.desc || v.title || '';
      console.log(`    - [${id}] ${desc.slice(0, 60)}`);
    }

    // 如果没找到通过结构搜索，尝试关键字搜索
    if (videos.length === 0) {
      console.log('\n  🔎 尝试关键字定位...');
      // 搜索含 "video" 或 "aweme" 的路径
      const findKeys = (obj, path = '', depth = 0) => {
        if (depth > 6 || !obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          const p = path + '.' + k;
          if (typeof v === 'string' && v.length > 10 && v.length < 200) {
            if (k === 'desc' || k === 'title' || k === 'nickname') {
              console.log(`      ${p}: "${v.slice(0, 80)}"`);
            }
          }
          if (typeof v === 'object' && v) {
            if (k === 'aweme_list' || k === 'video_list' || k === 'data') {
              console.log(`    📦 ${p}: ${Array.isArray(v) ? 'Array[' + v.length + ']' : 'Object'}`);
            }
            findKeys(v, p, depth + 1);
          }
        }
      };
      findKeys(data);
    }
  }

  // 也从 DOM 提取
  console.log('\n  🔎 DOM 提取...');
  const domData = await page.evaluate(() => {
    const results = [];
    // 搜索所有链接
    const links = document.querySelectorAll('a[href*="/video/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const vid = href.match(/\/video\/(\d+)/)?.[1];
      const parent = link.closest('li, [class*="card"], [class*="item"]') || link;
      const title = parent.querySelector('[class*="title"], [class*="desc"], p')?.textContent?.trim() || link.textContent?.trim();
      const author = parent.querySelector('[class*="author"], [class*="name"]')?.textContent?.trim() || '';
      const count = parent.querySelector('[class*="count"], [class*="like"], [class*="play"]')?.textContent?.trim() || '';
      if (vid) results.push({ vid, title: (title || '').slice(0, 200), author, count, href });
    }
    return results;
  });
  console.log('  DOM 视频:', domData.length);
  for (const v of domData.slice(0, 20)) {
    console.log(`    - [${v.vid}] ${v.title?.slice(0, 50)} | ${v.author} | ${v.count}`);
  }

  // 截图
  await page.screenshot({ path: path.join(DATA_DIR, 'douyin_ai_search.png'), fullPage: false });

  await browser.close();

  // 保存所有抓到的数据
  if (domData.length > 0) {
    const outPath = path.join(DATA_DIR, `douyin_ai_${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      source: 'douyin_search_AI短剧',
      queryDate: new Date().toISOString().slice(0, 10),
      count: domData.length,
      data: domData,
    }, null, 2));
    console.log(`\n  💾 已保存: ${outPath}`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
