/**
 * 剧本转换：将小说/话本原文直接转换为分镜
 * 支持两种模式（自动检测）：
 * - 全文模式：一次性发送全部剧本（默认，使用 _::~RECORD::~_ 格式）
 * - 逐段模式：按段落分段发送，携带上下文（检测到 {{前面文案}} 等变量时自动启用）
 */
import { callAIPlain, getPromptTemplates } from '../shared/call-ai.mjs';
import { DEFAULT_PROMPTS, renderTemplate } from '../shared/prompt-defaults.mjs';

function getPrompt(key) {
  const custom = getPromptTemplates();
  const def = DEFAULT_PROMPTS[key];
  if (!def) throw new Error(`未找到提示词模板: ${key}`);
  return {
    system: (custom[key] && custom[key].system) || def.system,
    user: (custom[key] && custom[key].user) || def.user,
  };
}

/**
 * 检测提示词模板是否需要逐段模式（含上下文变量）
 */
function needsSegmentedMode(template) {
  return /\{\{前面文案\}\}|\{\{前面分镜|\{\{后面文案\}\}|\{\{后面分镜/.test(template);
}

/**
 * 将剧本文本分割为段落
 * 按双换行分割，合并过短段落
 */
function splitIntoSegments(text) {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return paragraphs.length ? paragraphs : [text.trim()];

  const segments = [];
  let current = '';
  for (const p of paragraphs) {
    if (!current) {
      current = p;
    } else if (current.length < 30 || p.length < 30) {
      current += '\n\n' + p;
    } else {
      segments.push(current);
      current = p;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * 从文本中提取 【角色名】
 */
function extractCharacters(text) {
  const characters = new Set();
  const skipKeys = ['字幕', '画面', '音效', '特写', '动画', '特效', '镜头', '转场'];
  for (const m of text.matchAll(/【([^】（(]+?)(?:[（(][^）)]*[）)])?】/g)) {
    const name = m[1].trim();
    if (!skipKeys.some(k => name.includes(k)) && !name.startsWith('VO') && !name.startsWith('OS')) {
      characters.add(name);
    }
  }
  return [...characters];
}

/**
 * 解析 _::~RECORD::~_ 格式（原有逻辑）
 */
function parseRecordFormat(content) {
  const SEP = '_::~RECORD::~_';
  const blocks = content.split(SEP).map(b => b.trim()).filter(Boolean);
  if (!blocks.length) throw new Error('转换结果为空，未找到有效分镜记录');

  const shots = [];
  let globalShotNum = 1;

  for (const block of blocks) {
    const lines = block.split('\n');
    let background = '';
    let highlights = '';
    let scene = '';
    const contentLines = [];

    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('背景：') || t.startsWith('背景:')) {
        background = t.replace(/^背景[：:]/, '').trim();
      } else if (t.startsWith('看点：') || t.startsWith('看点:')) {
        highlights = t.replace(/^看点[：:]/, '').trim();
      } else if (t.startsWith('场景：') || t.startsWith('场景:')) {
        scene = t.replace(/^场景[：:]/, '').trim();
      } else {
        contentLines.push(line);
      }
    }

    shots.push({
      shotNumber: globalShotNum++,
      chapter: 1,
      scene,
      background,
      highlights,
      content: contentLines.join('\n').trim(),
      characters: extractCharacters(block),
      cameraAngle: '中景',
      cameraMovement: '固定',
      duration: 5,
    });
  }

  return shots;
}

/**
 * 解析 _::~FIELD::~_ 格式的单个分镜组块
 */
function parseFieldBlock(text, shotNumber) {
  const FIELD = '_::~FIELD::~_';
  let body = text;

  const fieldIdx = text.indexOf(FIELD);
  if (fieldIdx !== -1) {
    body = text.slice(fieldIdx + FIELD.length).trim();
  }

  let scene = '';
  const sceneMatch = body.match(/^场景[：:]\s*(.+)$/m);
  if (sceneMatch) scene = sceneMatch[1].trim();

  return {
    shotNumber,
    chapter: 1,
    scene,
    background: '',
    highlights: '',
    content: body,
    characters: extractCharacters(body),
    cameraAngle: '中景',
    cameraMovement: '固定',
    duration: 12,
  };
}

/**
 * 自动检测并解析 AI 转换结果
 * 支持 _::~RECORD::~_ 和 _::~FIELD::~_ 两种格式
 */
export function parseConvertedShots(text) {
  const START = '_::~OUTPUT_START::~_';
  const END = '_::~OUTPUT_END::~_';

  let content = text;
  const startIdx = content.indexOf(START);
  if (startIdx !== -1) content = content.slice(startIdx + START.length);
  const endIdx = content.indexOf(END);
  if (endIdx !== -1) content = content.slice(0, endIdx);
  content = content.trim();

  if (!content) throw new Error('转换结果为空，未找到有效分镜记录');

  const hasRecord = content.includes('_::~RECORD::~_');
  const hasField = content.includes('_::~FIELD::~_');

  if (hasRecord) {
    return parseRecordFormat(content);
  } else if (hasField) {
    return [parseFieldBlock(content, 1)];
  } else {
    // 兜底：将整段内容作为一个分镜
    return [{
      shotNumber: 1,
      chapter: 1,
      scene: '',
      background: '',
      highlights: '',
      content,
      characters: extractCharacters(content),
      cameraAngle: '中景',
      cameraMovement: '固定',
      duration: 12,
    }];
  }
}

/**
 * 逐段转换：按段落分段处理，携带上下文
 */
async function convertScriptSegmented(scriptText, customPrompt) {
  const segments = splitIntoSegments(scriptText);
  console.log(`[convert-script] 逐段模式: ${segments.length} 个段落`);

  const allShots = [];
  const system = customPrompt.system || '你是一位专业的文案编剧。';
  const template = customPrompt.user;

  for (let i = 0; i < segments.length; i++) {
    const currentText = segments[i];
    const prevText = i > 0 ? segments[i - 1] : '无';

    const vars = {
      script: currentText,
      '输入文案': currentText,
      '前面文案': prevText,
    };

    // 动态解析 {{前面分镜:N}} — 取最近 N 个已生成分镜
    for (const m of template.matchAll(/\{\{前面分镜:(\d+)\}\}/g)) {
      const n = parseInt(m[1]);
      vars[`前面分镜:${n}`] = allShots.slice(-n).map(s => s.content).join('\n---\n') || '无';
    }

    // 动态解析 {{后面分镜:N}} — 取后续 N 段原文作为预览
    for (const m of template.matchAll(/\{\{后面分镜:(\d+)\}\}/g)) {
      const n = parseInt(m[1]);
      vars[`后面分镜:${n}`] = segments.slice(i + 1, i + 1 + n).join('\n---\n') || '无';
    }

    const prompt = renderTemplate(template, vars);

    console.log(`[convert-script] 段落 ${i + 1}/${segments.length}, 长度: ${currentText.length}`);

    const rawText = await callAIPlain(prompt, {
      systemPrompt: system,
      maxTokens: 32768,
    });

    try {
      const segmentShots = parseConvertedShots(rawText);
      for (const s of segmentShots) {
        s.shotNumber = allShots.length + 1;
        allShots.push(s);
      }
    } catch (e) {
      console.error(`[convert-script] 段落 ${i + 1} 解析失败: ${e.message}`);
      allShots.push({
        shotNumber: allShots.length + 1,
        chapter: 1,
        scene: '',
        background: '',
        highlights: '',
        content: rawText.trim(),
        characters: extractCharacters(rawText),
        cameraAngle: '中景',
        cameraMovement: '固定',
        duration: 12,
      });
    }
  }

  if (!allShots.length) throw new Error('转换结果为空');
  console.log(`[convert-script] 逐段转换完成, 共 ${allShots.length} 个分镜`);
  return allShots;
}

/**
 * 将剧本文本转换为分镜（自动检测全文/逐段模式）
 * @param {string} scriptText - 原始剧本文本
 * @param {{ system: string, user: string }} [customPrompt] - 自定义提示词（预设）
 */
export async function convertScript(scriptText, customPrompt, analysisNames) {
  let system, user;
  if (customPrompt && customPrompt.user) {
    system = customPrompt.system || '你是一位专业的文案编剧。';
    user = customPrompt.user;
  } else {
    const p = getPrompt('convertScript');
    system = p.system;
    user = p.user;
  }

  // 如果有分析结果的角色/场景名列表，追加到system prompt，引导AI使用标准名称
  if (analysisNames) {
    const parts = [];
    if (analysisNames.characters?.length) parts.push(`角色：${analysisNames.characters.join('、')}`);
    if (analysisNames.scenes?.length) parts.push(`场景：${analysisNames.scenes.join('、')}`);
    if (analysisNames.props?.length) parts.push(`道具：${analysisNames.props.join('、')}`);
    if (parts.length) {
      system += `\n\n【重要】以下是本作品中已确定的角色、场景和道具名称，请在输出中严格使用这些名称，不要使用别名或替代称呼：\n${parts.join('\n')}`;
    }
  }

  // 自动检测：如果模板包含上下文变量，使用逐段模式
  if (customPrompt && customPrompt.user && needsSegmentedMode(customPrompt.user)) {
    return convertScriptSegmented(scriptText, { ...customPrompt, system });
  }

  // 全文模式（默认）
  const prompt = renderTemplate(user, { script: scriptText, '输入文案': scriptText });

  const rawText = await callAIPlain(prompt, {
    systemPrompt: system,
    maxTokens: 32768,
  });

  return parseConvertedShots(rawText);
}
