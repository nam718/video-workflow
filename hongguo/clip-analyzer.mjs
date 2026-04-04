/**
 * 视频片段内容分析模块 — 解说猫模式
 *
 * 对每个 TOP 视频片段进行多维度分析：
 *   1. FFmpeg 抽取关键帧 → Gemini Vision 视觉分析
 *   2. Whisper 语音识别 → 提取台词/对白
 *   3. 综合分析 → 生成内容摘要
 *
 * 结果缓存到 hongguo/analysis/ 避免重复分析
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { callAIVision } from '../shared/call-ai.mjs';

const SCRIPT_DIR = import.meta.dirname;
const ANALYSIS_DIR = path.join(SCRIPT_DIR, 'analysis');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
}

function getVideoDuration(file) {
  const d = run(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`).trim();
  return parseFloat(d) || 0;
}

/* ==================== 1. 关键帧提取 ==================== */

/**
 * 从视频中提取关键帧（等间隔采样）
 * @param {string} videoPath - 视频文件路径
 * @param {number} count - 目标帧数（默认5）
 * @returns {string[]} 关键帧图片路径数组
 */
function extractKeyframes(videoPath, count = 5) {
  const dur = getVideoDuration(videoPath);
  if (dur <= 0) throw new Error(`无法获取视频时长: ${videoPath}`);

  const basename = path.basename(videoPath, path.extname(videoPath));
  const frameDir = path.join(ANALYSIS_DIR, 'frames', basename);
  ensureDir(frameDir);

  // 检查缓存
  const existing = fs.readdirSync(frameDir).filter(f => f.endsWith('.jpg')).sort();
  if (existing.length >= count) {
    console.log(`  📸 关键帧已缓存 (${existing.length} 帧)`);
    return existing.map(f => path.join(frameDir, f));
  }

  // 计算采样点（掐头去尾，避免黑屏/片尾）
  const start = Math.min(1, dur * 0.05);
  const end = dur * 0.95;
  const interval = (end - start) / (count - 1);

  const framePaths = [];
  for (let i = 0; i < count; i++) {
    const ts = start + interval * i;
    const outPath = path.join(frameDir, `frame_${String(i).padStart(3, '0')}.jpg`);
    try {
      run(
        `ffmpeg -y -ss ${ts.toFixed(2)} -i "${videoPath}" ` +
        `-frames:v 1 -q:v 2 -vf "scale=960:-2" "${outPath}" 2>/dev/null`
      );
    } catch {
      // JPEG编码失败时尝试不带scale
      try {
        run(
          `ffmpeg -y -ss ${ts.toFixed(2)} -i "${videoPath}" ` +
          `-frames:v 1 -q:v 2 "${outPath}" 2>/dev/null`
        );
      } catch { /* 跳过无法提取的帧 */ }
    }
    if (fs.existsSync(outPath)) framePaths.push(outPath);
  }

  console.log(`  📸 提取了 ${framePaths.length} 帧关键帧`);
  return framePaths;
}

/* ==================== 2. Whisper 语音识别 ==================== */

/**
 * 用 Whisper 提取视频中的台词/对白
 * @param {string} videoPath - 视频文件路径
 * @returns {string} 识别到的文本（可能为空）
 */
function transcribeAudio(videoPath) {
  const basename = path.basename(videoPath, path.extname(videoPath));
  const cacheFile = path.join(ANALYSIS_DIR, 'transcripts', `${basename}.txt`);
  ensureDir(path.dirname(cacheFile));

  // 检查缓存
  if (fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile, 'utf-8').trim();
    console.log(`  🎤 转录已缓存 (${cached.length} 字符)`);
    return cached;
  }

  // 先提取音频
  const tmpAudio = path.join(ANALYSIS_DIR, 'transcripts', `${basename}.wav`);
  try {
    run(`ffmpeg -y -i "${videoPath}" -ac 1 -ar 16000 -t 120 "${tmpAudio}" 2>/dev/null`);
  } catch {
    console.log(`  🎤 音频提取失败，跳过转录`);
    fs.writeFileSync(cacheFile, '', 'utf-8');
    return '';
  }

  // 调用 Whisper（使用 base 模型，平衡速度和精度）
  const outDir = path.join(ANALYSIS_DIR, 'transcripts');
  try {
    run(
      `whisper "${tmpAudio}" --model base --language zh ` +
      `--output_format txt --output_dir "${outDir}" ` +
      `--no_speech_threshold 0.6 --condition_on_previous_text False 2>/dev/null`
    );

    // Whisper 输出文件名与输入文件同名
    const whisperOut = path.join(outDir, `${basename}.txt`);
    if (fs.existsSync(whisperOut)) {
      const text = fs.readFileSync(whisperOut, 'utf-8').trim();
      // 重命名缓存（Whisper 直接写入的就是我们的缓存文件）
      console.log(`  🎤 转录完成 (${text.length} 字符)`);
      return text;
    }
  } catch (err) {
    console.log(`  🎤 Whisper 转录失败: ${err.message?.slice(0, 80)}`);
  }

  // 清理临时音频
  try { fs.unlinkSync(tmpAudio); } catch {}

  fs.writeFileSync(cacheFile, '', 'utf-8');
  return '';
}

/* ==================== 3. 视觉分析 (Gemini Vision) ==================== */

/**
 * 用视觉大模型分析关键帧画面内容
 * @param {string[]} framePaths - 关键帧图片路径
 * @param {string} title - 视频标题（辅助理解）
 * @returns {Promise<string>} 画面分析文本
 */
async function analyzeVisuals(framePaths, title) {
  const prompt = `你是专业的短视频内容分析师。下面是一个抖音AI短剧的${framePaths.length}张关键帧截图，按时间顺序排列。
视频标题：《${title}》

请分析这些画面并回答：
1. 这个短剧讲了什么故事？（用2-3句话概括核心剧情）
2. 主要角色有哪些？（外貌/身份特征）
3. 画面风格是什么？（如：古风、现代、末日、科幻等）
4. 视觉亮点是什么？（如：特效、构图、色彩等让人印象深刻的地方）
5. 情绪氛围如何？（如：紧张、浪漫、搞笑、史诗感等）

请直接用流畅的中文回答，不需要编号，像在和朋友聊这个视频一样自然地描述。控制在150字以内。`;

  return await callAIVision(prompt, framePaths, {
    systemPrompt: '你是一个专业的AI短剧内容分析师，擅长从画面中提取故事信息和视觉亮点。请用简洁生动的中文回答。',
    maxTokens: 1024,
    timeout: 120000,
  });
}

/* ==================== 4. 综合分析 ==================== */

/**
 * 对单个视频片段进行完整分析（视觉 + 语音 + 综合）
 * @param {string} videoPath - 视频文件路径
 * @param {string} title - 视频标题
 * @returns {Promise<{visuals: string, transcript: string, summary: string}>}
 */
export async function analyzeClip(videoPath, title) {
  const basename = path.basename(videoPath, path.extname(videoPath));
  const cacheFile = path.join(ANALYSIS_DIR, `${basename}.json`);
  ensureDir(ANALYSIS_DIR);

  // 检查缓存
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    console.log(`  ✅ 分析结果已缓存: ${title}`);
    return cached;
  }

  console.log(`\n🔍 分析视频: ${title}`);

  // 1. 提取关键帧
  const framePaths = extractKeyframes(videoPath, 5);

  // 2. Whisper 转录
  const transcript = transcribeAudio(videoPath);

  // 3. 视觉分析
  let visuals = '';
  if (framePaths.length > 0) {
    visuals = await analyzeVisuals(framePaths, title);
    console.log(`  👁️ 视觉分析完成 (${visuals.length} 字符)`);
  }

  // 4. 综合摘要
  const summary = buildSummary(visuals, transcript, title);

  const result = { visuals, transcript, summary };

  // 缓存结果
  fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`  💾 分析结果已缓存`);

  return result;
}

/**
 * 构建综合摘要
 */
function buildSummary(visuals, transcript, title) {
  const parts = [];
  if (visuals) parts.push(visuals);
  if (transcript && transcript.length > 10) {
    parts.push(`视频中的台词/旁白：${transcript.slice(0, 200)}`);
  }
  return parts.join('\n') || `标题为《${title}》的AI短剧视频`;
}

/**
 * 批量分析所有 TOP 视频片段
 * @param {Array<{videoPath: string, title: string, rank: number}>} clips
 * @returns {Promise<Map<string, {visuals: string, transcript: string, summary: string}>>}
 */
export async function analyzeAllClips(clips) {
  const results = new Map();
  for (const clip of clips) {
    if (!fs.existsSync(clip.videoPath)) {
      console.log(`  ⚠️ 视频文件不存在: ${clip.videoPath}`);
      results.set(clip.videoPath, {
        visuals: '',
        transcript: '',
        summary: `标题为《${clip.title}》的AI短剧`,
      });
      continue;
    }

    const result = await analyzeClip(clip.videoPath, clip.title);
    results.set(clip.videoPath, result);

    // 避免API限速，间隔2秒
    await new Promise(r => setTimeout(r, 2000));
  }
  return results;
}
