/**
 * AI 调用模块 — 中转站API (OpenAI兼容格式)
 * 支持 /v1/chat/completions 格式
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/** 去掉 apiUrl 尾部多余的 /v1，防止拼接出 /v1/v1/chat/completions */
function normalizeApiBase(url) {
  return url.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

const CONFIG_FILE = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'video-workflow',
  'config.json'
);

/** 读取用户配置 */
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

/** 保存用户配置 */
export function saveConfig(config) {
  const dir = path.dirname(CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  // 保留 profiles 等不在面板中的字段
  const existing = loadConfig();
  const merged = { ...existing, ...config };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
}

/** 获取AI配置 */
export function getAIConfig() {
  const cfg = loadConfig();
  return {
    // 推理API（文字生成）
    apiUrl: cfg.apiUrl || '',
    apiKey: cfg.apiKey || '',
    model: cfg.model || 'gpt-4o',
    // 图片生成API
    imageApiUrl: cfg.imageApiUrl || '',
    imageApiKey: cfg.imageApiKey || '',
    imageModel: cfg.imageModel || 'dall-e-3',
    // 即梦浏览器自动化API
    jimengUrl: cfg.jimengUrl || 'http://localhost:3001',
    // 配置档案
    profiles: cfg.profiles || [],
    activeProfile: cfg.activeProfile || '',
  };
}

/**
 * 检测模型是否拒绝返回请求内容
 * Claude有时会误判正常JSON格式要求为"prompt injection"而拒绝合作
 */
function _isRefusal(text) {
  if (!text || text.length < 30) return false;
  const lower = text.toLowerCase();
  const refusalPatterns = [
    'i cannot provide',
    'i cannot generate',
    'i am claude',
    'prompt injection',
    'i\'m designed to',
    'i\'m not able to',
    'cannot fulfill',
    'cannot comply',
    'i must decline',
    'override my core',
    'social engineering',
    '我无法提供',
    '我不能生成',
    '我是claude',
    '提示注入',
  ];
  // 如果响应不包含任何 { 或 [，且匹配了拒绝模式，则认为是拒绝
  const hasJson = text.includes('{') || text.includes('[');
  if (hasJson) return false; // 有JSON结构的不算纯拒绝
  return refusalPatterns.some(p => lower.includes(p));
}

/** 获取自定义提示词模板（如无则返回空对象） */
export function getPromptTemplates() {
  const cfg = loadConfig();
  return cfg.prompts || {};
}

/** 保存自定义提示词模板 */
export function savePromptTemplates(prompts) {
  const cfg = loadConfig();
  cfg.prompts = prompts;
  saveConfig(cfg);
}

/** 获取转换预设列表 */
export function getConvertPresets() {
  const cfg = loadConfig();
  return cfg.convertPresets || [];
}

/** 保存转换预设列表 */
export function saveConvertPresets(presets) {
  const cfg = loadConfig();
  cfg.convertPresets = presets;
  saveConfig(cfg);
}

/** 获取提示词生成预设列表 */
export function getPromptGenPresets() {
  const cfg = loadConfig();
  return cfg.promptGenPresets || [];
}

/** 保存提示词生成预设列表 */
export function savePromptGenPresets(presets) {
  const cfg = loadConfig();
  cfg.promptGenPresets = presets;
  saveConfig(cfg);
}

/**
 * 修复AI返回的无效JSON
 */
function fixInvalidJSON(text) {
  // 去除AI思考标签
  text = text.replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, '');
  // 去掉 markdown 代码块包裹 (包括中间有内容的情况)
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (codeBlock) text = codeBlock[1];
  else text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  // 去掉BOM
  text = text.replace(/^\uFEFF/, '');
  // 注意：不再替换中文引号""''，因为AI常在JSON字符串值内使用它们，替换会破坏JSON结构
  // 修复末尾多余逗号
  text = text.replace(/,\s*([}\]])/g, '$1');
  // 截断修复：如果在字符串中间被截断，先关闭字符串
  // 检查最后一个引号后是否有未闭合的字符串
  const lastQuote = text.lastIndexOf('"');
  if (lastQuote > 0) {
    const afterQuote = text.slice(lastQuote + 1).trim();
    // 如果最后引号后面没有 : , } ] 等有效JSON字符，说明截断在值中间
    if (afterQuote && !/^\s*[,:}\]]/.test(afterQuote)) {
      text = text.slice(0, lastQuote + 1);
    }
  }
  // 尝试修复截断的JSON（补全括号）
  let opens = 0, closeBrackets = 0, openArr = 0, closeArr = 0;
  for (const ch of text) {
    if (ch === '{') opens++;
    else if (ch === '}') closeBrackets++;
    else if (ch === '[') openArr++;
    else if (ch === ']') closeArr++;
  }
  while (closeArr < openArr) { text += ']'; closeArr++; }
  while (closeBrackets < opens) { text += '}'; closeBrackets++; }
  return text;
}

/**
 * 从AI响应文本中提取并解析JSON
 */
export function extractAndParseJSON(text) {
  // 第一步：去除 AI 思考标签（Gemini 2.5 Flash 等模型可能输出 <think>/<thinking> 块）
  text = text.replace(/<think(?:ing)?>\s*[\s\S]*?<\/think(?:ing)?>\s*/gi, '');
  
  // 尝试直接解析
  try { return JSON.parse(text); } catch (e) {
    console.log('[extractJSON] 直接解析失败:', e.message?.slice(0, 80));
  }
  // 修复后再试
  const fixed = fixInvalidJSON(text);
  try { return JSON.parse(fixed); } catch (e) {
    console.log('[extractJSON] fixInvalidJSON后解析失败:', e.message?.slice(0, 80));
  }
  // 提取最后一个 ```json ... ``` 代码块（应对AI先输出思考再输出JSON的情况）
  const allCodeBlocks = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/gi)];
  for (let i = allCodeBlocks.length - 1; i >= 0; i--) {
    const raw = allCodeBlocks[i][1].trim();
    // 先尝试原始内容（不做fix，避免中文引号等被错误替换）
    try { return JSON.parse(raw); } catch {}
    try { return JSON.parse(fixInvalidJSON(raw)); } catch {}
  }
  // 尝试提取JSON块（贪婪：最外层 {} 或 []）
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(fixInvalidJSON(match[0])); } catch {}
  }
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(fixInvalidJSON(arrMatch[0])); } catch {}
  }
  console.error('[extractAndParseJSON] 无法解析，AI原始响应前500字符:', text.slice(0, 500));
  console.error('[extractAndParseJSON] AI原始响应后200字符:', text.slice(-200));
  // 保存失败的原始响应到文件，方便排查
  try {
    const dataDir = process.env.APPDATA || path.join(os.homedir(), '.config', 'video-workflow');
    const dumpFile = path.join(dataDir, 'ai-fail-response.txt');
    fs.writeFileSync(dumpFile, `[${new Date().toISOString()}]\n${text}`, 'utf-8');
    console.error(`[extractAndParseJSON] 原始响应已保存到: ${dumpFile}`);
  } catch (_) {}
  throw new Error('无法从AI响应中提取有效JSON');
}

/**
 * 调用AI — JSON模式
 * @param {string} prompt - 提示词
 * @param {object} [options] - 选项
 * @param {string} [options.systemPrompt] - 系统提示词
 * @param {number} [options.maxRetries=3] - 最大重试次数
 * @param {number} [options.maxTokens=4096] - 最大token
 * @returns {Promise<object>} 解析后的JSON对象
 */
export async function callAI(prompt, options = {}) {
  const { apiUrl, apiKey, model } = getAIConfig();
  if (!apiUrl || !apiKey) {
    throw new Error('请先在设置中配置AI API地址和密钥');
  }

  const {
    systemPrompt = '你是一个专业的影视创作助手。请按要求返回JSON格式。',
    maxRetries = 3,
    maxTokens = 4096,
  } = options;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120000);
    try {
      const url = normalizeApiBase(apiUrl) + '/v1/chat/completions';
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.7,
        }),
        signal: ac.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API错误 ${resp.status}: ${errText}`);
      }

      const data = await resp.json();
      const finish = data.choices?.[0]?.finish_reason;
      const content = data.choices?.[0]?.message?.content;
      console.log(`[callAI] finish_reason=${finish}, content长度=${content?.length || 0}`);
      if (finish === 'length') console.warn(`[callAI] ⚠️ 响应被截断(finish_reason=length), maxTokens=${maxTokens}`);
      if (!content) throw new Error('AI返回空内容');

      // 检测模型拒绝（Claude有时会误判正常JSON请求为"prompt injection"而拒绝返回JSON）
      if (_isRefusal(content)) {
        console.warn(`[callAI] ⚠️ 模型拒绝返回JSON(第${attempt + 1}次)，将重试`);
        throw new Error('模型拒绝返回JSON格式，需重试');
      }

      return extractAndParseJSON(content);
    } catch (err) {
      lastError = err;
      const reason = err.name === 'AbortError' ? 'API超时(120s)' : err.message;
      console.error(`AI调用失败(第${attempt + 1}次): ${reason}`);
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * 调用AI — 纯文本模式
 * @param {string} prompt - 提示词
 * @param {object} [options] - 选项
 * @returns {Promise<string>} AI返回的文本
 */
export async function callAIPlain(prompt, options = {}) {
  const { apiUrl, apiKey, model } = getAIConfig();
  if (!apiUrl || !apiKey) {
    throw new Error('请先在设置中配置AI API地址和密钥');
  }

  const {
    systemPrompt = '你是一个专业的影视创作助手。',
    maxRetries = 3,
    maxTokens = 4096,
    timeout = 180000,
  } = options;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const url = normalizeApiBase(apiUrl) + '/v1/chat/completions';
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.7,
        }),
        signal: ac.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`API错误 ${resp.status}: ${errText}`);
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('AI返回空内容');
      return content;
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') console.error(`[callAIPlain] API超时(${timeout/1000}s), 第${attempt + 1}次`);
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * 从 chat completions 响应内容中提取图片 data URL
 */
function extractImageFromContent(content) {
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'image_url') return part.image_url?.url;
    }
  }
  if (typeof content === 'string') {
    const m = content.match(/!\[.*?\]\((data:image\/[^)]+)\)/);
    if (m) return m[1];
  }
  return null;
}

/**
 * 调用AI — 视觉模式（发送图片给大模型分析）
 * @param {string} prompt - 提示词
 * @param {string[]} imagePaths - 图片文件路径数组
 * @param {object} [options] - 选项
 * @param {string} [options.systemPrompt] - 系统提示词
 * @param {number} [options.maxRetries=3] - 最大重试次数
 * @param {number} [options.maxTokens=4096] - 最大token
 * @param {number} [options.timeout=180000] - 超时毫秒
 * @returns {Promise<string>} AI返回的文本
 */
export async function callAIVision(prompt, imagePaths, options = {}) {
  const { apiUrl, apiKey, model } = getAIConfig();
  if (!apiUrl || !apiKey) {
    throw new Error('请先在设置中配置AI API地址和密钥');
  }

  const {
    systemPrompt = '你是一个专业的短视频内容分析师。',
    maxRetries = 3,
    maxTokens = 4096,
    timeout = 180000,
  } = options;

  // 构建多模态消息：图片(base64) + 文本
  const contentParts = [];
  for (const imgPath of imagePaths) {
    const imgBuf = fs.readFileSync(imgPath);
    const ext = path.extname(imgPath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    const b64 = imgBuf.toString('base64');
    contentParts.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${b64}` },
    });
  }
  contentParts.push({ type: 'text', text: prompt });

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: contentParts },
  ];

  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const url = normalizeApiBase(apiUrl) + '/v1/chat/completions';
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.7,
        }),
        signal: ac.signal,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Vision API错误 ${resp.status}: ${errText}`);
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Vision API返回空内容');
      return content;
    } catch (err) {
      lastError = err;
      const reason = err.name === 'AbortError' ? `Vision API超时(${timeout/1000}s)` : err.message;
      console.error(`Vision调用失败(第${attempt + 1}次): ${reason}`);
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * 调用图片生成API（自动适配 images/generations 和 chat/completions 两种模式）
 * @param {string} prompt - 图片描述提示词
 * @param {object} [options] - 选项
 * @param {string} [options.size='1024x1024'] - 图片尺寸
 * @param {number} [options.n=1] - 生成数量
 * @returns {Promise<string[]>} 图片URL或data URL数组
 */
export async function callImageGeneration(prompt, options = {}) {
  const { imageApiUrl, imageApiKey, imageModel } = getAIConfig();
  if (!imageApiUrl || !imageApiKey) {
    throw new Error('请先在设置中配置图片生成API地址和密钥');
  }

  const {
    size = '1024x1024',
    n = 1,
    maxRetries = 3,
  } = options;

  const base = normalizeApiBase(imageApiUrl);
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 先尝试标准 images/generations 端点
      const imgResp = await fetch(base + '/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${imageApiKey}`,
        },
        body: JSON.stringify({ model: imageModel, prompt, n, size }),
      });

      if (imgResp.ok) {
        const data = await imgResp.json();
        return (data.data || []).map(item => item.url || item.b64_json);
      }

      // 如果返回 500/503（不支持此端点），回退到 chat/completions
      const errText = await imgResp.text();
      const isChatFallback = imgResp.status >= 500 ||
        errText.includes('not supported') ||
        errText.includes('No available channel');

      if (!isChatFallback) {
        throw new Error(`图片API错误 ${imgResp.status}: ${errText}`);
      }

      console.log('[callImageGeneration] images端点不支持, 回退到chat/completions');
      const chatResp = await fetch(base + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${imageApiKey}`,
        },
        body: JSON.stringify({
          model: imageModel,
          messages: [{ role: 'user', content: `Generate an image: ${prompt}` }],
          max_tokens: 4096,
        }),
      });

      if (!chatResp.ok) {
        const chatErr = await chatResp.text();
        throw new Error(`图片API(chat)错误 ${chatResp.status}: ${chatErr}`);
      }

      const chatData = await chatResp.json();
      const msgContent = chatData.choices?.[0]?.message?.content;
      const imgUrl = extractImageFromContent(msgContent);
      if (imgUrl) return [imgUrl];
      throw new Error('图片API返回了响应但未包含图片数据');
    } catch (err) {
      lastError = err;
      console.error(`图片生成失败(第${attempt + 1}次):`, err.message);
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}
