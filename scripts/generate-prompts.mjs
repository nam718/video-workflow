/**
 * 步骤4：推理分镜提示词
 * 输入：shot_plans.json + analysis.json
 * 输出：shots.json (含 imagePrompt + videoPrompt)
 * 支持自定义预设模板（含上下文变量）
 */
import { callAI, callAIPlain } from '../shared/call-ai.mjs';
import { DEFAULT_PROMPTS, renderTemplate } from '../shared/prompt-defaults.mjs';
import { getPromptTemplates } from '../shared/call-ai.mjs';
import fs from 'fs';
import path from 'path';
import os from 'os';

const _dbgLog = path.join(os.homedir(), 'Desktop', 'prompt-debug.log');
function dbg(msg) { try { fs.appendFileSync(_dbgLog, `[${new Date().toISOString()}] ${msg}\n`); } catch {} console.log(msg); }

function getPrompt(key) {
  const custom = getPromptTemplates();
  const def = DEFAULT_PROMPTS[key];
  return {
    system: (custom[key] && custom[key].system) || def.system,
    user: (custom[key] && custom[key].user) || def.user,
  };
}

/**
 * 检测AI是否拒绝了任务（返回"I'm Claude"等无关内容）
 */
function isRefusal(rawText) {
  if (!rawText) return true;
  // 包含输出标记 → 不是拒绝
  if (rawText.includes('_::~OUTPUT_START::~_')) return false;
  // 常见拒绝关键词
  const refusalPatterns = [
    /I('m| am) Claude/i,
    /made by Anthropic/i,
    /software engineering/i,
    /I can't (provide|help|assist)/i,
    /I need to clarify my role/i,
  ];
  return refusalPatterns.some(p => p.test(rawText));
}

/**
 * 从完整提示词模板中提取核心部分，构建精简版提示词
 * 保留：输入信息、核心规则、输出格式、示例
 * 去掉：影视理论（七情六欲、蒙太奇理论、构图理论、美学理论等）
 */
function buildCondensedPrompt(vars) {
  const prevShot = vars['前面分镜:2'] || '无';
  const nextShot = vars['后面分镜:2'] || '无';
  const inputText = vars['输入文案'] || '';
  const scene = vars.scene || '';
  const characters = vars.characters || '无';
  const visualStyle = vars.visualStyle || '写实';

  return `## 输入信息

## 上下文参考
- **前一个分镜：**${prevShot}
- **后一个分镜：**${nextShot}

## 输入文案
${inputText}

## 场景信息
场景：${scene}
角色：${characters}
风格：${visualStyle}

## 生成规则
1. 所有内容必须严格基于【输入文案】，禁止虚构或添加文案中未提及的情节、动作、场景。
2. 参考前后分镜信息，确保画面连续性和故事衔接。
3. 图片提示词：一句话描述最具代表性的静态画面（构图、人物姿态、环境氛围）。
4. 视频提示词：描述15秒连续画面，包含场景、角色、服装、物品、风格、镜头内容。
5. 每个分镜15秒，对白≤4句，单句≤10字。
6. 镜头总字数不超过1000字。
7. 禁止使用"同上""同前"等省略字眼，所有描述必须完整写出。
8. 添加（no srt）和（no music）标签。
9. 角色对白如有，需包含配音指令：角色｜VoiceID｜状态｜语气特点。

## 输出格式
严格按以下格式输出，第一部分为图片提示词，第二部分为视频提示词：

_::~OUTPUT_START::~_
图片提示词（一句话静态画面描述）
_::~FIELD::~_
场景：（详细场景描述）
角色：（出场角色）
服装：（服装描述）
物品：（关键物品）
风格：参考（知名电影名称）的（风格描述）

镜头1：15s
（详细镜头内容描述，包含画面、动作、光影、情绪）
（no srt，no music）
_::~OUTPUT_END::~_`;
}

/**
 * 解析自定义模板输出结果为 { imagePrompt, videoPrompt }
 */
function parseCustomOutput(rawText) {
  const START = '_::~OUTPUT_START::~_';
  const END = '_::~OUTPUT_END::~_';
  const FIELD = '_::~FIELD::~_';

  let content = rawText;
  const startIdx = content.indexOf(START);
  if (startIdx !== -1) content = content.slice(startIdx + START.length);
  const endIdx = content.indexOf(END);
  if (endIdx !== -1) content = content.slice(0, endIdx);
  content = content.trim();

  // FIELD 格式: 第一部分(imagePrompt) _::~FIELD::~_ 第二部分(videoPrompt)
  const fieldIdx = content.indexOf(FIELD);
  if (fieldIdx !== -1) {
    const imgPart = content.slice(0, fieldIdx).trim();
    const vidPart = content.slice(fieldIdx + FIELD.length).trim();
    return { imagePrompt: imgPart, videoPrompt: vidPart };
  }

  // 尝试解析 JSON（兼容用户返回 JSON 格式）
  try {
    const json = JSON.parse(content);
    if (json.imagePrompt || json.videoPrompt) return json;
  } catch {}

  // 非 JSON：整段内容作为 videoPrompt
  return { imagePrompt: '', videoPrompt: content };
}

/** 为单个分镜生成提示词 */
export async function generateShotPrompt(shot, analysis, visualStyle, customPrompt, context) {
  // 自定义预设模板
  if (customPrompt && customPrompt.user) {
    const system = customPrompt.system || '你是一位专业的AI视频提示词工程师。';
    const template = customPrompt.user;

    const shotContent = ((shot.background || '') + '\n' + (shot.content || '')).trim();

    const vars = {
      script: shotContent,
      '输入文案': shotContent,
      scene: shot.scene || '',
      content: shot.content || '',
      background: shot.background || '',
      characters: (shot.characters || []).join('、'),
      visualStyle: visualStyle || '写实',
      cameraAngle: shot.cameraAngle || '中景',
      cameraMovement: shot.cameraMovement || '固定',
      timeOfDay: shot.timeOfDay || '白天',
    };

    // 上下文变量
    if (context) {
      const { shotPlans, allShots, index } = context;

      // {{前面文案}} — 防盗文案，留空
      vars['前面文案'] = '';

      // {{前面分镜:N}} — 上一个分镜的文本内容
      for (const m of template.matchAll(/\{\{前面分镜:(\d+)\}\}/g)) {
        const n = parseInt(m[1]);
        if (index > 0) {
          const prev = shotPlans[index - 1];
          vars[`前面分镜:${n}`] = ((prev.background || '') + '\n' + (prev.content || '')).trim();
        } else {
          vars[`前面分镜:${n}`] = '无';
        }
      }

      // {{后面分镜:N}} — 下一个分镜的文本内容
      for (const m of template.matchAll(/\{\{后面分镜:(\d+)\}\}/g)) {
        const n = parseInt(m[1]);
        if (index < shotPlans.length - 1) {
          const next = shotPlans[index + 1];
          vars[`后面分镜:${n}`] = ((next.background || '') + '\n' + (next.content || '')).trim();
        } else {
          vars[`后面分镜:${n}`] = '无';
        }
      }
    }

    const prompt = renderTemplate(template, vars);

    let rawText;
    for (let retry = 0; retry < 3; retry++) {
      rawText = await callAIPlain(prompt, {
        systemPrompt: system,
        maxTokens: 32768,
        timeout: 300000,        maxRetries: 1,      });
      if (!isRefusal(rawText)) break;
      dbg(`[自定义模式] AI拒绝了任务(第${retry + 1}次)，重试...`);
    }

    return parseCustomOutput(rawText);
  }

  // 默认模式：使用内置模板，返回 JSON
  const charDescriptions = (shot.characters || []).map(name => {
    const c = (analysis.characters || []).find(ch => ch.name === name);
    return c ? `${c.name}：${c.description}` : name;
  }).join('\n');

  const p = getPrompt('generatePrompts');

  const shotContent = ((shot.background || '') + '\n' + (shot.content || '')).trim();

  const vars = {
    script: shotContent,
    '输入文案': shotContent,
    scene: shot.scene || '',
    content: shot.content || '',
    background: shot.background || '',
    characters: charDescriptions || '无',
    visualStyle: visualStyle || '写实',
    cameraAngle: shot.cameraAngle || '中景',
    cameraMovement: shot.cameraMovement || '固定',
    timeOfDay: shot.timeOfDay || '白天',
  };

  // 上下文变量（与自定义预设模式共用逻辑）
  if (context) {
    const { shotPlans, allShots, index } = context;

    // {{前面文案}} — 防盗文案，留空
    vars['前面文案'] = '';

    // {{前面分镜:N}} — 上一个分镜的文本内容
    for (const m of p.user.matchAll(/\{\{前面分镜:(\d+)\}\}/g)) {
      const n = parseInt(m[1]);
      if (index > 0) {
        const prev = shotPlans[index - 1];
        vars[`前面分镜:${n}`] = ((prev.background || '') + '\n' + (prev.content || '')).trim();
      } else {
        vars[`前面分镜:${n}`] = '无';
      }
    }

    // {{后面分镜:N}} — 下一个分镜的文本内容
    for (const m of p.user.matchAll(/\{\{后面分镜:(\d+)\}\}/g)) {
      const n = parseInt(m[1]);
      if (index < shotPlans.length - 1) {
        const next = shotPlans[index + 1];
        vars[`后面分镜:${n}`] = ((next.background || '') + '\n' + (next.content || '')).trim();
      } else {
        vars[`后面分镜:${n}`] = '无';
      }
    }
  }

  const prompt = renderTemplate(p.user, vars);

  console.log(`[generate-prompts] 默认模式 shot ${context ? context.index + 1 : '?'}`);
  dbg(`=== 默认模式 shot ${context ? context.index + 1 : '?'} ===`);
  dbg(`输入文案 (${vars['输入文案'].length}字): ${vars['输入文案'].slice(0, 200)}`);
  dbg(`前面文案: ${(vars['前面文案'] || '无').slice(0, 150)}`);
  dbg(`前面分镜:2: ${(vars['前面分镜:2'] || '无').slice(0, 150)}`);
  dbg(`后面分镜:2: ${(vars['后面分镜:2'] || '无').slice(0, 150)}`);
  dbg(`scene: ${vars.scene}, characters: ${vars.characters}`);
  dbg(`最终提示词长度: ${prompt.length}`);
  dbg(`提示词前500字: ${prompt.slice(0, 500)}`);

  let rawText;
  for (let retry = 0; retry < 5; retry++) {
    rawText = await callAIPlain(prompt, {
      systemPrompt: p.system,
      maxTokens: 32768,
      timeout: 300000,
      maxRetries: 1,
    });
    if (!isRefusal(rawText)) break;
    dbg(`AI拒绝了任务(第${retry + 1}次)，重试...`);
  }

  console.log(`[generate-prompts] AI 响应长度: ${rawText.length}`);
  dbg(`AI 响应长度: ${rawText.length}`);
  dbg(`AI 响应前300字: ${rawText.slice(0, 300)}`);

  const result = parseCustomOutput(rawText);
  dbg(`解析结果: imagePrompt(${result.imagePrompt.length}字), videoPrompt(${result.videoPrompt.length}字)`);
  dbg(`imagePrompt前200: ${result.imagePrompt.slice(0, 200)}`);
  dbg(`videoPrompt前200: ${result.videoPrompt.slice(0, 200)}`);
  dbg(`===========================`);

  return result;
}

/** 批量生成所有分镜的提示词 */
export async function generatePrompts(shotPlans, analysis, onProgress, visualStyle) {
  const shots = [];

  for (let i = 0; i < shotPlans.length; i++) {
    const shot = shotPlans[i];
    if (onProgress) onProgress(i + 1, shotPlans.length, shot.shotNumber);

    const prompts = await generateShotPrompt(shot, analysis, visualStyle);
    shots.push({
      ...shot,
      imagePrompt: prompts.imagePrompt || '',
      videoPrompt: prompts.videoPrompt || '',
    });
  }

  return shots;
}
