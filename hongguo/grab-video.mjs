/**
 * 红果短剧视频抓取器
 *
 * 用 Playwright 无头浏览器打开播放页面，截获视频流 URL 并下载。
 * 红果短剧前5集免费，足够用于分析拍摄手法。
 *
 * 用法:
 *   node hongguo/grab-video.mjs                    # 自动抓取 TOP10 热门剧第1集
 *   node hongguo/grab-video.mjs --series 7580761176179493913  # 指定剧
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const SCRIPT_DIR = import.meta.dirname;
const DATA_DIR = path.join(SCRIPT_DIR, 'data');
const CLIP_DIR = path.join(SCRIPT_DIR, 'clips');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const doGet = (u) => {
      mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.hongguoduanju.com/' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doGet(res.headers.location);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(dest); });
        file.on('error', e => { file.close(); reject(e); });
      }).on('error', reject);
    };
    doGet(url);
  });
}

// 从 data 目录加载最新的热门榜数据
function loadLatestData() {
  if (!fs.existsSync(DATA_DIR)) return null;
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('hot_') && f.endsWith('.json'))
    .sort().reverse();
  return files.length ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, files[0]), 'utf8')) : null;
}

// 用 Playwright 打开播放页，截获视频 URL
async function grabVideoUrl(seriesId, vid) {
  const url = `https://www.hongguoduanju.com/player/${seriesId}/${vid}`;
  console.log(`  🌐 打开: ${url}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 390, height: 844 },
  });

  let videoUrl = null;
  const page = await context.newPage();

  // 监听所有资源请求，截获视频流 URL
  page.on('response', async (response) => {
    const reqUrl = response.url();
    const ct = response.headers()['content-type'] || '';
    // 匹配视频资源: mp4, m3u8, 或者 vod CDN
    if (
      reqUrl.includes('.mp4') ||
      reqUrl.includes('.m3u8') ||
      reqUrl.includes('qznovelvod') ||
      reqUrl.includes('byteimg.com') && ct.includes('video') ||
      ct.includes('video/mp4') ||
      ct.includes('application/vnd.apple.mpegurl')
    ) {
      if (!videoUrl) {
        videoUrl = reqUrl;
        console.log(`  📹 视频URL: ${reqUrl.slice(0, 120)}...`);
      }
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 等待视频加载 (最多30秒)
    for (let i = 0; i < 30 && !videoUrl; i++) {
      await page.waitForTimeout(1000);
      // 尝试点击播放按钮
      if (i === 3) {
        try {
          await page.click('video', { timeout: 2000 }).catch(() => {});
          await page.click('[class*="play"]', { timeout: 2000 }).catch(() => {});
        } catch {}
      }
    }
  } catch (e) {
    console.log(`  ⚠️ 页面加载: ${e.message.slice(0, 100)}`);
  }

  await browser.close();
  return videoUrl;
}

// 从详情页获取第一集 vid
async function getFirstEpisodeVid(seriesId) {
  const url = `https://www.hongguoduanju.com/detail?series_id=${seriesId}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
  });
  const html = await res.text();
  const match = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!match) return null;
  const data = JSON.parse(match[1]);
  const detail = data.loaderData?.detail_page?.seriesDetail;
  if (detail?.vid_list?.length > 0) {
    return detail.vid_list[0]; // 第一集
  }
  return null;
}

// 主流程
async function main() {
  const args = process.argv.slice(2);
  ensureDir(CLIP_DIR);

  let targets = []; // [{seriesId, name}]

  const specifiedSeries = args.find((_, i, a) => a[i - 1] === '--series');
  if (specifiedSeries) {
    targets.push({ seriesId: specifiedSeries, name: specifiedSeries });
  } else {
    const data = loadLatestData();
    if (!data?.data?.length) {
      console.error('❌ 无数据，请先运行 node hongguo/scraper.mjs');
      process.exit(1);
    }
    targets = data.data.slice(0, 10).map(item => ({
      seriesId: item.playletId,
      name: item.playletName,
    }));
  }

  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  红果短剧视频抓取器 (${targets.length}部)          ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  let ok = 0;
  for (let i = 0; i < targets.length; i++) {
    const { seriesId, name } = targets[i];
    const clipPath = path.join(CLIP_DIR, `${seriesId}.mp4`);

    if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 50000) {
      console.log(`  ✅ [${i + 1}/${targets.length}] ${name} (已有缓存)`);
      ok++;
      continue;
    }

    console.log(`\n  🎬 [${i + 1}/${targets.length}] ${name}`);

    // 1. 获取第一集 vid
    console.log(`  🔍 获取第一集视频ID...`);
    const vid = await getFirstEpisodeVid(seriesId);
    if (!vid) {
      console.log(`  ⚠️ 未找到视频ID，跳过`);
      continue;
    }
    console.log(`  📋 vid: ${vid}`);

    // 2. 用 Playwright 抓取视频流 URL
    const videoUrl = await grabVideoUrl(seriesId, vid);
    if (!videoUrl) {
      console.log(`  ⚠️ 未截获视频URL，跳过`);
      continue;
    }

    // 3. 下载视频
    console.log(`  ⬇️ 下载中...`);
    try {
      await downloadFile(videoUrl, clipPath);
      const size = (fs.statSync(clipPath).size / 1024 / 1024).toFixed(1);
      console.log(`  ✅ 已保存: ${clipPath} (${size}MB)`);
      ok++;
    } catch (e) {
      console.log(`  ❌ 下载失败: ${e.message}`);
      try { fs.unlinkSync(clipPath); } catch {}
    }
  }

  console.log(`\n  📊 结果: ${ok}/${targets.length} 个视频下载成功`);
  console.log(`  📁 保存在: ${CLIP_DIR}\n`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
