/**
 * 红果短剧热门榜视频生成器
 *
 * 流程: 数据读取 → 文案脚本 → TTS配音 → 封面下载 → ffmpeg合成
 * 输出: 竖屏 1080x1920 短视频
 *
 * 用法: node hongguo/video-maker.mjs
 *       node hongguo/video-maker.mjs --no-clean  # 保留临时文件
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync, exec } from 'child_process';

const SCRIPT_DIR = import.meta.dirname;
const DATA_DIR = path.join(SCRIPT_DIR, 'data');
const VIDEO_DIR = path.join(SCRIPT_DIR, 'videos');
const TEMP_DIR = path.join(SCRIPT_DIR, '.tmp_video');
const CLIP_DIR = path.join(SCRIPT_DIR, 'clips');
const CN_FONT = '/System/Library/Fonts/Hiragino Sans GB.ttc';
let videoDateLabel = '';

// ===================== 工具函数 =====================

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
}

function runAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const doGet = (u) => {
      const mod = u.startsWith('https') ? https : require('http');
      mod.get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doGet(res.headers.location);
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

function loadLatestData() {
  if (!fs.existsSync(DATA_DIR)) return null;
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('hot_') && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, files[0]), 'utf-8')) : null;
}

// ===================== 1. 数据分析 → 脚本 =====================

function analyzeAndScript(items) {
  const segments = [];

  // --- 题材统计 ---
  const tagMap = {};
  for (const item of items) {
    for (const t of (item.playletTags || []).filter(Boolean)) {
      tagMap[t] = (tagMap[t] || 0) + 1;
    }
  }
  const hotTags = Object.entries(tagMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const tagText = hotTags.slice(0, 4).map(([t, n]) => `${t}${n}部`).join('、');

  // --- 开场 Hook ---
  const top3names = items.slice(0, 3).map(i => i.playletName).join('、');
  const hookVariants = [
    `红果短剧今日热门榜出炉！${top3names}强势霸榜前三！什么类型的短剧最受欢迎？三分钟带你看清当下最火的短剧风向。`,
    `短剧圈炸了！红果热门榜TOP10大洗牌，冠军竟然是${items[0].playletName}！题材格局有大变化，创作者必看。`,
    `追短剧的注意了！红果短剧最新热门榜来了，${items[0].playletName}登顶第一，${tagText}。接下来逐一拆解。`,
  ];
  segments.push({
    type: 'intro',
    text: hookVariants[Math.floor(Math.random() * hookVariants.length)],
    duration: 10,
    ranking: 0,
    playletId: '',
  });

  // --- TOP 10 逐一介绍 ---
  const ordinals = ['冠军', '亚军', '季军', '第四', '第五', '第六', '第七', '第八', '第九', '第十'];
  for (let i = 0; i < Math.min(items.length, 10); i++) {
    const item = items[i];
    const tags = (item.playletTags || []).slice(0, 3).join('加') || '剧情';
    const epText = item.episodeCount || '';
    const intro = item.intro ? `，${item.intro.slice(0, 40)}` : '';

    const variants = [
      `${ordinals[i]}！${item.playletName}，${tags}题材，${epText}${intro}。`,
      `第${item.ranking}名，${item.playletName}。${epText}，${tags}赛道${intro}。`,
    ];
    segments.push({
      type: 'ranking',
      text: variants[i % 2],
      duration: 8,
      ranking: item.ranking,
      playletId: item.playletId,
      playletName: item.playletName,
      coverUrl: item.coverOss,
    });
  }

  // --- 题材分析 ---
  const topTag = hotTags[0];
  segments.push({
    type: 'trend',
    text: `看完选手看赛道。今日上榜短剧中，${tagText}。${topTag ? `${topTag[0]}题材最热门` : ''}，追剧的朋友可以重点关注。创作者想入局，建议评估好竞争强度。`,
    duration: 10,
    ranking: 0,
    playletId: '',
  });

  // --- 结尾 CTA ---
  segments.push({
    type: 'outro',
    text: `以上就是今日红果短剧热门榜的完整盘点。觉得有用就点个赞，想追最火短剧，记得关注。我们下期见！`,
    duration: 6,
    ranking: 0,
    playletId: '',
  });

  return segments;
}

// ===================== 2. TTS 配音 =====================

async function generateTTS(segments) {
  console.log('🎙️ 生成TTS配音...');
  const audioDir = path.join(TEMP_DIR, 'audio');
  ensureDir(audioDir);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const audioPath = path.join(audioDir, `seg_${String(i).padStart(2, '0')}.mp3`);
    const subtitlePath = path.join(audioDir, `seg_${String(i).padStart(2, '0')}.srt`);

    if (fs.existsSync(audioPath) && fs.existsSync(subtitlePath)) {
      seg.audioPath = audioPath;
      seg.subtitlePath = subtitlePath;
      const durStr = run(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`).trim();
      seg.actualDuration = parseFloat(durStr) || seg.duration;
      console.log(`  ✅ seg_${i} (cached ${seg.actualDuration.toFixed(1)}s)`);
      continue;
    }

    const textEscaped = seg.text.replace(/"/g, '\\"');
    const cmd = `edge-tts --voice zh-CN-YunxiNeural --rate=+5% --text "${textEscaped}" --write-media "${audioPath}" --write-subtitles "${subtitlePath}" 2>&1`;

    try {
      await runAsync(cmd);
      seg.audioPath = audioPath;
      seg.subtitlePath = subtitlePath;
      const durStr = run(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`).trim();
      seg.actualDuration = parseFloat(durStr) || seg.duration;
      console.log(`  ✅ seg_${i} (${seg.actualDuration.toFixed(1)}s): ${seg.text.slice(0, 25)}...`);
    } catch (e) {
      console.error(`  ❌ seg_${i} TTS失败:`, e.message);
      seg.audioPath = null;
    }
  }
}

// ===================== SRT + 字幕工具 =====================

function parseSrtTimeToSeconds(timeText) {
  const match = (timeText || '').trim().match(/(\d+):(\d+):(\d+),(\d+)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseSrtCues(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];

  const rawCues = content
    .split(/\n\s*\n/)
    .map(block => block.trim().split('\n'))
    .filter(lines => lines.length >= 3)
    .map(lines => {
      const [startText, endText] = (lines[1] || '').split(' --> ');
      return {
        text: lines.slice(2).join('').trim(),
        start: parseSrtTimeToSeconds(startText),
        end: parseSrtTimeToSeconds(endText),
      };
    })
    .filter(cue => cue.text && cue.end > cue.start);

  // 二次拆分: 超14字的 cue 按标点拆
  const splitCues = [];
  for (const cue of rawCues) {
    if (cue.text.length <= 14) { splitCues.push(cue); continue; }
    const parts = cue.text.split(/(?<=[，,、。！？!?；;])/).map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) { splitCues.push(cue); continue; }
    const totalChars = parts.reduce((s, p) => s + p.length, 0);
    const cueDur = cue.end - cue.start;
    let cursor = cue.start;
    for (let j = 0; j < parts.length; j++) {
      const partDur = (parts[j].length / totalChars) * cueDur;
      splitCues.push({ text: parts[j], start: cursor, end: j === parts.length - 1 ? cue.end : cursor + partDur });
      cursor += partDur;
    }
  }
  return splitCues;
}

function buildSubtitleCues(text, dur, maxChars = 14) {
  const cleaned = (text || '').replace(/\s+/g, '').trim();
  if (!cleaned) return [{ text: '', start: 0, end: dur }];

  const rawParts = cleaned.split(/(?<=[。！？!?；;，,、])/).map(s => s.trim()).filter(Boolean);
  const merged = [];
  for (const part of rawParts) {
    if (!merged.length) { merged.push(part); continue; }
    if (merged[merged.length - 1].length < 10) merged[merged.length - 1] += part;
    else merged.push(part);
  }

  const normalized = merged.flatMap(part => {
    if (part.length <= maxChars) return [part];
    const pieces = [];
    for (let i = 0; i < part.length; i += maxChars) pieces.push(part.slice(i, i + maxChars));
    return pieces;
  }).filter(Boolean);

  while (normalized.length > 10) {
    normalized[normalized.length - 2] += normalized[normalized.length - 1];
    normalized.pop();
  }

  const cueCount = Math.max(1, normalized.length);
  const weights = normalized.map(p => Math.max(1, p.length));
  const totalWeight = weights.reduce((s, v) => s + v, 0);
  const minSlot = Math.min(2.2, dur / cueCount);
  let cursor = 0;

  return normalized.map((part, i) => {
    const proportional = dur * (weights[i] / totalWeight);
    const remaining = dur - cursor;
    const remCount = cueCount - i;
    const slot = i === cueCount - 1
      ? remaining + 0.2
      : Math.max(minSlot, Math.min(proportional, remaining - minSlot * (remCount - 1)));
    const cue = { text: part, start: cursor, end: i === cueCount - 1 ? dur + 0.2 : cursor + slot };
    cursor += slot;
    return cue;
  });
}

function escText(t) {
  return t.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:').replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/%/g, '%%');
}

function escapeFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function writeCueTextFiles(baseKey, cues) {
  const dir = path.join(TEMP_DIR, 'cue_texts');
  ensureDir(dir);
  return cues.map((cue, i) => {
    const fp = path.join(dir, `${baseKey}_${i}.txt`);
    fs.writeFileSync(fp, cue.text, 'utf-8');
    return { ...cue, filePath: fp };
  });
}

function buildTimedSubtitleFilters(inputLabel, cues, y, fontSize, finalLabel = '[final]') {
  if (!cues.length) return [`${inputLabel}copy${finalLabel}`];
  const filters = [];
  let prev = inputLabel;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const out = i === cues.length - 1 ? finalLabel : `[sub${i}]`;
    filters.push(
      `${prev}drawtext=fontfile='${CN_FONT}':textfile='${escapeFilterPath(cue.filePath)}':reload=0:fontsize=${fontSize}:fontcolor=white:borderw=2:bordercolor=black@0.8:box=1:boxcolor=black@0.22:boxborderw=18:x=(w-tw)/2:y=${y}:enable='between(t,${cue.start.toFixed(2)},${cue.end.toFixed(2)})'${out}`
    );
    prev = out;
  }
  return filters;
}

// ===================== 3. 下载封面素材 =====================

async function downloadCovers(segments) {
  console.log('📥 下载封面素材...');
  const coverDir = path.join(TEMP_DIR, 'covers');
  ensureDir(coverDir);

  let ok = 0;
  for (const seg of segments) {
    if (!seg.coverUrl) continue;
    const dest = path.join(coverDir, `cover_${seg.playletId}.jpg`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      seg.coverPath = dest;
      ok++;
      continue;
    }
    try {
      await downloadFile(seg.coverUrl, dest);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
        seg.coverPath = dest;
        ok++;
        console.log(`  ✅ ${seg.playletName || seg.type}`);
      }
    } catch {
      console.log(`  ⚠️ 封面失败: ${seg.playletName || seg.type}`);
    }
  }
  console.log(`  📸 封面: ${ok}/${segments.filter(s => s.coverUrl).length} 张`);
}

// ===================== 3.5 关联视频片段 =====================

function linkVideoClips(segments) {
  let linked = 0;
  for (const seg of segments) {
    if (!seg.playletId) continue;
    const clipPath = path.join(CLIP_DIR, `${seg.playletId}.mp4`);
    if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 50000) {
      seg.clipPath = clipPath;
      linked++;
    }
  }
  console.log(`  🎬 视频片段: ${linked}/${segments.filter(s => s.playletId).length} 个`);
}

// ===================== 4. 生成海报帧 =====================

function generatePosterFrame() {
  const posterPath = path.join(TEMP_DIR, 'poster_bg.png');
  if (fs.existsSync(posterPath)) return posterPath;
  // 深色渐变背景
  run(`ffmpeg -y -f lavfi -i "color=c=0x0a0a1d:s=1080x1920:d=1,format=rgb24" -vframes 1 "${posterPath}" 2>/dev/null`);
  return posterPath;
}

// ===================== 5. 合成视频片段 =====================

const SUBTITLE_Y = 1520;

async function compositeSegments(segments, posterFrame) {
  console.log('🎬 合成视频片段...');
  const segDir = path.join(TEMP_DIR, 'segments');
  ensureDir(segDir);
  const parts = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const outPath = path.join(segDir, `part_${String(i).padStart(2, '0')}.mp4`);

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 5000) {
      console.log(`  ✅ part_${i} (cached)`);
      parts.push(outPath);
      continue;
    }

    const dur = seg.actualDuration || seg.duration;
    try {
      if (seg.clipPath && fs.existsSync(seg.clipPath)) {
        await makeVideoSegment(seg, outPath, dur);
      } else if (seg.coverPath && fs.existsSync(seg.coverPath)) {
        await makeCoverSegment(seg, outPath, dur);
      } else {
        await makePosterSegment(posterFrame, seg, outPath, dur);
      }
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 5000) {
        parts.push(outPath);
        const src = seg.clipPath ? 'video' : seg.coverPath ? 'cover' : 'poster';
        console.log(`  ✅ part_${i} (${src} ${dur.toFixed(1)}s)`);
      } else {
        console.log(`  ❌ part_${i} 生成失败`);
      }
    } catch (e) {
      console.log(`  ❌ part_${i}: ${(e.message || '').slice(-800)}`);
    }
  }
  return parts;
}

// 视频片段: 取视频开头，裁剪为 1080x1920 竖屏 + 排名角标 + 字幕
async function makeVideoSegment(seg, outPath, dur) {
  const subtitleCues = writeCueTextFiles(
    path.basename(outPath, '.mp4'),
    parseSrtCues(seg.subtitlePath).length ? parseSrtCues(seg.subtitlePath) : buildSubtitleCues(seg.text, dur)
  );

  // 视频处理: 缩放到 1080 宽度，裁剪高度到 1920，居中裁切
  const filters = [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[base]`,
  ];

  let label = '[base]';

  if (videoDateLabel) {
    filters.push(
      `${label}drawtext=fontfile='${CN_FONT}':text='${escText(videoDateLabel)}':fontsize=52:fontcolor=white@0.7:borderw=1:bordercolor=black@0.3:x=(w-tw)/2:y=160[dated]`
    );
    label = '[dated]';
  }

  if (seg.ranking) {
    filters.push(
      `${label}drawtext=fontfile='${CN_FONT}':text='TOP ${seg.ranking}':fontsize=90:fontcolor=gold:borderw=3:bordercolor=black:x=40:y=50[ranked]`
    );
    label = '[ranked]';
  }

  filters.push(...buildTimedSubtitleFilters(label, subtitleCues, SUBTITLE_Y, 50));

  const cmd = [
    `ffmpeg -y -i "${seg.clipPath}"`,
    seg.audioPath ? `-i "${seg.audioPath}"` : '',
    `-t ${dur + 0.3}`,
    `-filter_complex "${filters.join(';')}"`,
    `-map "[final]"`,
    seg.audioPath ? `-map 1:a` : `-an`,
    `-c:v libx264 -preset fast -crf 23`,
    seg.audioPath ? `-c:a aac -b:a 128k` : '',
    `-r 30 -pix_fmt yuv420p -shortest`,
    `"${outPath}"`,
  ].filter(Boolean).join(' ');
  await runAsync(cmd);
}

// 封面图片段: 封面居中 + Ken Burns 缩放动画 + 黑色背景 + 排名角标 + 字幕
async function makeCoverSegment(seg, outPath, dur) {
  const subtitleCues = writeCueTextFiles(
    path.basename(outPath, '.mp4'),
    parseSrtCues(seg.subtitlePath).length ? parseSrtCues(seg.subtitlePath) : buildSubtitleCues(seg.text, dur)
  );

  // Ken Burns: 随机选择缩放方向（zoom in 或 zoom out），添加轻微平移
  const zoomIn = (seg.ranking || 0) % 2 === 1;  // 奇数排名 zoom in，偶数 zoom out
  const zoomStart = zoomIn ? 1.0 : 1.15;
  const zoomEnd = zoomIn ? 1.15 : 1.0;
  const panX = zoomIn ? 10 : -10; // 轻微往右或往左平移

  const filters = [
    // 先放大封面到足够尺寸，再用 zoompan 实现 Ken Burns 动画
    `[0:v]scale=1200:-2,zoompan=z='${zoomStart}+(${zoomEnd}-${zoomStart})*on/((${Math.ceil(dur)}+1)*30)':x='iw/2-(iw/zoom/2)+${panX}*on/((${Math.ceil(dur)}+1)*30)':y='ih/2-(ih/zoom/2)':d=${Math.ceil(dur + 1) * 30}:s=960x800:fps=30[kburns]`,
    `[kburns]pad=1080:1920:(1080-iw)/2:(1920-ih)/2-200:black[base]`,
  ];

  if (videoDateLabel) {
    filters.push(
      `[base]drawtext=fontfile='${CN_FONT}':text='${escText(videoDateLabel)}':fontsize=52:fontcolor=white@0.7:borderw=1:bordercolor=black@0.3:x=(w-tw)/2:y=160[dated]`
    );
  }
  let label = videoDateLabel ? '[dated]' : '[base]';

  if (seg.ranking) {
    filters.push(
      `${label}drawtext=fontfile='${CN_FONT}':text='TOP ${seg.ranking}':fontsize=90:fontcolor=gold:borderw=3:bordercolor=black:x=40:y=50[ranked]`
    );
    label = '[ranked]';
  }

  filters.push(...buildTimedSubtitleFilters(label, subtitleCues, SUBTITLE_Y, 50));

  const cmd = [
    `ffmpeg -y -loop 1 -i "${seg.coverPath}"`,
    seg.audioPath ? `-i "${seg.audioPath}"` : '',
    `-t ${dur + 0.3}`,
    `-filter_complex "${filters.join(';')}"`,
    `-map "[final]"`,
    seg.audioPath ? `-map 1:a` : `-an`,
    `-c:v libx264 -preset fast -crf 23`,
    seg.audioPath ? `-c:a aac -b:a 128k` : '',
    `-r 30 -pix_fmt yuv420p -shortest`,
    `"${outPath}"`,
  ].filter(Boolean).join(' ');
  await runAsync(cmd);
}

// 纯海报背景: 标签 + 字幕
async function makePosterSegment(posterFrame, seg, outPath, dur) {
  const subtitleCues = writeCueTextFiles(
    path.basename(outPath, '.mp4'),
    parseSrtCues(seg.subtitlePath).length ? parseSrtCues(seg.subtitlePath) : buildSubtitleCues(seg.text, dur)
  );

  const typeLabel = {
    intro: '📊 热门榜单', ranking: '🏆 排名', trend: '📈 题材分析', outro: '👋 下期再见',
  };
  const lbl = escText(typeLabel[seg.type] || '');
  const dateFilter = videoDateLabel
    ? `drawtext=fontfile='${CN_FONT}':text='${escText(videoDateLabel)}':fontsize=52:fontcolor=white@0.7:borderw=1:bordercolor=black@0.3:x=(w-tw)/2:y=160,`
    : '';

  const filters = [
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bg]`,
    `[bg]${dateFilter}drawtext=fontfile='${CN_FONT}':text='${lbl}':fontsize=52:fontcolor=cyan:borderw=2:bordercolor=black:x=(w-tw)/2:y=200[withlabel]`,
    ...buildTimedSubtitleFilters('[withlabel]', subtitleCues, SUBTITLE_Y, 50),
  ].join(';');

  const cmd = [
    `ffmpeg -y -loop 1 -i "${posterFrame}"`,
    seg.audioPath ? `-i "${seg.audioPath}"` : '',
    `-t ${dur + 0.3}`,
    `-filter_complex "${filters}"`,
    `-map "[final]"`,
    seg.audioPath ? `-map 1:a` : `-an`,
    `-c:v libx264 -preset fast -crf 23`,
    seg.audioPath ? `-c:a aac -b:a 128k` : '',
    `-r 30 -pix_fmt yuv420p -shortest`,
    `"${outPath}"`,
  ].filter(Boolean).join(' ');
  await runAsync(cmd);
}

// ===================== 6. 拼接最终视频 =====================

async function concatFinal(parts, outputPath) {
  console.log('🔗 拼接最终视频...');

  if (parts.length === 1) {
    fs.copyFileSync(parts[0], outputPath);
    return;
  }

  const durations = parts.map(p => {
    const d = run(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`).trim();
    return parseFloat(d) || 5;
  });

  const XFADE_DUR = 0.8;
  const transitions = ['fade', 'slideright', 'slideleft', 'fadeblack', 'smoothleft', 'wiperight'];

  const inputs = parts.map(p => `-i "${p}"`).join(' ');
  const vFilters = [];
  const aFilters = [];
  let cumOffset = 0;

  for (let i = 0; i < parts.length - 1; i++) {
    cumOffset += durations[i] - XFADE_DUR;
    const trans = transitions[i % transitions.length];
    const prevV = i === 0 ? '[0:v]' : `[v${String(i - 1).padStart(2, '0')}]`;
    const nextV = `[${i + 1}:v]`;
    const outV = i === parts.length - 2 ? '[vout]' : `[v${String(i).padStart(2, '0')}]`;
    vFilters.push(`${prevV}${nextV}xfade=transition=${trans}:duration=${XFADE_DUR}:offset=${cumOffset.toFixed(2)}${outV}`);

    const prevA = i === 0 ? '[0:a]' : `[a${String(i - 1).padStart(2, '0')}]`;
    const nextA = `[${i + 1}:a]`;
    const outA = i === parts.length - 2 ? '[aout]' : `[a${String(i).padStart(2, '0')}]`;
    aFilters.push(`${prevA}${nextA}acrossfade=d=${XFADE_DUR}${outA}`);
  }

  const cmd = [
    `ffmpeg -y`, inputs,
    `-filter_complex "${[...vFilters, ...aFilters].join(';')}"`,
    `-map "[vout]" -map "[aout]"`,
    `-c:v libx264 -preset medium -crf 22`,
    `-c:a aac -b:a 128k -r 30 -pix_fmt yuv420p`,
    `"${outputPath}" 2>/dev/null`,
  ].join(' ');

  try {
    await runAsync(cmd);
  } catch {
    console.log('  ⚠️ xfade失败，用简单拼接');
    const listFile = path.join(TEMP_DIR, 'concat_list.txt');
    fs.writeFileSync(listFile, parts.map(p => `file '${p}'`).join('\n'));
    await runAsync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset medium -crf 22 -c:a aac -b:a 128k -r 30 -pix_fmt yuv420p "${outputPath}" 2>/dev/null`);
  }

  const size = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
  const durStr = run(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${outputPath}"`).trim();
  console.log(`✅ 视频已生成: ${outputPath}`);
  console.log(`   大小: ${size} MB | 时长: ${parseFloat(durStr).toFixed(1)}s`);
}

// ===================== MAIN =====================

async function main() {
  const args = process.argv.slice(2);
  const noClean = args.includes('--no-clean');

  console.log(`\n🎬 红果短剧热门榜视频生成器\n${'='.repeat(40)}`);

  // 加载数据
  const dataFile = loadLatestData();
  if (!dataFile) {
    console.error('❌ 无数据，请先运行 node hongguo/scraper.mjs');
    process.exit(1);
  }
  const items = dataFile.data || [];
  videoDateLabel = dataFile.queryDate || new Date().toISOString().slice(0, 10);
  console.log(`📊 数据: ${dataFile.queryDate} | ${items.length} 条`);

  ensureDir(VIDEO_DIR);
  ensureDir(TEMP_DIR);

  // Step 1: 脚本
  console.log('\n📝 Step 1: 生成解说脚本');
  const segments = analyzeAndScript(items);
  console.log(`  共 ${segments.length} 段, 预计 ${segments.reduce((s, seg) => s + seg.duration, 0)}s`);

  // Step 2: TTS
  console.log('\n🎙️ Step 2: TTS配音');
  await generateTTS(segments);

  // Step 3: 下载封面素材
  console.log('\n📥 Step 3: 下载封面素材');
  await downloadCovers(segments);

  // Step 3.5: 关联视频片段
  console.log('\n🔗 Step 3.5: 关联视频片段');
  linkVideoClips(segments);

  // Step 4: 海报背景
  console.log('\n🎨 Step 4: 生成背景帧');
  const posterFrame = generatePosterFrame();

  // Step 5: 合成片段
  console.log('\n🎬 Step 5: 合成各片段');
  const parts = await compositeSegments(segments, posterFrame);
  if (parts.length === 0) { console.error('❌ 无可用片段'); process.exit(1); }

  // Step 6: 拼接
  console.log('\n🔗 Step 6: 拼接最终视频');
  const outputPath = path.join(VIDEO_DIR, `hongguo_hot_${videoDateLabel}.mp4`);
  await concatFinal(parts, outputPath);

  // 清理
  if (!noClean) {
    console.log('\n🧹 清理临时文件...');
    const segDir = path.join(TEMP_DIR, 'segments');
    if (fs.existsSync(segDir)) fs.rmSync(segDir, { recursive: true });
  }

  console.log(`\n🎉 完成！打开视频: open "${outputPath}"`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
