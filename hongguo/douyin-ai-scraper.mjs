/**
 * 抖音 AI 短剧话题抓取器
 *
 * 用 Playwright 打开抖音 #AI短剧 话题页面，
 * 抓取热门视频列表数据。
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = import.meta.dirname;
const DATA_DIR = path.join(SCRIPT_DIR, 'data');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

async function main() {
  ensureDir(DATA_DIR);

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  抖音 AI短剧 话题抓取器              ║');
  console.log('╚══════════════════════════════════════╝\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();

  // 收集 API 响应数据
  const apiData = [];
  const videoItems = [];

  page.on('response', async (response) => {
    const url = response.url();
    try {
      // 抖音 API 通常返回 JSON
      if (url.includes('/aweme/') || url.includes('/api/') || url.includes('search') || url.includes('challenge')) {
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('application/json')) {
          const body = await response.json().catch(() => null);
          if (body) {
            apiData.push({ url: url.slice(0, 200), data: body });
            // 提取视频列表
            const list = body.aweme_list || body.data?.aweme_list || body.data?.list || [];
            if (Array.isArray(list) && list.length > 0) {
              for (const item of list) {
                if (item.desc || item.title || item.aweme_id) {
                  videoItems.push(item);
                }
              }
              console.log(`  📡 截获 API: ${list.length} 条 (${url.slice(0, 80)}...)`);
            }
          }
        }
      }
    } catch {}
  });

  // 方法1: 尝试搜索页
  console.log('  🔍 方法1: 抖音搜索 "AI短剧"...');
  try {
    await page.goto('https://www.douyin.com/search/AI%E7%9F%AD%E5%89%A7?type=general', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // 等待页面加载
    await page.waitForTimeout(5000);

    // 尝试从 RENDER_DATA 获取数据
    const renderData = await page.evaluate(() => {
      const el = document.getElementById('RENDER_DATA');
      if (el) {
        try { return JSON.parse(decodeURIComponent(el.textContent)); }
        catch { return null; }
      }
      return null;
    });

    if (renderData) {
      console.log('  ✅ 获取到 RENDER_DATA');
      // 扫描所有值找视频数据
      const scanForVideos = (obj, depth = 0) => {
        if (depth > 5 || !obj) return;
        if (typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (item && (item.aweme_id || item.awemeId || item.desc)) {
              videoItems.push(item);
            }
            scanForVideos(item, depth + 1);
          }
        } else {
          for (const val of Object.values(obj)) {
            scanForVideos(val, depth + 1);
          }
        }
      };
      scanForVideos(renderData);
    }

    // 滚动加载更多
    console.log('  📜 滚动加载更多...');
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(2000);
    }
  } catch (e) {
    console.log(`  ⚠️ 搜索页: ${e.message.slice(0, 100)}`);
  }

  // 方法2: 尝试话题页
  if (videoItems.length < 5) {
    console.log('\n  🔍 方法2: 抖音话题 #AI短剧...');
    try {
      // 先搜索话题
      await page.goto('https://www.douyin.com/search/AI%E7%9F%AD%E5%89%A7?type=general', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(5000);

      // 从页面 DOM 提取视频卡片信息
      const domVideos = await page.evaluate(() => {
        const cards = document.querySelectorAll('[class*="search"] a[href*="/video/"]');
        const results = [];
        for (const card of cards) {
          const href = card.getAttribute('href') || '';
          const videoId = href.match(/\/video\/(\d+)/)?.[1];
          const title = card.textContent?.trim().slice(0, 200);
          if (videoId) {
            results.push({ videoId, title: title || '', href });
          }
        }
        return results;
      });

      if (domVideos.length > 0) {
        console.log(`  ✅ DOM提取: ${domVideos.length} 个视频卡片`);
        for (const v of domVideos) {
          if (!videoItems.find(i => (i.aweme_id || i.awemeId || i.videoId) === v.videoId)) {
            videoItems.push(v);
          }
        }
      }

      // 还可以 evaluate 全页面文本提取
      const pageVideoData = await page.evaluate(() => {
        // 提取所有带视频信息的 DOM 节点
        const items = [];
        // 搜索结果卡片
        const allLinks = document.querySelectorAll('a[href*="/video/"]');
        for (const link of allLinks) {
          const href = link.getAttribute('href') || '';
          const videoId = href.match(/\/video\/(\d+)/)?.[1];
          const parent = link.closest('[class*="card"], [class*="item"], [class*="result"]') || link;
          const text = parent.innerText?.trim().slice(0, 500) || '';
          // 找播放量、点赞数
          const stats = text.match(/(\d+(?:\.\d+)?[万亿]?)\s*(?:播放|点赞|评论|转发)/g) || [];
          if (videoId) {
            items.push({ videoId, text: text.slice(0, 200), stats, href });
          }
        }
        return items;
      });

      if (pageVideoData.length > 0) {
        console.log(`  ✅ 详细DOM: ${pageVideoData.length} 个视频`);
        for (const v of pageVideoData.slice(0, 5)) {
          console.log(`    - [${v.videoId}] ${v.text.slice(0, 60)}... ${v.stats.join(' ')}`);
        }
      }
    } catch (e) {
      console.log(`  ⚠️ 话题页: ${e.message.slice(0, 100)}`);
    }
  }

  // 方法3: 截图保存，方便人工查看
  console.log('\n  📸 截图...');
  const screenshotPath = path.join(DATA_DIR, 'douyin_ai_search.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`  ✅ 截图: ${screenshotPath}`);

  await browser.close();

  // 汇总结果
  console.log(`\n  📊 收集结果:`);
  console.log(`    API 截获: ${apiData.length} 个响应`);
  console.log(`    视频项: ${videoItems.length} 个`);

  if (videoItems.length > 0) {
    // 去重和整理
    const seen = new Set();
    const unique = [];
    for (const item of videoItems) {
      const id = item.aweme_id || item.awemeId || item.videoId || '';
      if (id && !seen.has(id)) {
        seen.add(id);
        unique.push({
          videoId: id,
          title: item.desc || item.title || item.text || '',
          author: item.author?.nickname || item.authorName || '',
          stats: item.statistics || item.stats || {},
          createTime: item.create_time || 0,
        });
      }
    }

    console.log(`    去重后: ${unique.length} 个视频\n`);
    for (let i = 0; i < Math.min(unique.length, 20); i++) {
      const v = unique[i];
      const likes = v.stats.digg_count || v.stats.like_count || '';
      console.log(`    ${i + 1}. ${v.title.slice(0, 50)} ${likes ? '❤️' + likes : ''}`);
    }

    // 保存数据
    const outPath = path.join(DATA_DIR, `douyin_ai_${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      source: 'douyin_search_AI短剧',
      queryDate: new Date().toISOString().slice(0, 10),
      count: unique.length,
      data: unique,
    }, null, 2));
    console.log(`\n  💾 已保存: ${outPath}`);
  } else {
    console.log('\n  ⚠️ 未抓取到视频数据。抖音可能需要登录或有反爬机制。');
    // 保存 API 响应供调试
    if (apiData.length > 0) {
      const debugPath = path.join(DATA_DIR, 'douyin_debug.json');
      fs.writeFileSync(debugPath, JSON.stringify(apiData.slice(0, 10), null, 2));
      console.log(`  🔧 调试数据: ${debugPath}`);
    }
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
