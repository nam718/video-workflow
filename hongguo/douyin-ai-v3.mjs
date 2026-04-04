/**
 * 抖音 AI 短剧话题 - 用 Playwright 非 headless 模式截取数据
 * 策略: 用 route 拦截所有 API 请求，特别关注含 aweme 的响应
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = import.meta.dirname;
const DATA_DIR = path.join(SCRIPT_DIR, 'data');
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
ensureDir(DATA_DIR);

async function main() {
  console.log('🌐 启动浏览器...');

  const browser = await chromium.launch({
    headless: false,  // 非 headless，绕过更多检测
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });

  // 添加初始化脚本来隐藏自动化特征
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  const apiResponses = [];
  const videoItems = [];

  // 拦截所有 JSON API 响应
  page.on('response', async (response) => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    
    try {
      if (url.includes('aweme') || url.includes('search') || url.includes('challenge') || url.includes('hashtag')) {
        const body = await response.json().catch(() => null);
        if (!body) return;
        
        // 查找视频列表
        const findList = (obj, depth = 0) => {
          if (depth > 3 || !obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            for (const item of obj) {
              if (item && item.aweme_info) {
                videoItems.push(item.aweme_info);
              } else if (item && item.desc && item.statistics) {
                videoItems.push(item);
              }
              findList(item, depth + 1);
            }
          } else {
            for (const v of Object.values(obj)) findList(v, depth + 1);
          }
        };
        findList(body);
        
        if (videoItems.length > 0) {
          console.log(`  📡 API: ${videoItems.length} videos (${url.slice(0, 80)}...)`);
        }
      }
    } catch {}
  });

  // 访问搜索页
  console.log('  🔍 打开抖音搜索...');
  try {
    await page.goto('https://www.douyin.com/search/AI%E7%9F%AD%E5%89%A7?type=video', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  } catch(e) {
    console.log(`  ⚠️ ${e.message.slice(0, 80)}`);
  }

  // 等待并滚动
  console.log('  ⏳ 等待加载 (15s)...');
  await page.waitForTimeout(5000);

  // 尝试提取 RENDER_DATA
  const renderDataStr = await page.evaluate(() => {
    const el = document.getElementById('RENDER_DATA');
    return el ? el.textContent : null;
  });

  if (renderDataStr) {
    console.log('  ✅ 有 RENDER_DATA');
    try {
      const decoded = decodeURIComponent(renderDataStr);
      const data = JSON.parse(decoded);
      
      // 深度搜索
      const findVideos = (obj, path = '', depth = 0) => {
        if (depth > 8 || !obj || typeof obj !== 'object') return;
        if (obj.desc && (obj.awemeId || obj.video || obj.statistics)) {
          videoItems.push(obj);
          return;
        }
        if (Array.isArray(obj)) {
          obj.forEach((item, i) => findVideos(item, `${path}[${i}]`, depth + 1));
        } else {
          for (const [k, v] of Object.entries(obj)) {
            findVideos(v, `${path}.${k}`, depth + 1);
          }
        }
      };
      findVideos(data);
      console.log(`  RENDER_DATA 提取: ${videoItems.length} videos`);
    } catch(e) {
      console.log(`  ⚠️ 解析失败: ${e.message.slice(0, 60)}`);
    }
  }

  // 滚动加载更多
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(2000);
  }

  // DOM 提取
  console.log('  🔎 DOM 提取...');
  const domData = await page.evaluate(() => {
    const results = [];
    // 尝试多种选择器
    const selectors = [
      'a[href*="/video/"]',
      '[data-e2e="search-card"]',
      '[class*="search"] li',
      '[class*="card"]',
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const href = el.getAttribute('href') || el.querySelector('a')?.getAttribute('href') || '';
        const vid = href.match(/\/video\/(\d+)/)?.[1];
        if (!vid) continue;
        const text = el.innerText || '';
        if (!results.find(r => r.vid === vid)) {
          results.push({ vid, text: text.slice(0, 300), href });
        }
      }
    }
    return results;
  });
  console.log(`  DOM: ${domData.length} videos`);

  // 截图
  await page.screenshot({ path: path.join(DATA_DIR, 'douyin_ai_v3.png'), fullPage: false });
  console.log(`  📸 截图已保存`);

  await browser.close();

  // 汇总
  const seen = new Set();
  const unique = [];
  for (const item of videoItems) {
    const id = item.awemeId || item.aweme_id || '';
    if (id && !seen.has(id)) {
      seen.add(id);
      unique.push({
        id,
        desc: item.desc || '',
        author: item.author?.nickname || '',
        stats: item.statistics || {},
        createTime: item.create_time || item.createTime || 0,
      });
    }
  }
  for (const item of domData) {
    if (!seen.has(item.vid)) {
      seen.add(item.vid);
      unique.push({
        id: item.vid,
        desc: item.text.split('\n')[0] || '',
        author: '',
        stats: {},
        source: 'dom',
      });
    }
  }

  console.log(`\n📊 总计: ${unique.length} 个视频`);
  for (const v of unique.slice(0, 20)) {
    const likes = v.stats?.digg_count || v.stats?.like_count || '';
    console.log(`  - ${v.desc?.slice(0, 50)} ${likes ? '❤️'+likes : ''} @${v.author}`);
  }

  if (unique.length > 0) {
    const outPath = path.join(DATA_DIR, `douyin_ai_${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ source: 'douyin', count: unique.length, data: unique }, null, 2));
    console.log(`\n💾 已保存: ${outPath}`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
