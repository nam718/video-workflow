/**
 * 抖音 AI短剧 热度排行榜视频生成器 v3
 *
 * 布局: 1080×1920 竖屏
 *   - 上黑边(220px): 主题 + 日期
 *   - 视频区(1080×1080): 原视频等比缩放居中
 *   - 下黑边(620px): 字幕区
 *
 * 流程: 排行数据 → 分析文案 → 图表动画 → TTS → 开场快剪 → 逐段合成 → 拼接
 *
 * v3新增: PPT风格动画图表（K线热度图 + 红海蓝海矩阵）
 *
 * 用法: node hongguo/3-make-video.mjs
 */

import fs from 'fs';
import path from 'path';
import { execSync, exec } from 'child_process';
import { analyzeAllClips } from './clip-analyzer.mjs';
import { callAI } from '../shared/call-ai.mjs';

const SCRIPT_DIR = import.meta.dirname;
const DATA_DIR  = path.join(SCRIPT_DIR, 'data');
const VIDEO_DIR = path.join(SCRIPT_DIR, 'videos');
const TEMP_DIR  = path.join(SCRIPT_DIR, '.tmp_ai_video');
const CLIP_DIR  = path.join(SCRIPT_DIR, 'clips_ai');
const SFX_DIR   = path.join(SCRIPT_DIR, 'sfx');
const REMOTION_DIR = path.join(SCRIPT_DIR, 'remotion');
const REMOTION_OUT_DIR = path.join(REMOTION_DIR, 'out');
const CN_FONT   = '/System/Library/AssetsV2/com_apple_MobileAsset_Font8/86ba2c91f017a3749571a82f2c6d890ac7ffb2fb.asset/AssetData/PingFang.ttc';

// 布局常量
const W = 1080, H = 1920;
const TOP_BAR = 220;
const VID_H   = 1080;
const BOT_BAR = H - TOP_BAR - VID_H;  // 620
const SUB_Y   = TOP_BAR + VID_H + 80; // 1380

let videoDateLabel = '';
let videoRangeLabel = '';
let videoTitleLabel = '';

/* ==================== 工具 ==================== */

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function run(cmd) { return execSync(cmd, { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 }); }
function runAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message)); else resolve(stdout);
    });
  });
}
function esc(t) {
  return t.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:')
    .replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/%/g, '%%');
}
function escPath(p) { return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'"); }
function fmtNum(n) { return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n); }

function getVideoDuration(file) {
  const d = run(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`).trim();
  return parseFloat(d) || 0;
}

function formatCnMonthDay(ts) {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function buildRangeLabel(items, rankDate) {
  const tsList = items.map(it => parseInt(it.create_time || 0, 10)).filter(Boolean);
  if (!tsList.length) return rankDate;
  const minTs = Math.min(...tsList);
  const maxTs = Math.max(...tsList);
  const start = formatCnMonthDay(minTs);
  const end = formatCnMonthDay(maxTs);
  return start === end ? start : `${start}-${end}`;
}

function extractEpisode(title) {
  const m = (title || '').match(/第([一二三四五六七八九十百\d]+)[集回]|[eE][pP](\d+)|(\d+)[集回]/);
  if (!m) return null;
  const raw = m[1] || m[2] || m[3];
  const cnMap = { 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10 };
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  if (raw in cnMap) return cnMap[raw];
  return null;
}

function extractCleanTitle(title) {
  const src = (title || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';

  const book = src.match(/《([^》]+)》/);
  if (book) return book[1].trim();

  let t = src.split(/[#\n「]/)[0].trim();
  if (/[｜|]/.test(t)) t = t.split(/[｜|]/).pop().trim();
  t = t.split(/最近参与|创作支持|上线|发布|敬请期待|作者/)[0].trim();
  t = t.replace(/^(原创|自制|个人原创)?\s*(AI|AIGC)?(漫剧|短剧|短片|剧场|真人短剧|动画短剧)?/i, '').trim();
  t = t.replace(/^[-：:，,。.！!？?]+|[-：:，,。.！!？?]+$/g, '').trim();
  return t.substring(0, 24);
}

/* ==================== 1. 数据加载 ==================== */

function loadRanking() {
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('douyin_ai_ranking_') && f.endsWith('.json'))
    .sort().reverse();
  if (!files.length) return null;
  const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, files[0]), 'utf-8'));
  const m = files[0].match(/(\d{4}-\d{2}-\d{2})/);
  return { items: data, date: m ? m[1] : new Date().toISOString().slice(0, 10) };
}

/* ==================== 2. 分析式文案 ==================== */

function buildScript(items, rankDate) {
  const segs = [];
  const top10 = items.slice(0, 10);
  const top30 = items.slice(0, 30); // 用前30条做统计分析
  const rangeText = buildRangeLabel(items, rankDate);

  // --- 统计标签/特征（基于前30） ---
  const styleCounts = { '古风': 0, '仙侠': 0, '玄幻': 0, '现代': 0, '末日': 0, '恐怖': 0, '搞笑': 0, '言情': 0, '历史': 0 };
  const toolCounts = { '即梦': 0, '可灵': 0, 'Seedance': 0 };
  const formatCounts = { '漫剧': 0, '真人': 0, '写实': 0 };

  for (const it of top30) {
    const t = it.title;
    if (/古风|古装/.test(t)) styleCounts['古风']++;
    if (/仙侠|武侠|玄幻|修仙/.test(t)) styleCounts['仙侠']++;
    if (/末日|丧尸/.test(t)) styleCounts['末日']++;
    if (/恐怖|惊悚|克苏鲁/.test(t)) styleCounts['恐怖']++;
    if (/搞笑|女频/.test(t)) styleCounts['搞笑']++;
    if (/言情|恋爱|甜宠/.test(t)) styleCounts['言情']++;
    if (/历史|三国|霍去病/.test(t)) styleCounts['历史']++;
    if (/即梦|seedance/i.test(t)) toolCounts['即梦']++;
    if (/可灵/.test(t)) toolCounts['可灵']++;
    if (/漫剧/.test(t)) formatCounts['漫剧']++;
    if (/真人|写实/i.test(t)) formatCounts['真人']++;
  }

  const hotStyles = Object.entries(styleCounts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const topStyle = hotStyles.length ? hotStyles[0][0] : '古风';
  const topFormat = Object.entries(formatCounts).sort((a, b) => b[1] - a[1])[0][0];
  const topTool = Object.entries(toolCounts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);

  // --- 开场（配快剪蒙太奇） ---
  const hookText = `做AI短剧的注意了！${rangeText}抖音AI短剧热门榜来了。`
    + `${topStyle}题材依然是流量密码，${topFormat}风格占据主流。`
    + `TOP10全部在这里，我们逐一拆解。`;
  segs.push({ type: 'intro', text: hookText, duration: 10, ranking: 0 });

  // --- 逐一点评（分析式） ---
  const ordinals = ['冠军', '亚军', '季军', '第四', '第五', '第六', '第七', '第八', '第九', '第十'];
  for (let i = 0; i < top10.length; i++) {
    const it = top10[i];
    const shortTitle = extractCleanTitle(it.title) || it.title.split(/[#\n]/)[0].trim().substring(0, 30);
    const likes = fmtNum(it.liked_count);
    const shares = fmtNum(it.share_count);

    // 提取集数信息
    let episodeNote = '';
    const ep = it.episode || extractEpisode(it.title);
    if (ep) episodeNote = `目前更新到第${ep}集，`;

    let featureNote = '';
    if (/古风|仙侠|武侠/.test(it.title)) featureNote = '古风赛道持续火热，';
    else if (/恐怖|惊悚|克苏鲁/.test(it.title)) featureNote = '暗黑题材吸引垂直受众，';
    else if (/末日|丧尸/.test(it.title)) featureNote = '末日题材差异化明显，';
    else if (/搞笑|女频/.test(it.title)) featureNote = '轻喜剧题材适合破圈，';
    else if (/真人|写实/.test(it.title)) featureNote = 'AI真人写实越来越逼真，';
    else if (/白雪公主|童话/.test(it.title)) featureNote = '经典IP改编是流量保障，';

    // 计算发布天数
    let daysNote = '';
    if (it.create_time) {
      const rankTs = new Date(rankDate + 'T00:00:00+08:00').getTime() / 1000;
      const days = Math.floor((rankTs - it.create_time) / 86400);
      if (days <= 0) daysNote = '刚刚发布，';
      else if (days <= 3) daysNote = `发布仅${days}天，`;
      else daysNote = `发布${days}天，`;
    }

    let dataNote = '';
    if (it.share_count > it.liked_count * 0.3) dataNote = '分享率极高说明传播力强。';
    else if (it.collected_count > it.liked_count * 0.2) dataNote = '收藏率高说明内容有持续价值。';
    else dataNote = `点赞${likes}，分享${shares}。`;

    segs.push({
      type: 'ranking',
      text: `${ordinals[i]}！${shortTitle}。作者${it.nickname}。${daysNote}${episodeNote}${featureNote}${dataNote}`,
      duration: 8,
      ranking: i + 1,
      aweme_id: it.aweme_id,
      nickname: it.nickname,
      liked_count: it.liked_count,
      share_count: it.share_count,
    });
  }

  // --- 趋势总结 ---
  let trendText = `纵观${rangeText}上榜的${items.length}部作品，`;
  if (hotStyles.length >= 2) trendText += `${hotStyles[0][0]}和${hotStyles[1][0]}依然是最热门的题材方向。`;
  else trendText += `${topStyle}题材一家独大。`;
  if (topTool.length) trendText += `工具方面，${topTool.map(([t]) => t).join('和')}是创作者的首选。`;
  trendText += `对于想入局AI短剧的创作者，建议先选好垂直赛道，用好工具，讲好故事。`;
  segs.push({ type: 'trend', text: trendText, duration: 12, ranking: 0 });

  // --- 结尾 ---
  segs.push({
    type: 'outro',
    text: `以上就是${rangeText}AI短剧热门榜。觉得有用就点赞收藏，想持续追踪AI短剧赛道，记得关注。我们下期见！`,
    duration: 7, ranking: 0,
  });

  return segs;
}

/* ==================== 2.5 AI智能解说（方案C）==================== */

/**
 * 构建AI分析所需的视频片段列表
 */
function buildClipList(items) {
  const top10 = items.slice(0, 10);
  return top10.map((it, i) => {
    const rank = i + 1;
    const found = fs.readdirSync(CLIP_DIR).filter(f => f.includes(it.aweme_id) && f.endsWith('.mp4'));
    return {
      videoPath: found.length ? path.join(CLIP_DIR, found[0]) : '',
      title: it.title,
      rank,
    };
  }).filter(c => c.videoPath);
}

/**
 * AI智能解说 — 调用LLM生成完整解说文案
 * 融合：视觉分析 + 语音台词 + 排行数据 → 风格化解说
 */
async function buildSmartScript(items, rankDate, analysisMap) {
  const top10 = items.slice(0, 10);
  const rangeText = buildRangeLabel(items, rankDate);

  // 计算赛道分析数据（用于图表分析段的AI解说）
  const tagAnalysis = analyzeAllTags(items);

  // 构建每个 TOP 视频的分析摘要
  const clipInfos = top10.map((it, i) => {
    const rank = i + 1;
    const found = fs.readdirSync(CLIP_DIR).filter(f => f.includes(it.aweme_id) && f.endsWith('.mp4'));
    const videoPath = found.length ? path.join(CLIP_DIR, found[0]) : '';
    const analysis = analysisMap.get(videoPath);
    const shortTitle = extractCleanTitle(it.title) || it.title.split(/[#\n]/)[0].trim().substring(0, 30);

    return {
      rank,
      title: shortTitle,
      fullTitle: it.title,
      nickname: it.nickname,
      aweme_id: it.aweme_id,
      liked_count: it.liked_count,
      share_count: it.share_count,
      collected_count: it.collected_count,
      heat_score: it.heat_score,
      contentAnalysis: analysis?.summary || '',
      transcript: analysis?.transcript || '',
    };
  });

  // 构建AI提示词 — 融合 NarratoAI + 解说猫的最佳实践
  const prompt = buildNarrationPrompt(clipInfos, rangeText, rankDate, items.length, tagAnalysis, items);

  console.log('  🤖 正在调用AI生成解说文案...');
  let aiResult;
  try {
    aiResult = await callAI(prompt, {
      systemPrompt: NARRATION_SYSTEM_PROMPT,
      maxTokens: 8192,
      maxRetries: 3,
    });
  } catch (err) {
    console.error(`  ❌ AI解说生成失败: ${err.message}`);
    console.log('  ⚠️ 回退到模板文案...');
    return { segments: buildScript(items, rankDate), chartNarrations: new Map() };
  }

  // 解析AI返回的文案
  return parseAINarration(aiResult, top10, rangeText);
}

/* --- 解说Prompt系统 --- */

const NARRATION_SYSTEM_PROMPT = `你是一个顶级的短视频排行榜解说达人，你的风格融合了"口语化短剧漫剪"和"高能合辑解说"。

你的人格特征：
- 语气自然、口语化，像在和好兄弟聊天分享好看的短剧
- 善用悬念和反转制造期待感
- 对AI短剧赛道有深刻理解，能从数据中读出趋势
- 每句话控制在15-20字，节奏明快
- 善用短句、顿号制造节奏感
- 会在关键画面留白，让视觉冲击说话

你的核心法则：
1. 【黄金三秒】开头必须用钩子抓住注意力
2. 【内容为王】每部作品必须描述故事内容，不能只说数据
3. 【分段粒度】每段解说7-10秒，控制在40-60字
4. 【情绪曲线】制造波动：惊叹→好奇→满足→期待`;

function buildNarrationPrompt(clipInfos, rangeText, rankDate, totalCount, tagAnalysis, items) {
  const clipsBlock = clipInfos.map(c => {
    let info = `【TOP${c.rank}】《${c.title}》\n`;
    info += `  作者: ${c.nickname}\n`;
    info += `  数据: 点赞${fmtNum(c.liked_count)} 分享${fmtNum(c.share_count)} 收藏${fmtNum(c.collected_count)}\n`;
    if (c.contentAnalysis) info += `  内容分析: ${c.contentAnalysis}\n`;
    if (c.transcript && c.transcript.length > 10) {
      info += `  台词摘录: ${c.transcript.slice(0, 150)}\n`;
    }
    return info;
  }).join('\n');

  // 赛道分析数据块
  let tagBlock = '';
  if (tagAnalysis && tagAnalysis.tags && tagAnalysis.tags.length) {
    const tags = tagAnalysis.tags;
    const overallAvg = Math.round(tagAnalysis.overallAvgHeat);
    const bullish = tags.filter(t => t.avgHeat > tagAnalysis.overallAvgHeat);
    const bearish = tags.filter(t => t.avgHeat <= tagAnalysis.overallAvgHeat);

    // 竞争分界
    const sortedCounts = tags.map(t => t.count).sort((a, b) => a - b);
    const medianCount = sortedCounts[Math.floor(sortedCounts.length / 2)] || 2;
    const threshold = Math.max(medianCount + 1, 3);
    const redOcean = tags.filter(t => t.count >= threshold && t.avgHeat > tagAnalysis.overallAvgHeat);
    const blueOcean = tags.filter(t => t.count < threshold && t.avgHeat > tagAnalysis.overallAvgHeat);

    // 黑马数据（基于TOP10的日均互动速度）
    const now = new Date(rankDate).getTime() / 1000;
    const darkhorses = clipInfos
      .filter(c => {
        // 从items中找到对应的原始数据获取create_time
        const origItem = items?.find(it => it.aweme_id === c.aweme_id);
        return origItem && origItem.create_time > 0;
      })
      .map(c => {
        const origItem = items?.find(it => it.aweme_id === c.aweme_id);
        const days = Math.max(1, (now - origItem.create_time) / 86400);
        return { title: c.title, days: +days.toFixed(1), dailyEngagement: Math.round((c.liked_count + c.share_count) / days) };
      })
      .sort((a, b) => b.dailyEngagement - a.dailyEngagement)
      .slice(0, 3);

    tagBlock = `\n<track_analysis>
赛道概况（全体均热度: ${overallAvg}万）：
${tags.map(t => `  ${t.name}: ${t.count}部, 均热度${Math.round(t.avgHeat)}万`).join('\n')}

强势赛道（高于均值）: ${bullish.map(t => t.name).join('、') || '无'}
弱势赛道（低于均值）: ${bearish.map(t => t.name).join('、') || '无'}
红海赛道（高竞争+高热度）: ${redOcean.map(t => t.name).join('、') || '无'}
蓝海机会（低竞争+高热度）: ${blueOcean.map(t => t.name).join('、') || '无'}
${darkhorses.length ? `黑马数据: ${darkhorses.map(d => `${d.title} (${Math.round(d.days)}天, 日均互动${d.dailyEngagement})`).join('; ')}` : ''}
</track_analysis>`;
  }

  return `请为"${rangeText}抖音AI短剧热门榜TOP10"生成一段完整的排行榜解说视频文案。

<video_data>
排行日期: ${rankDate}
数据范围: ${rangeText}
上榜作品总数: ${totalCount}

${clipsBlock}
</video_data>
${tagBlock}

<structure>
请严格按以下结构生成，共15段：

1. **intro**（开场）: 用一个爆款钩子开头。从以下四种中选一个最合适的：
   - 震惊式："这个排行榜我看完直接震惊了！"
   - 危机式："做AI短剧的注意了，赛道要变天了！"
   - 反转式："所有人都以为XXX，但这次TOP1让人意外..."
   - 提问式："最近你刷到最离谱的AI短剧是哪个？"
   然后简要预告本期榜单亮点，制造期待感。控制在60字以内。

2-11. **ranking**（TOP10逐一解说，从第1到第10）: 每段必须包含：
   - 排名称呼（冠军/亚军/季军/第四...第十）
   - 作品名称
   - **故事内容描述**（这是最重要的！用1-2句话描述这个短剧讲了什么故事、什么画面、什么看点）
   - 作者名称
   - 一句画龙点睛的数据点评或趋势洞察
   每段控制在50-70字。

12. **chart_kline**（赛道K线分析）: 配合K线热度图动画，用口语化语气解读各赛道强弱。
   点出哪个赛道最强势、哪个最内卷、哪个有空间。像聊天一样说趋势，不要堆数据。控制在50-70字。

13. **chart_ocean**（红海蓝海分析）: 配合红海蓝海矩阵动画，告诉观众创作者该往哪个方向走。
   说出红海有哪些、蓝海机会在哪。给出实用建议。控制在50-70字。

14. **chart_darkhorse**（黑马飙升分析）: 配合黑马飙升榜动画，聊本期涨最快的作品。
   重点说黑马为什么能爆、创作者能学到什么。有爆发力感。控制在50-70字。

15. **outro**（结尾）: 总结本期趋势 + 给创作者的建议 + 引导关注。控制在60字以内。
</structure>

<rules>
1. 【故事优先】每个排名项的解说，故事内容描述必须占主体，数据只是点缀
2. 【口语化】像朋友聊天，禁止书面语。用"这部剧"不用"该作品"，用"太猛了"不用"数据表现优异"
3. 【节奏感】短句为主，善用感叹号和省略号制造节奏
4. 【画面联想】描述故事时要让听众脑中浮现画面，用具体的场景和动作
5. 【严禁虚构】故事描述必须基于<video_data>中的"内容分析"和"台词摘录"，没有分析数据的就侧重数据点评
6. 【字数限制】每段最少30字，最多70字
</rules>

请用以下JSON格式输出，不要输出其他内容：
{
  "segments": [
    {"type": "intro", "text": "开场文案"},
    {"type": "ranking", "rank": 1, "text": "TOP1解说文案"},
    {"type": "ranking", "rank": 2, "text": "TOP2解说文案"},
    ...
    {"type": "ranking", "rank": 10, "text": "TOP10解说文案"},
    {"type": "chart_kline", "text": "K线分析文案"},
    {"type": "chart_ocean", "text": "红海蓝海分析文案"},
    {"type": "chart_darkhorse", "text": "黑马飙升分析文案"},
    {"type": "outro", "text": "结尾文案"}
  ]
}`;
}

/**
 * 解析AI返回的解说文案，转换为 buildScript 兼容的 segments 格式
 */
function parseAINarration(aiResult, top10, rangeText) {
  const segs = [];
  const aiSegs = aiResult.segments || [];

  if (!aiSegs.length) {
    console.error('  ❌ AI返回的segments为空');
    return null;
  }

  for (const aiSeg of aiSegs) {
    const seg = { type: aiSeg.type, text: aiSeg.text, ranking: 0 };

    if (aiSeg.type === 'intro') {
      seg.duration = 10;
    } else if (aiSeg.type === 'ranking') {
      const rank = aiSeg.rank;
      const item = top10[rank - 1];
      if (item) {
        seg.ranking = rank;
        seg.aweme_id = item.aweme_id;
        seg.nickname = item.nickname;
        seg.liked_count = item.liked_count;
        seg.share_count = item.share_count;
      }
      seg.duration = 8;
    } else if (aiSeg.type === 'outro') {
      seg.duration = 7;
    } else if (aiSeg.type?.startsWith('chart_')) {
      // AI生成的图表分析段 — 暂存，后续由 renderCharts 插入时使用
      seg.type = aiSeg.type;
      seg.duration = 12;
    } else {
      seg.duration = 8;
    }

    segs.push(seg);
  }

  // 提取图表分析段文案，存入 Map 供后续使用（不直接放入 segments）
  const chartNarrations = new Map();
  const nonChartSegs = segs.filter(s => {
    if (s.type?.startsWith('chart_')) {
      chartNarrations.set(s.type, s.text);
      return false;
    }
    return true;
  });

  // 验证: 确保有 intro + 10个ranking + outro
  const rankings = nonChartSegs.filter(s => s.type === 'ranking');
  if (rankings.length < 10) {
    console.warn(`  ⚠️ AI只生成了 ${rankings.length} 个排名段（需要10个）`);
  }
  if (chartNarrations.size) {
    console.log(`  📊 AI图表分析文案: ${[...chartNarrations.keys()].join(', ')}`);
  }

  console.log(`  ✅ AI解说文案生成完成，共 ${nonChartSegs.length} 段（+${chartNarrations.size} 图表分析）`);
  return { segments: nonChartSegs, chartNarrations };
}

/* ==================== 3. TTS ==================== */

async function generateTTS(segments) {
  const audioDir = path.join(TEMP_DIR, 'audio');
  ensureDir(audioDir);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const ap = path.join(audioDir, `seg_${String(i).padStart(2, '0')}.mp3`);
    const sp = path.join(audioDir, `seg_${String(i).padStart(2, '0')}.srt`);

    if (fs.existsSync(ap) && fs.existsSync(sp)) {
      seg.audioPath = ap; seg.subtitlePath = sp;
      seg.actualDuration = getVideoDuration(ap) || seg.duration;
      console.log(`  ✅ seg_${i} (cached ${seg.actualDuration.toFixed(1)}s)`);
      continue;
    }

    const textEsc = seg.text.replace(/"/g, '\\"').replace(/[——《》]/g, ' ');
    const MAX_RETRIES = 3;
    let ok = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const tmpRaw = ap + '.raw.mp3';
        await runAsync(`edge-tts --voice zh-CN-YunxiNeural --rate=+5% --text "${textEsc}" --write-media "${tmpRaw}" --write-subtitles "${sp}" 2>&1`);
        // TTS 输出 ≈ -24dB，先提升到正常响度
        await runAsync(`ffmpeg -y -i "${tmpRaw}" -af "volume=18dB,alimiter=limit=0.95:level=true" -c:a libmp3lame -q:a 2 "${ap}" 2>/dev/null`);
        try { fs.unlinkSync(tmpRaw); } catch {}
        seg.audioPath = ap; seg.subtitlePath = sp;
        seg.actualDuration = getVideoDuration(ap) || seg.duration;
        console.log(`  ✅ seg_${i} (${seg.actualDuration.toFixed(1)}s): ${seg.text.slice(0, 30)}...`);
        ok = true;
        break;
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          console.log(`  ⚠️ seg_${i} TTS第${attempt}次失败，重试...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    if (!ok) console.error(`  ❌ seg_${i} TTS失败（${MAX_RETRIES}次）`);
  }

  // 后置验证：检查所有非图表段是否都有TTS音频
  const failed = segments.filter((s, i) => !s.audioPath && s.type !== 'chart');
  if (failed.length) {
    console.error(`\n❌ 有 ${failed.length} 段TTS生成失败，无法继续：`);
    failed.forEach(s => console.error(`   - [${s.type}] ${s.text.slice(0, 40)}...`));
    process.exit(1);
  }
}

/* ==================== SRT + 字幕工具 ==================== */

function parseSrtTimeToSeconds(t) {
  const m = (t || '').trim().match(/(\d+):(\d+):(\d+),(\d+)/);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : 0;
}

function parseSrtCues(filePath, targetDur = 0) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  const rawCues = content.split(/\n\s*\n/)
    .map(b => b.trim().split('\n')).filter(l => l.length >= 3)
    .map(l => {
      const [s, e] = (l[1] || '').split(' --> ');
      return { text: l.slice(2).join('').trim(), start: parseSrtTimeToSeconds(s), end: parseSrtTimeToSeconds(e) };
    }).filter(c => c.text && c.end > c.start);

  if (targetDur > 0 && rawCues.length) {
    const rawEnd = rawCues[rawCues.length - 1].end;
    if (rawEnd > 0) {
      const ratio = targetDur / rawEnd;
      if (Math.abs(ratio - 1) > 0.01) {
        rawCues.forEach(c => {
          c.start *= ratio;
          c.end *= ratio;
        });
      }
    }
  }

  const out = [];
  for (const cue of rawCues) {
    if (cue.text.length <= 14) { out.push(cue); continue; }
    const parts = cue.text.split(/(?<=[，,、。！？!?；;])/).map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) { out.push(cue); continue; }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const dur = cue.end - cue.start;
    let cur = cue.start;
    parts.forEach((p, j) => {
      const pd = (p.length / total) * dur;
      out.push({ text: p, start: cur, end: j === parts.length - 1 ? cue.end : cur + pd });
      cur += pd;
    });
  }
  return out;
}

function buildSubtitleCues(text, dur, maxChars = 14) {
  const cleaned = (text || '').replace(/\s+/g, '').trim();
  if (!cleaned) return [{ text: '', start: 0, end: dur }];
  const rawParts = cleaned.split(/(?<=[。！？!?；;，,、])/).map(s => s.trim()).filter(Boolean);
  const merged = [];
  for (const p of rawParts) {
    if (!merged.length) { merged.push(p); continue; }
    if (merged[merged.length - 1].length < 10) merged[merged.length - 1] += p;
    else merged.push(p);
  }
  const normalized = merged.flatMap(p => {
    if (p.length <= maxChars) return [p];
    const pcs = [];
    for (let i = 0; i < p.length; i += maxChars) pcs.push(p.slice(i, i + maxChars));
    return pcs;
  }).filter(Boolean);
  while (normalized.length > 10) { normalized[normalized.length - 2] += normalized.pop(); }

  const cnt = Math.max(1, normalized.length);
  const wts = normalized.map(p => Math.max(1, p.length));
  const tw = wts.reduce((s, v) => s + v, 0);
  const minSlot = Math.min(2.2, dur / cnt);
  let cur = 0;
  return normalized.map((part, i) => {
    const prop = dur * (wts[i] / tw);
    const rem = dur - cur;
    const rc = cnt - i;
    const slot = i === cnt - 1 ? rem + 0.2 : Math.max(minSlot, Math.min(prop, rem - minSlot * (rc - 1)));
    const cue = { text: part, start: cur, end: i === cnt - 1 ? dur + 0.2 : cur + slot };
    cur += slot;
    return cue;
  });
}

function writeCueFiles(baseKey, cues) {
  const dir = path.join(TEMP_DIR, 'cue_texts');
  ensureDir(dir);
  return cues.map((cue, i) => {
    const fp = path.join(dir, `${baseKey}_${i}.txt`);
    fs.writeFileSync(fp, cue.text, 'utf-8');
    return { ...cue, filePath: fp };
  });
}

function subFilters(inputLabel, cues, y, fontSize, finalLabel = '[final]') {
  if (!cues.length) return [`${inputLabel}copy${finalLabel}`];
  const filters = [];
  let prev = inputLabel;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const out = i === cues.length - 1 ? finalLabel : `[sub${i}]`;
    filters.push(
      `${prev}drawtext=fontfile='${CN_FONT}':textfile='${escPath(c.filePath)}':reload=0:fontsize=${fontSize}:fontcolor=white:borderw=2:bordercolor=black@0.8:box=1:boxcolor=black@0.22:boxborderw=18:x=(w-tw)/2:y=${y}:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'${out}`
    );
    prev = out;
  }
  return filters;
}

/* ==================== 4. 视频合成 ==================== */

// 上栏滤镜: 日期(左上) + 主题(居中)
function topBarFilters(label, title, date) {
  return [
    `${label}drawtext=fontfile='${CN_FONT}':text='${esc(date)}':fontsize=36:fontcolor=white@0.6:x=40:y=30[_d1]`,
    `[_d1]drawtext=fontfile='${CN_FONT}':text='${esc(title)}':fontsize=44:fontcolor=cyan:borderw=1:bordercolor=black@0.5:x=(w-tw)/2:y=100[_topbar]`,
  ];
}

// 排名片段
async function makeRankingSegment(seg, outPath, dur) {
  const cues = writeCueFiles(
    path.basename(outPath, '.mp4'),
    parseSrtCues(seg.subtitlePath, dur).length ? parseSrtCues(seg.subtitlePath, dur) : buildSubtitleCues(seg.text, dur)
  );

  const filters = [
    // 视频等比缩放到1080×1080，黑边填充，放入画布
    `[0:v]scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(1080-iw)/2:(1080-ih)/2:black[_vid]`,
    `[_vid]pad=${W}:${H}:0:${TOP_BAR}:black[_canvas]`,
    // 上栏
    ...topBarFilters('[_canvas]', videoTitleLabel, videoDateLabel),
  ];

  let label = '[_topbar]';

  // 排名角标
  if (seg.ranking) {
    filters.push(`${label}drawtext=fontfile='${CN_FONT}':text='TOP ${seg.ranking}':fontsize=80:fontcolor=gold:borderw=3:bordercolor=black:x=40:y=${TOP_BAR + 20}[_rk]`);
    label = '[_rk]';
  }

  // 作者 (视频区右下)
  if (seg.nickname) {
    filters.push(`${label}drawtext=fontfile='${CN_FONT}':text='@${esc(seg.nickname)}':fontsize=32:fontcolor=white@0.8:borderw=1:bordercolor=black@0.5:x=w-tw-40:y=${TOP_BAR + VID_H - 60}[_auth]`);
    label = '[_auth]';
  }

  // 数据 (视频区左下)
  if (seg.liked_count) {
    const dt = `${fmtNum(seg.liked_count)}赞  ${fmtNum(seg.share_count)}转发`;
    filters.push(`${label}drawtext=fontfile='${CN_FONT}':text='${esc(dt)}':fontsize=30:fontcolor=white@0.7:x=40:y=${TOP_BAR + VID_H - 60}[_dt]`);
    label = '[_dt]';
  }

  // 字幕
  filters.push(...subFilters(label, cues, SUB_Y, 48));

  const cmd = [
    `ffmpeg -y -stream_loop -1 -i "${seg.clipPath}"`,
    seg.audioPath ? `-i "${seg.audioPath}"` : '',
    `-t ${dur}`,
    `-filter_complex "${filters.join(';')}"`,
    `-map "[final]"`,
    seg.audioPath ? `-map 1:a` : `-an`,
    `-c:v libx264 -preset fast -crf 23`,
    seg.audioPath ? `-c:a aac -b:a 128k` : '',
    `-r 30 -pix_fmt yuv420p`,
    `"${outPath}"`,
  ].filter(Boolean).join(' ');
  await runAsync(cmd);
}

// 图表片段 (K线/红海蓝海矩阵)
// 以 Remotion 图表视频的时长为准，TTS 用 atempo 拉伸匹配
async function makeChartSegment(seg, outPath, ttsDur) {
  const chartDur = getVideoDuration(seg.chartVideoPath) || ttsDur;
  const dur = chartDur; // 以图表动画时长为准

  const cues = writeCueFiles(
    path.basename(outPath, '.mp4'),
    parseSrtCues(seg.subtitlePath, dur).length ? parseSrtCues(seg.subtitlePath, dur) : buildSubtitleCues(seg.text, dur)
  );

  const lbl = esc(seg.chartLabel || '📊 趋势分析');

  // 计算 atempo 让 TTS 音频拉伸到图表视频时长
  const tempo = (seg.audioPath && ttsDur > 0 && Math.abs(chartDur - ttsDur) > 0.2)
    ? Math.max(0.5, Math.min(2.0, ttsDur / chartDur))
    : 1.0;

  const filters = [
    // 图表视频全屏显示（Remotion已输出1080x1920）
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(${W}-iw)/2:(${H}-ih)/2:black[_canvas]`,
    // 字幕（底部区域）
    ...subFilters('[_canvas]', cues, SUB_Y, 48),
  ];

  // 如果需要拉伸音频，添加 atempo 滤镜
  const audioFilter = tempo !== 1.0 ? `-af "atempo=${tempo.toFixed(4)}"` : '';

  const cmd = [
    `ffmpeg -y -i "${seg.chartVideoPath}"`,
    seg.audioPath ? `-i "${seg.audioPath}"` : '',
    `-t ${dur}`,
    `-filter_complex "${filters.join(';')}"`,
    `-map "[final]"`,
    seg.audioPath ? `-map 1:a` : `-an`,
    `-c:v libx264 -preset fast -crf 23`,
    seg.audioPath ? `-c:a aac -b:a 128k` : '',
    audioFilter,
    `-r 30 -pix_fmt yuv420p`,
    `"${outPath}"`,
  ].filter(Boolean).join(' ');
  await runAsync(cmd);
}

// 文字片段 (开场/趋势/结尾)
async function makeTextSegment(seg, outPath, dur, posterFrame) {
  const cues = writeCueFiles(
    path.basename(outPath, '.mp4'),
    parseSrtCues(seg.subtitlePath, dur).length ? parseSrtCues(seg.subtitlePath, dur) : buildSubtitleCues(seg.text, dur)
  );

  const typeLabels = { intro: '🔥 热门榜导览', trend: '📊 趋势分析', outro: '👋 下期再见' };
  const lbl = esc(typeLabels[seg.type] || '');

  const filters = [
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[_bg]`,
    ...topBarFilters('[_bg]', videoTitleLabel, videoDateLabel),
    `[_topbar]drawtext=fontfile='${CN_FONT}':text='${lbl}':fontsize=56:fontcolor=cyan:borderw=2:bordercolor=black:x=(w-tw)/2:y=${TOP_BAR + 400}[_t1]`,
    ...subFilters('[_t1]', cues, SUB_Y, 48),
  ].join(';');

  const cmd = [
    `ffmpeg -y -loop 1 -i "${posterFrame}"`,
    seg.audioPath ? `-i "${seg.audioPath}"` : '',
    `-t ${dur}`,
    `-filter_complex "${filters}"`,
    `-map "[final]"`,
    seg.audioPath ? `-map 1:a` : `-an`,
    `-c:v libx264 -preset fast -crf 23`,
    seg.audioPath ? `-c:a aac -b:a 128k` : '',
    `-r 30 -pix_fmt yuv420p`,
    `"${outPath}"`,
  ].filter(Boolean).join(' ');
  await runAsync(cmd);
}

// 开场蒙太奇: TOP10 视频各1-2秒快剪
async function makeIntroMontage(segments, introSeg, outPath) {
  const dur = introSeg.actualDuration || introSeg.duration;
  const clips = segments.filter(s => s.clipPath && fs.existsSync(s.clipPath));
  if (!clips.length) return false;

  const perClip = Math.max(0.8, dur / clips.length);
  const tmpDir = path.join(TEMP_DIR, 'montage');
  ensureDir(tmpDir);

  const montageParts = [];
  for (let i = 0; i < clips.length; i++) {
    const mp = path.join(tmpDir, `m_${i}.mp4`);
    if (fs.existsSync(mp) && fs.statSync(mp).size > 5000) { montageParts.push(mp); continue; }

    const clipDur = getVideoDuration(clips[i].clipPath);
    const startOff = Math.max(0, Math.min(clipDur * 0.3, clipDur - perClip - 1));

    try {
      await runAsync(
        `ffmpeg -y -ss ${startOff.toFixed(1)} -i "${clips[i].clipPath}" -t ${perClip.toFixed(1)} ` +
        `-vf "scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080" ` +
        `-c:v libx264 -preset fast -crf 23 -an -r 30 -pix_fmt yuv420p "${mp}" 2>/dev/null`
      );
      if (fs.existsSync(mp) && fs.statSync(mp).size > 1000) montageParts.push(mp);
    } catch { /* skip */ }
  }

  if (!montageParts.length) return false;

  // 拼接蒙太奇
  const listFile = path.join(tmpDir, 'list.txt');
  fs.writeFileSync(listFile, montageParts.map(p => `file '${p}'`).join('\n'));
  const rawMontage = path.join(tmpDir, 'raw_montage.mp4');
  await runAsync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset fast -crf 23 -r 30 -pix_fmt yuv420p -an "${rawMontage}" 2>/dev/null`);

  // 蒙太奇视频 + 画布布局 + 标题 + 字幕
  const cues = writeCueFiles(
    'intro_montage',
    parseSrtCues(introSeg.subtitlePath, dur).length ? parseSrtCues(introSeg.subtitlePath, dur) : buildSubtitleCues(introSeg.text, dur)
  );

  const filters = [
    `[0:v]pad=${W}:${H}:0:${TOP_BAR}:black[_canvas]`,
    ...topBarFilters('[_canvas]', videoTitleLabel, videoDateLabel),
    ...subFilters('[_topbar]', cues, SUB_Y, 48),
  ].join(';');

  const cmd = [
    `ffmpeg -y -stream_loop -1 -i "${rawMontage}"`,
    introSeg.audioPath ? `-i "${introSeg.audioPath}"` : '',
    `-t ${dur}`,
    `-filter_complex "${filters}"`,
    `-map "[final]"`,
    introSeg.audioPath ? `-map 1:a` : `-an`,
    `-c:v libx264 -preset fast -crf 23`,
    introSeg.audioPath ? `-c:a aac -b:a 128k` : '',
    `-r 30 -pix_fmt yuv420p`,
    `"${outPath}"`,
  ].filter(Boolean).join(' ');
  await runAsync(cmd);
  return true;
}

/* ==================== 5. 合成 + 拼接 ==================== */

async function compositeAll(segments, posterFrame) {
  const segDir = path.join(TEMP_DIR, 'segments');
  ensureDir(segDir);
  const parts = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const outPath = path.join(segDir, `part_${String(i).padStart(2, '0')}.mp4`);

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 5000) {
      console.log(`  ✅ part_${i} (cached)`);
      parts.push(outPath); continue;
    }

    const dur = seg.actualDuration || seg.duration;
    try {
      if (seg.type === 'intro') {
        const ok = await makeIntroMontage(segments, seg, outPath);
        if (!ok) await makeTextSegment(seg, outPath, dur, posterFrame);
      } else if (seg.type === 'chart' && seg.chartVideoPath && fs.existsSync(seg.chartVideoPath)) {
        await makeChartSegment(seg, outPath, dur);
      } else if (seg.clipPath && fs.existsSync(seg.clipPath)) {
        await makeRankingSegment(seg, outPath, dur);
      } else {
        await makeTextSegment(seg, outPath, dur, posterFrame);
      }

      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 5000) {
        parts.push(outPath);
        const src = seg.type === 'intro' ? 'montage'
          : seg.type === 'chart' ? 'chart'
          : seg.clipPath ? 'video' : 'poster';
        const actualDur = getVideoDuration(outPath) || dur;
        console.log(`  ✅ part_${i} (${src} ${actualDur.toFixed(1)}s)`);
      } else {
        console.log(`  ❌ part_${i} 生成失败`);
      }
    } catch (e) {
      console.log(`  ❌ part_${i}: ${(e.message || '').substring(0, 400)}`);
    }
  }
  return parts;
}

async function concatFinal(parts, outputPath) {
  if (parts.length === 1) { fs.copyFileSync(parts[0], outputPath); return; }

  // 使用 fade through black 转场 — 比 xfade 可靠
  // 每段首尾各 0.3s fade in/out
  const FADE_DUR = 0.3;
  const durations = parts.map(p => getVideoDuration(p) || 8);
  const fadedDir = path.join(TEMP_DIR, 'faded');
  ensureDir(fadedDir);

  // helper: 检查文件是否含音频流
  function hasAudio(file) {
    try {
      const out = execSync(`ffprobe -v error -show_entries stream=codec_type -of csv "${file}"`).toString();
      return out.includes('audio');
    } catch { return false; }
  }

  // 给每段添加首尾淡入淡出
  const fadedParts = [];
  for (let i = 0; i < parts.length; i++) {
    const fp = path.join(fadedDir, `faded_${String(i).padStart(2, '0')}.mp4`);
    if (fs.existsSync(fp) && fs.statSync(fp).size > 5000) {
      fadedParts.push(fp); continue;
    }
    const d = durations[i];
    const fadeIn = i > 0 ? `fade=t=in:st=0:d=${FADE_DUR},` : '';
    const fadeOut = i < parts.length - 1 ? `fade=t=out:st=${(d - FADE_DUR).toFixed(2)}:d=${FADE_DUR}` : 'null';
    const partHasAudio = hasAudio(parts[i]);
    let afOpt = '';
    if (partHasAudio) {
      const afadeIn = i > 0 ? `afade=t=in:st=0:d=${FADE_DUR},` : '';
      const afadeOut = i < parts.length - 1 ? `afade=t=out:st=${(d - FADE_DUR).toFixed(2)}:d=${FADE_DUR}` : 'anull';
      afOpt = `-af "${afadeIn}${afadeOut}"`;
    }
    try {
      await runAsync(
        `ffmpeg -y -i "${parts[i]}" -vf "${fadeIn}${fadeOut}" ${afOpt} ` +
        `-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -r 30 -pix_fmt yuv420p "${fp}" 2>/dev/null`
      );
      fadedParts.push(fp);
    } catch {
      fadedParts.push(parts[i]); // fallback to unfaded
    }
  }

  // 确保所有片段都有音频流（无音频的补静音轨），concat 要求流结构一致
  // 从现有带音频的片段获取采样率和声道数
  let sampleRate = '24000', channelLayout = 'mono';
  for (const fp of fadedParts) {
    if (hasAudio(fp)) {
      try {
        const info = execSync(`ffprobe -v error -show_entries stream=sample_rate,channel_layout -select_streams a -of csv "${fp}"`).toString().trim();
        const m = info.match(/stream,(\d+),(\w+)/);
        if (m) { sampleRate = m[1]; channelLayout = m[2]; }
      } catch {}
      break;
    }
  }
  for (let i = 0; i < fadedParts.length; i++) {
    if (!hasAudio(fadedParts[i])) {
      const withAudio = path.join(fadedDir, `faded_${String(i).padStart(2, '0')}_a.mp4`);
      try {
        await runAsync(
          `ffmpeg -y -i "${fadedParts[i]}" -f lavfi -i anullsrc=r=${sampleRate}:cl=${channelLayout} ` +
          `-c:v copy -c:a aac -b:a 128k -shortest "${withAudio}" 2>/dev/null`
        );
        fadedParts[i] = withAudio;
      } catch {}
    }
  }

  // 简单concat拼接（各段已有淡入淡出，衔接自然）
  const listFile = path.join(TEMP_DIR, 'concat_list.txt');
  fs.writeFileSync(listFile, fadedParts.map(p => `file '${p}'`).join('\n'));
  await runAsync(
    `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset medium -crf 22 ` +
    `-c:a aac -b:a 128k -r 30 -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
  );

  const size = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  const durStr = getVideoDuration(outputPath);
  console.log(`✅ 视频已生成: ${outputPath}`);
  console.log(`   大小: ${size} MB | 时长: ${durStr.toFixed(1)}s`);
}

/* ==================== SFX 混音 ==================== */

async function addSfx(inputPath, outputPath, segments) {
  const dingSfx = path.join(SFX_DIR, 'ding.mp3');
  const whooshSfx = path.join(SFX_DIR, 'whoosh.mp3');
  const transSfx = path.join(SFX_DIR, 'transition.mp3');

  if (!fs.existsSync(dingSfx) || !fs.existsSync(transSfx)) {
    console.log('  ⚠️ 音效文件缺失，跳过SFX');
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  // 计算每段的起始时间
  let t = 0;
  const sfxParts = [];
  for (const seg of segments) {
    const dur = seg.actualDuration || seg.duration;
    if (seg.type === 'ranking') {
      sfxParts.push({ time: t, sfx: dingSfx });
    } else if (seg.type === 'chart' || seg.type === 'trend') {
      sfxParts.push({ time: t, sfx: transSfx });
    } else if (seg.type === 'intro') {
      sfxParts.push({ time: t, sfx: whooshSfx });
    }
    t += dur;
  }

  if (!sfxParts.length) {
    fs.copyFileSync(inputPath, outputPath);
    return;
  }

  // 用 amix 叠加，但用 volume 补偿主音轨被稀释的问题
  const n = sfxParts.length + 1;
  const sfxInputs = sfxParts.map(s => `-i "${s.sfx}"`).join(' ');
  const delays = sfxParts.map((s, i) =>
    `[${i + 1}:a]adelay=${Math.round(s.time * 1000)}|${Math.round(s.time * 1000)},volume=0.6[sfx${i}]`
  ).join(';');
  const mixLabels = sfxParts.map((_, i) => `[sfx${i}]`).join('');
  const filterComplex = `${delays};[0:a]${mixLabels}amix=inputs=${n}:duration=first:dropout_transition=2,volume=${n}[aout]`;

  try {
    await runAsync(
      `ffmpeg -y -i "${inputPath}" ${sfxInputs} ` +
      `-filter_complex "${filterComplex}" ` +
      `-map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 128k "${outputPath}" 2>/dev/null`
    );
  } catch {
    console.log('  ⚠️ SFX混音失败，用原版');
    fs.copyFileSync(inputPath, outputPath);
  }
}

/* ==================== 1.5x 加速 ==================== */

async function makeSpeedVersion(inputPath, outputPath) {
  await runAsync(
    `ffmpeg -y -i "${inputPath}" ` +
    `-filter_complex "[0:v]setpts=PTS/1.5[v];[0:a]atempo=1.5[a]" ` +
    `-map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 22 ` +
    `-c:a aac -b:a 128k -r 30 -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
  );
}

/* ==================== Remotion 图表渲染 ==================== */

const REMOTION_TAG_RULES = [
  { name: '古风', pattern: /古风|古装|国风|古偶/ },
  { name: '仙侠玄幻', pattern: /仙侠|武侠|玄幻|修仙/ },
  { name: '恐怖惊悚', pattern: /恐怖|惊悚|克苏鲁|诡/ },
  { name: '末日丧尸', pattern: /末日|丧尸/ },
  { name: '搞笑轻喜', pattern: /搞笑|抽象|喜剧|女频/ },
  { name: '言情甜宠', pattern: /言情|恋爱|甜宠|强制爱/ },
  { name: 'IP改编', pattern: /白雪公主|童话|赵云|三国|西游|霍去病|海贼王|成龙历险记/ },
  { name: '历史正剧', pattern: /历史|正剧/ },
  { name: '大女主', pattern: /大女主|女性成长|女性穿越|独立女性|杀夫证道/ },
  { name: '打脸虐渣', pattern: /打脸|虐渣|复仇|恶毒女配|剧情反转/ },
  { name: '总裁豪门', pattern: /总裁|霸总|豪门/ },
  { name: '逆袭', pattern: /逆袭|翻身|扮猪吃虎/ },
  { name: '穿越', pattern: /穿越/ },
  { name: '师徒', pattern: /师徒|师姐|师父/ },
  { name: '现代都市', pattern: /现代|都市|日常/ },
  { name: '虐恋', pattern: /虐恋|虐心/ },
];

function analyzeRemotionTags(items) {
  const tagMap = new Map();
  for (const rule of REMOTION_TAG_RULES) {
    tagMap.set(rule.name, { name: rule.name, count: 0, totalHeat: 0, totalLikes: 0, totalShares: 0 });
  }
  for (const item of items) {
    const title = item.title || '';
    for (const rule of REMOTION_TAG_RULES) {
      if (!rule.pattern.test(title)) continue;
      const target = tagMap.get(rule.name);
      target.count += 1;
      target.totalHeat += Number(item.heat_score || 0);
      target.totalLikes += Number(item.liked_count || 0);
      target.totalShares += Number(item.share_count || 0);
    }
  }
  return [...tagMap.values()]
    .filter(tag => tag.count > 0)
    .map(tag => ({
      ...tag,
      avgHeat: Math.round(tag.totalHeat / tag.count),
      avgLikes: Math.round(tag.totalLikes / tag.count),
      avgShares: Math.round(tag.totalShares / tag.count),
    }));
}

function analyzeAllTags(items) {
  const tags = analyzeRemotionTags(items);
  const overallAvgHeat = tags.length ? tags.reduce((sum, t) => sum + t.avgHeat, 0) / tags.length : 0;
  return { tags, overallAvgHeat, totalItems: items.length };
}

function buildDarkHorseData(items, rankDate) {
  const now = new Date(`${rankDate}T00:00:00+08:00`).getTime() / 1000;
  return items
    .filter(item => Number(item.create_time || 0) > 0)
    .map(item => {
      const days = Math.max(1, (now - Number(item.create_time)) / 86400);
      const dailyEngagement = Math.round((Number(item.liked_count || 0) + Number(item.share_count || 0)) / days);
      return { ...item, days: Number(days.toFixed(1)), dailyEngagement };
    })
    .sort((a, b) => b.dailyEngagement - a.dailyEngagement)
    .slice(0, 8);
}

function buildOceanData(items) {
  const tags = analyzeRemotionTags(items);
  const overallAvgHeat = tags.length ? tags.reduce((sum, tag) => sum + tag.avgHeat, 0) / tags.length : 0;
  const sortedCounts = tags.map(tag => tag.count).sort((a, b) => a - b);
  const medianCount = sortedCounts[Math.floor(sortedCounts.length / 2)] || 2;
  const countThreshold = Math.max(medianCount + 1, 3);
  return tags.map(tag => {
    const competition = tag.count;
    const momentum = Math.round((tag.avgLikes + tag.avgShares) / 10000);
    let quadrant = 'cold';
    if (competition >= countThreshold && tag.avgHeat > overallAvgHeat) quadrant = 'red';
    if (competition < countThreshold && tag.avgHeat > overallAvgHeat) quadrant = 'blue';
    if (competition >= countThreshold && tag.avgHeat <= overallAvgHeat) quadrant = 'inner';
    return { ...tag, competition, momentum, quadrant };
  });
}

function buildRemotionSegments(items, rankDate, aiChartNarrations) {
  const top1 = items[0];
  const top2 = items[1];
  const darkHorseData = buildDarkHorseData(items, rankDate);
  const darkHorseChampion = darkHorseData[0];
  const darkHorseRunner = darkHorseData[1];
  const darkHorseThird = darkHorseData[2];
  const tagData = analyzeRemotionTags(items).sort((a, b) => b.avgHeat - a.avgHeat).slice(0, 6);
  const topTag = tagData[0];
  const secondTag = tagData[1];
  const thirdTag = tagData[2];
  const oceanData = buildOceanData(items).slice(0, 8);
  const blueTags = oceanData.filter(item => item.quadrant === 'blue');
  const redTags = oceanData.filter(item => item.quadrant === 'red');
  const blueLead = blueTags[0];
  const blueSecond = blueTags[1];
  const redLead = redTags[0];

  const remotionDefs = [
    {
      file: 'douyin_top10_ranking.mp4',
      label: '📊 前十总览',
      chartType: 'chart_top10',
      text: `先看前十总览。冠军是${extractCleanTitle(top1?.title || '') || '本期冠军'}，亚军是${extractCleanTitle(top2?.title || '') || '第二名'}。头部热度已经明显拉开。`,
    },
    {
      file: 'douyin_darkhorse.mp4',
      label: '🚀 黑马飙升',
      chartType: 'chart_darkhorse',
      text: `再看黑马飙升榜。冲得最快的是${extractCleanTitle(darkHorseChampion?.title || '') || '黑马冠军'}，发布${darkHorseChampion?.days || 1}天，日均互动约${fmtNum(darkHorseChampion?.dailyEngagement || 0)}。后面是${extractCleanTitle(darkHorseRunner?.title || '') || '第二名'}${darkHorseThird ? `和${extractCleanTitle(darkHorseThird.title || '')}` : ''}。`,
    },
    {
      file: 'douyin_track_strength.mp4',
      label: '📈 赛道实力',
      chartType: 'chart_kline',
      text: `赛道实力榜里，最强的是${topTag?.name || '头部赛道'}，第二是${secondTag?.name || '第二赛道'}${thirdTag ? `，第三是${thirdTag.name}` : ''}。热度主要集中在这几类题材。`,
    },
    {
      file: 'douyin_ocean_matrix.mp4',
      label: '🌊 机会矩阵',
      chartType: 'chart_ocean',
      text: `最后看机会矩阵。蓝海机会更值得盯的是${blueLead?.name || '细分题材'}${blueSecond ? `和${blueSecond.name}` : ''}，红海最挤的是${redLead?.name || '头部热门题材'}。想冲榜，先别扎进最拥挤的赛道。`,
    },
  ];

  return remotionDefs
    .map(def => {
      const videoPath = path.join(REMOTION_OUT_DIR, def.file);
      if (!fs.existsSync(videoPath)) return null;
      // 优先使用AI文案，否则模板文案
      const aiText = aiChartNarrations ? aiChartNarrations.get(def.chartType) : null;
      if (aiText) console.log(`  🤖 ${def.label} → AI文案`);
      return {
        type: 'chart',
        text: aiText || def.text,
        duration: getVideoDuration(videoPath) || 10,
        chartVideoPath: videoPath,
        chartLabel: def.label,
        ranking: 0,
      };
    })
    .filter(Boolean);
}

async function renderRemotionCharts(items, rankDate, aiChartNarrations) {
  if (!fs.existsSync(REMOTION_DIR)) {
    console.log('  ⚠️ Remotion目录不存在');
    return [];
  }
  console.log('  🎬 渲染Remotion后半段模版...');
  await runAsync(`cd "${REMOTION_DIR}" && npm run render:all`);
  const segs = buildRemotionSegments(items, rankDate, aiChartNarrations);
  if (segs.length) console.log(`  ✅ Remotion后半段完成 (${segs.length} 段)`);
  return segs;
}

/* ==================== MAIN ==================== */

async function main() {
  console.log(`\n🤖 抖音AI短剧热度榜视频生成器 v2\n${'='.repeat(45)}`);

  const ranking = loadRanking();
  if (!ranking) { console.error('❌ 无排行数据'); process.exit(1); }
  videoDateLabel = ranking.date;
  videoRangeLabel = buildRangeLabel(ranking.items, ranking.date);
  videoTitleLabel = `${videoRangeLabel}AI短剧热门榜`;
  console.log(`📊 数据: ${ranking.date} | ${ranking.items.length} 条`);

  ensureDir(VIDEO_DIR); ensureDir(TEMP_DIR);

  // 是否使用AI智能解说（默认启用，传 --no-ai 可回退模板模式）
  const useAI = !process.argv.includes('--no-ai');

  let segments;
  let aiChartNarrations = new Map();
  if (useAI) {
    console.log('\n🔍 Step 1: 视频内容分析（Whisper + Gemini Vision）');
    const clipList = buildClipList(ranking.items);
    console.log(`  📹 待分析 ${clipList.length} 个视频片段`);
    const analysisMap = await analyzeAllClips(clipList);

    console.log('\n📝 Step 2: AI智能解说生成');
    const result = await buildSmartScript(ranking.items, ranking.date, analysisMap);
    if (!result) {
      console.log('  ⚠️ AI解说失败，回退模板模式');
      segments = buildScript(ranking.items, ranking.date);
    } else {
      segments = result.segments;
      aiChartNarrations = result.chartNarrations || new Map();
    }
  } else {
    console.log('\n📝 Step 1: 模板文案（--no-ai 模式）');
    segments = buildScript(ranking.items, ranking.date);
  }
  console.log(`  共 ${segments.length} 段`);

  console.log('\n🔗 Step 3: 关联视频片段');
  let linked = 0;
  for (const seg of segments) {
    if (!seg.aweme_id) continue;
    const found = fs.readdirSync(CLIP_DIR).filter(f => f.includes(seg.aweme_id) && f.endsWith('.mp4'));
    if (found.length) { seg.clipPath = path.join(CLIP_DIR, found[0]); linked++; }
  }
  console.log(`  🎬 ${linked}/${segments.filter(s => s.aweme_id).length} 个`);

  console.log('\n📊 Step 4: 生成Remotion动画图表');
  try {
    const chartSegs = await renderRemotionCharts(ranking.items, ranking.date, aiChartNarrations);
    if (chartSegs.length) {
      const outroIdx = segments.findIndex(s => s.type === 'outro');
      const trendIdx = segments.findIndex(s => s.type === 'trend');
      const insertAt = outroIdx >= 0 ? outroIdx : (trendIdx >= 0 ? trendIdx : segments.length - 1);
      segments.splice(insertAt, 0, ...chartSegs);
      console.log(`  ✅ 插入 ${chartSegs.length} 个图表段（outro前）`);
    } else {
      console.log('  ⚠️ Remotion未生成任何图表');
    }
  } catch (e) {
    console.log(`  ⚠️ 图表生成跳过: ${(e.message || '').substring(0, 200)}`);
  }

  console.log('\n🎙️ Step 5: TTS配音');
  await generateTTS(segments);

  const posterFrame = path.join(TEMP_DIR, 'poster_bg.png');
  if (!fs.existsSync(posterFrame)) {
    run(`ffmpeg -y -f lavfi -i "color=c=0x0d0a1f:s=${W}x${H}:d=1,format=rgb24" -vframes 1 "${posterFrame}" 2>/dev/null`);
  }

  console.log('\n🎬 Step 6: 合成各片段');
  const parts = await compositeAll(segments, posterFrame);
  if (!parts.length) { console.error('❌ 无可用片段'); process.exit(1); }

  console.log('\n🔗 Step 7: 拼接最终视频');
  const rawPath = path.join(VIDEO_DIR, `douyin_ai_hot_${videoDateLabel}_raw.mp4`);
  await concatFinal(parts, rawPath);

  console.log('\n⚡ Step 8: 1.5x加速 + 音频标准化');
  const outputPath = path.join(VIDEO_DIR, `douyin_ai_hot_${videoDateLabel}.mp4`);
  const rawHasAudio = execSync(`ffprobe -v error -show_entries stream=codec_type -of csv "${rawPath}"`).toString().includes('audio');
  if (rawHasAudio) {
    await runAsync(
      `ffmpeg -y -i "${rawPath}" ` +
      `-filter_complex "[0:v]setpts=PTS/1.5[v];[0:a]atempo=1.5[a]" ` +
      `-map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 22 ` +
      `-c:a aac -b:a 128k -r 30 -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
    );
  } else {
    console.log('  ⚠️ raw无音频，仅加速视频');
    await runAsync(
      `ffmpeg -y -i "${rawPath}" ` +
      `-vf "setpts=PTS/1.5" -an ` +
      `-c:v libx264 -preset medium -crf 22 -r 30 -pix_fmt yuv420p "${outputPath}" 2>/dev/null`
    );
  }

  // 清理中间文件
  try { fs.unlinkSync(rawPath); } catch {}

  const size = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  const dur = getVideoDuration(outputPath);
  console.log(`\n🎉 完成！ ${size} MB | ${dur.toFixed(1)}s (1.5x, loudnorm)`);
  console.log(`  open "${outputPath}"`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
