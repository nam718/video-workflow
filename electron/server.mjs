/**
 * 内嵌 Express 服务器 — 工作流API后端
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { saveConfig, getAIConfig, getPromptTemplates, savePromptTemplates, getConvertPresets, saveConvertPresets, getPromptGenPresets, savePromptGenPresets, callImageGeneration } from '../shared/call-ai.mjs';
import { projectPaths, ensureProjectDirs } from '../shared/project-paths.mjs';
import { DEFAULT_PROMPTS, BUILTIN_GEN_PRESETS } from '../shared/prompt-defaults.mjs';
import { analyzeScript, splitChapters } from '../scripts/analyze.mjs';
import { planShots } from '../scripts/plan-shots.mjs';
import { convertScript } from '../scripts/convert-script.mjs';
import { generatePrompts, generateShotPrompt } from '../scripts/generate-prompts.mjs';
import { generateCharacterImages, generateSceneImages, generatePropsImages } from '../scripts/generate-images.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const jimeng = require('../jimeng/jimeng-service.cjs');
const kling = require('../kling/kling-service.cjs');

// 视频服务路由辅助：根据 service 参数或 taskId 前缀选择对应服务
function _getVideoService(serviceOrTaskId) {
  if (serviceOrTaskId === 'kling' || (typeof serviceOrTaskId === 'string' && serviceOrTaskId.startsWith('kling_'))) return kling;
  return jimeng;
}

const app = express();

// CORS 支持 — 仅允许本机访问
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));

// 托管前端页面
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'src', 'index.html'));
});

// 应用数据目录（打包后可写，开发时使用项目目录）
const APP_DATA = process.env.APP_USER_DATA || path.join(__dirname, '..');
const IMAGES_DIR = path.join(APP_DATA, 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// 静态资源（src目录）
app.use('/src', express.static(path.join(__dirname, '..', 'src')));
// 即梦下载的图片/视频
app.use('/images', express.static(IMAGES_DIR));

// 本地文件代理（仅限图片/视频，用于显示存为绝对路径的参考图）
app.get('/api/local-file', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('Missing path');
  // 只允许访问图片和视频文件
  const ext = path.extname(filePath).toLowerCase();
  const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.mp4', '.webm', '.mov'];
  if (!allowed.includes(ext)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

/** 下载远程图片或base64数据到本地文件 */
async function downloadImageToLocal(url, savePath) {
  if (!url) return '';
  // data URL → 直接解码保存
  if (url.startsWith('data:image/')) {
    const match = url.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return url;
    const buf = Buffer.from(match[2], 'base64');
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, buf);
    return savePath;
  }
  // 已经是本地路径 → 直接返回
  if (/^[A-Z]:\\/i.test(url) || (url.startsWith('/') && !url.startsWith('//'))) {
    return url;
  }
  // HTTP(S) URL → 下载
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const { default: http } = url.startsWith('https') ? await import('https') : await import('http');
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    return new Promise((resolve) => {
      const file = fs.createWriteStream(savePath);
      http.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp) => {
        if (resp.statusCode === 301 || resp.statusCode === 302) {
          file.close(); resp.resume();
          const { default: http2 } = resp.headers.location?.startsWith('https') ? { default: http } : { default: http };
          const file2 = fs.createWriteStream(savePath);
          const mod = resp.headers.location.startsWith('https') ? import('https') : import('http');
          mod.then(m => {
            m.default.get(resp.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r2) => {
              if (r2.statusCode !== 200) { file2.close(); r2.resume(); resolve(url); return; }
              r2.pipe(file2);
              file2.on('finish', () => { file2.close(); resolve(savePath); });
            }).on('error', () => resolve(url));
          });
          return;
        }
        if (resp.statusCode !== 200) { file.close(); resp.resume(); resolve(url); return; }
        resp.pipe(file);
        file.on('finish', () => { file.close(); resolve(savePath); });
      }).on('error', () => resolve(url));
    });
  }
  return url;
}

/** ======== 进行中任务持久化 ======== */
const PENDING_TASKS_FILE = path.join(APP_DATA, '.pending-tasks.json');
const PROJECT_HISTORY_FILE = path.join(APP_DATA, '.project-history.json');

function loadPendingTasks() {
  try {
    if (fs.existsSync(PENDING_TASKS_FILE)) return JSON.parse(fs.readFileSync(PENDING_TASKS_FILE, 'utf-8'));
  } catch (_) {}
  return {};
}

function savePendingTasks(tasks) {
  fs.writeFileSync(PENDING_TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
}

function addPendingTask(taskId, projectPath, shotIndex) {
  const tasks = loadPendingTasks();
  tasks[taskId] = { projectPath, shotIndex, startedAt: Date.now() };
  savePendingTasks(tasks);
}

function removePendingTask(taskId) {
  const tasks = loadPendingTasks();
  delete tasks[taskId];
  savePendingTasks(tasks);
}

/** 项目历史记录 — 记录所有打开过的项目路径 */
function loadProjectHistory() {
  try {
    if (fs.existsSync(PROJECT_HISTORY_FILE)) return JSON.parse(fs.readFileSync(PROJECT_HISTORY_FILE, 'utf-8'));
  } catch (_) {}
  return [];
}

function addToProjectHistory(projectPath) {
  let history = loadProjectHistory();
  history = history.filter(p => p !== projectPath);
  history.unshift(projectPath);
  if (history.length > 50) history = history.slice(0, 50);
  fs.writeFileSync(PROJECT_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

/** ======== 设置 API ======== */

app.get('/api/config', (req, res) => {
  res.json(getAIConfig());
});

app.post('/api/config', (req, res) => {
  saveConfig(req.body);
  res.json({ ok: true });
});

/** 配置档案管理 */
app.get('/api/config/profiles', (req, res) => {
  const cfg = getAIConfig();
  res.json({ profiles: cfg.profiles || [], activeProfile: cfg.activeProfile || '' });
});

app.post('/api/config/profiles', (req, res) => {
  const { name, apiUrl, apiKey, model, imageApiUrl, imageApiKey, imageModel } = req.body;
  if (!name) return res.status(400).json({ error: '需要配置名称' });
  const cfg = getAIConfig();
  const profiles = cfg.profiles || [];
  const idx = profiles.findIndex(p => p.name === name);
  const profile = { name, apiUrl, apiKey, model, imageApiUrl, imageApiKey, imageModel };
  if (idx >= 0) profiles[idx] = profile; else profiles.push(profile);
  saveConfig({ profiles, activeProfile: name });
  res.json({ ok: true, profiles });
});

app.post('/api/config/profiles/delete', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '需要配置名称' });
  const cfg = getAIConfig();
  const profiles = (cfg.profiles || []).filter(p => p.name !== name);
  const update = { profiles };
  if (cfg.activeProfile === name) update.activeProfile = '';
  saveConfig(update);
  res.json({ ok: true, profiles });
});

// 测试AI连接
app.post('/api/config/test', async (req, res) => {
  try {
    const { apiUrl, apiKey, model } = req.body;
    const url = apiUrl.replace(/\/+$/, '').replace(/\/v1$/i, '') + '/v1/chat/completions';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '说"连接成功"' }], max_tokens: 50 }),
    });
    if (resp.ok) {
      const data = await resp.json();
      res.json({ ok: true, reply: data.choices?.[0]?.message?.content || '连接成功' });
    } else {
      res.json({ ok: false, error: `HTTP ${resp.status}` });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 测试图片API连接
app.post('/api/config/test-image', async (req, res) => {
  try {
    const { imageApiUrl, imageApiKey, imageModel } = req.body;
    const base = imageApiUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
    // 先尝试 images/generations
    const resp = await fetch(base + '/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imageApiKey}` },
      body: JSON.stringify({ model: imageModel, prompt: 'a red circle on white background', n: 1, size: '256x256' }),
    });
    if (resp.ok) {
      return res.json({ ok: true });
    }
    const errText = await resp.text();
    const isChatFallback = resp.status >= 500 || errText.includes('not supported') || errText.includes('No available channel');
    if (!isChatFallback) {
      return res.json({ ok: false, error: `HTTP ${resp.status}: ${errText.slice(0, 200)}` });
    }
    // 回退到 chat/completions
    const chatResp = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imageApiKey}` },
      body: JSON.stringify({ model: imageModel, messages: [{ role: 'user', content: 'Generate an image of a red circle on white background' }], max_tokens: 1000 }),
    });
    if (chatResp.ok) {
      const data = await chatResp.json();
      const content = data.choices?.[0]?.message?.content || '';
      const hasImage = (typeof content === 'string' && content.includes('data:image')) || (Array.isArray(content) && content.some(p => p.type === 'image_url'));
      res.json({ ok: hasImage, error: hasImage ? undefined : '模型未返回图片数据' });
    } else {
      const chatErr = await chatResp.text();
      res.json({ ok: false, error: `HTTP ${chatResp.status}: ${chatErr.slice(0, 200)}` });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 测试即梦内置浏览器 & 登录状态
app.post('/api/config/test-jimeng', async (req, res) => {
  try {
    const accountId = req.body.accountId || 'default';
    await jimeng.initBrowser(accountId);
    const status = await jimeng.checkLoginStatus(accountId);
    res.json({ ok: true, loggedIn: !!status.loggedIn, username: status.username || '' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ========== 提示词模板 ==========
app.get('/api/prompts', (req, res) => {
  const custom = getPromptTemplates();
  // 合并默认值：每个 key 返回 { system, user, label, vars }
  const merged = {};
  for (const [key, def] of Object.entries(DEFAULT_PROMPTS)) {
    merged[key] = {
      label: def.label,
      vars: def.vars,
      system: (custom[key] && custom[key].system) || def.system,
      user: (custom[key] && custom[key].user) || def.user,
    };
  }
  res.json(merged);
});

app.post('/api/prompts', (req, res) => {
  const { prompts } = req.body;
  savePromptTemplates(prompts);
  res.json({ ok: true });
});

app.post('/api/prompts/reset', (req, res) => {
  // 重置为默认值
  savePromptTemplates({});
  res.json({ ok: true });
});

// ====== 转换预设管理 ======
app.get('/api/convert-presets', (req, res) => {
  res.json({ presets: getConvertPresets() });
});

app.post('/api/convert-presets', (req, res) => {
  const { presets } = req.body;
  if (!Array.isArray(presets)) return res.status(400).json({ error: 'presets 必须是数组' });
  saveConvertPresets(presets);
  res.json({ ok: true });
});

// ====== 提示词生成预设管理 ======
app.get('/api/prompt-gen-presets', (req, res) => {
  res.json({ presets: getPromptGenPresets(), builtinNames: BUILTIN_GEN_PRESETS.map(p => p.name) });
});

app.post('/api/prompt-gen-presets', (req, res) => {
  const { presets } = req.body;
  if (!Array.isArray(presets)) return res.status(400).json({ error: 'presets 必须是数组' });
  savePromptGenPresets(presets);
  res.json({ ok: true });
});

// ========== 可灵浏览器管理 ==========
app.post('/api/config/test-kling', async (req, res) => {
  try {
    const accountId = req.body.accountId || 'default';
    await kling.initBrowser(accountId);
    const status = await kling.checkLoginStatus(accountId);
    res.json({ ok: true, loggedIn: !!status.loggedIn, username: status.username || '' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/kling/open-login', async (req, res) => {
  try {
    const accountId = req.body.accountId || 'default';
    await kling.initBrowser(accountId);
    const result = await kling.openLoginPage(accountId);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: '启动可灵浏览器失败: ' + err.message });
  }
});

app.post('/api/kling/login-status', async (req, res) => {
  try {
    const accountId = req.body.accountId || 'default';
    await kling.initBrowser(accountId);
    const status = await kling.checkLoginStatus(accountId);
    res.json({ ok: true, loggedIn: !!status.loggedIn, username: status.username || '', debug: status.debug });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/kling/accounts', (req, res) => {
  res.json({ ok: true, accounts: kling.getAccountList() });
});

app.post('/api/kling/accounts', (req, res) => {
  const { accountId, name } = req.body;
  if (!accountId || !name) return res.status(400).json({ ok: false, error: '请提供 accountId 和 name' });
  const result = kling.addAccount(accountId, name);
  res.json(result);
});

app.delete('/api/kling/accounts/:accountId', async (req, res) => {
  const result = await kling.removeAccount(req.params.accountId);
  res.json(result);
});

app.post('/api/kling/init-all', async (req, res) => {
  try {
    const results = await kling.initAllBrowsers();
    res.json({ ok: true, results });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/kling/save-cookies', async (req, res) => {
  try {
    const accountId = req.body.accountId || 'default';
    await kling.initBrowser(accountId);
    const ok = await kling.saveCookies(accountId);
    if (ok) res.json({ ok: true });
    else res.json({ ok: false, error: '浏览器未连接或页面不存在' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 打开即梦登录页（内置浏览器）
app.post('/api/jimeng/open-login', async (req, res) => {
  try {
    const accountId = req.body.accountId || 'default';
    await jimeng.initBrowser(accountId);
    const result = await jimeng.openLoginPage(accountId);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: '启动内置浏览器失败: ' + err.message });
  }
});

// 检查即梦登录状态（内置浏览器）
app.post('/api/jimeng/login-status', async (req, res) => {
  try {
    const accountId = req.body.accountId || 'default';
    await jimeng.initBrowser(accountId);
    const status = await jimeng.checkLoginStatus(accountId);
    res.json({ ok: true, loggedIn: !!status.loggedIn, username: status.username || '' });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ========== 即梦多账号管理 ==========
// 获取所有账号列表
app.get('/api/jimeng/accounts', (req, res) => {
  res.json({ ok: true, accounts: jimeng.getAccountList() });
});

// 添加新账号
app.post('/api/jimeng/accounts', (req, res) => {
  const { accountId, name } = req.body;
  if (!accountId || !name) return res.status(400).json({ ok: false, error: '请提供 accountId 和 name' });
  const result = jimeng.addAccount(accountId, name);
  res.json(result);
});

// 删除账号
app.delete('/api/jimeng/accounts/:accountId', async (req, res) => {
  const result = await jimeng.removeAccount(req.params.accountId);
  res.json(result);
});

// 初始化所有账号浏览器
app.post('/api/jimeng/init-all', async (req, res) => {
  try {
    const results = await jimeng.initAllBrowsers();
    res.json({ ok: true, results });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// 保存即梦账号Cookie
app.post('/api/jimeng/save-cookies', async (req, res) => {
  try {
    const accountId = req.body.accountId || 'default';
    const ok = await jimeng.saveCookies(accountId);
    res.json({ ok });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

/** ======== 项目管理 API ======== */

app.post('/api/project/create', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: '请指定项目路径' });
  try {
    const p = ensureProjectDirs(projectPath);
    // 创建默认配置
    if (!fs.existsSync(p.config)) {
      fs.writeFileSync(p.config, JSON.stringify({
        name: path.basename(projectPath),
        createdAt: new Date().toISOString(),
        aspectRatio: '16:9',
      }, null, 2));
    }
    res.json({ ok: true, paths: p });
    addToProjectHistory(projectPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/project/create-by-name', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '请输入项目名称' });
  // 清理名称中不安全字符
  const safeName = name.replace(/[<>:"/\\|?*]/g, '_').trim();
  if (!safeName) return res.status(400).json({ error: '项目名称无效' });
  const projectPath = path.join(APP_DATA, 'projects', safeName);
  if (fs.existsSync(path.join(projectPath, 'project_config.json'))) {
    return res.status(400).json({ error: '项目已存在，请换个名称' });
  }
  try {
    const p = ensureProjectDirs(projectPath);
    fs.writeFileSync(p.config, JSON.stringify({
      name: safeName,
      createdAt: new Date().toISOString(),
      aspectRatio: '16:9',
    }, null, 2));
    res.json({ ok: true, projectPath });
    addToProjectHistory(projectPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/project/history', (req, res) => {
  const history = loadProjectHistory();
  const items = history.map(p => {
    const name = path.basename(p);
    let createdAt = '';
    // 必须有 project_config.json 才算合法项目
    const cfgPath = path.join(p, 'project_config.json');
    if (!fs.existsSync(cfgPath)) return null;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      createdAt = cfg.createdAt || '';
    } catch (_) {}
    return { path: p, name, createdAt, exists: true };
  }).filter(Boolean);
  res.json(items);
});

app.post('/api/project/open', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: '请指定项目路径' });
  try {
    const p = projectPaths(projectPath);
    // 读取项目状态
    const state = {};
    if (fs.existsSync(p.original))   state.hasScript = true;
    if (fs.existsSync(p.analysis))   state.hasAnalysis = true;
    if (fs.existsSync(p.chapters))   state.hasChapters = true;
    if (fs.existsSync(p.shotPlans))  state.hasShotPlans = true;
    if (fs.existsSync(p.shots))      state.hasPrompts = true;
    if (fs.existsSync(p.shotVideos)) state.hasVideos = true;
    // 读取已有数据
    const data = {};
    for (const [key, fpath] of Object.entries(p)) {
      if (typeof fpath === 'string' && fs.existsSync(fpath)) {
        try {
          const content = fs.readFileSync(fpath, 'utf-8');
          data[key] = fpath.endsWith('.json') ? JSON.parse(content) : content;
        } catch {}
      }
    }
    // 读取项目配置
    let visualStyle = '';
    let savedVideoParams = null;
    let savedRefImageParams = null;
    let savedShotImageParams = null;
    let savedRefMode = null;
    let savedSelectedPresetIdx = null;
    let savedSelectedPromptGenPresetIdx = null;
    let savedVideoService = null;
    if (fs.existsSync(p.config)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p.config, 'utf-8'));
        visualStyle = cfg.visualStyle || '';
        savedVideoParams = cfg.videoParams || null;
        savedRefImageParams = cfg.refImageParams || null;
        savedShotImageParams = cfg.shotImageParams || null;
        savedRefMode = cfg.refMode !== undefined ? cfg.refMode : null;
        savedSelectedPresetIdx = cfg.selectedPresetIdx !== undefined ? cfg.selectedPresetIdx : null;
        savedSelectedPromptGenPresetIdx = cfg.selectedPromptGenPresetIdx !== undefined ? cfg.selectedPromptGenPresetIdx : null;
        savedVideoService = cfg.videoService || null;
      } catch {}
    }
    res.json({ state, data, paths: p, visualStyle, videoParams: savedVideoParams, refImageParams: savedRefImageParams, shotImageParams: savedShotImageParams, refMode: savedRefMode, selectedPresetIdx: savedSelectedPresetIdx, selectedPromptGenPresetIdx: savedSelectedPromptGenPresetIdx, videoService: savedVideoService });
    addToProjectHistory(projectPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 保存视觉风格到项目配置
app.post('/api/project/set-style', (req, res) => {
  const { projectPath, visualStyle, videoParams, refImageParams, shotImageParams, refMode, selectedPresetIdx, selectedPromptGenPresetIdx, videoService } = req.body;
  try {
    const p = projectPaths(projectPath);
    let config = {};
    if (fs.existsSync(p.config)) config = JSON.parse(fs.readFileSync(p.config, 'utf-8'));
    if (visualStyle !== undefined) config.visualStyle = visualStyle;
    if (videoParams !== undefined) config.videoParams = videoParams;
    if (refImageParams !== undefined) config.refImageParams = refImageParams;
    if (shotImageParams !== undefined) config.shotImageParams = shotImageParams;
    if (refMode !== undefined) config.refMode = refMode;
    if (selectedPresetIdx !== undefined) config.selectedPresetIdx = selectedPresetIdx;
    if (selectedPromptGenPresetIdx !== undefined) config.selectedPromptGenPresetIdx = selectedPromptGenPresetIdx;
    if (videoService !== undefined) config.videoService = videoService;
    fs.writeFileSync(p.config, JSON.stringify(config, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** ======== 工作流 API ======== */

// 步骤1：导入剧本
app.post('/api/workflow/import-script', (req, res) => {
  const { projectPath, scriptText, filePath } = req.body;
  try {
    const p = ensureProjectDirs(projectPath);
    let text = scriptText;
    if (filePath && !text) {
      // 安全校验：仅允许读取项目目录下的文件
      const resolved = path.resolve(filePath);
      const projectRoot = path.resolve(projectPath) + path.sep;
      if (!resolved.startsWith(projectRoot) && resolved !== path.resolve(projectPath)) {
        return res.status(400).json({ error: '文件路径不在项目目录内' });
      }
      text = fs.readFileSync(resolved, 'utf-8');
    }
    if (!text) return res.status(400).json({ error: '请提供剧本内容或文件路径' });
    fs.writeFileSync(p.original, text, 'utf-8');
    res.json({ ok: true, length: text.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 剧本转换：直接将原文转换为分镜（跳过提取+章节拆分+分镜规划）
app.post('/api/workflow/convert-script', async (req, res) => {
  const { projectPath, presetIndex } = req.body;
  try {
    console.log('[convert-script] 开始转换, projectPath:', projectPath, 'presetIndex:', presetIndex);
    const p = projectPaths(projectPath);
    const script = fs.existsSync(p.corrected)
      ? fs.readFileSync(p.corrected, 'utf-8')
      : fs.readFileSync(p.original, 'utf-8');
    console.log('[convert-script] 剧本长度:', script.length);
    let customPrompt;
    if (presetIndex !== undefined && presetIndex >= 0) {
      const presets = getConvertPresets();
      if (presets[presetIndex]) customPrompt = presets[presetIndex];
    }

    // 读取分析结果中的角色/场景名列表，传给 convertScript 引导AI使用标准名称
    let analysisNames;
    if (fs.existsSync(p.analysis)) {
      try {
        const analysis = JSON.parse(fs.readFileSync(p.analysis, 'utf-8'));
        analysisNames = {
          characters: (analysis.characters || []).map(c => c.name).filter(Boolean),
          scenes: (analysis.scenes || []).map(s => s.name).filter(Boolean),
          props: (analysis.props || []).map(p => p.name).filter(Boolean),
        };
      } catch (e) { /* 读取失败不影响转换 */ }
    }

    const shots = await convertScript(script, customPrompt, analysisNames);
    console.log('[convert-script] 转换完成, 分镜数:', shots.length);

    // 用 analysis.json 的角色/场景/道具列表补充匹配
    if (fs.existsSync(p.analysis)) {
      try {
        const analysis = JSON.parse(fs.readFileSync(p.analysis, 'utf-8'));
        const charNames = (analysis.characters || []).map(c => c.name).filter(Boolean);
        const sceneNames = (analysis.scenes || []).map(s => s.name).filter(Boolean);
        const propNames = (analysis.props || []).map(p => p.name).filter(Boolean);
        for (const shot of shots) {
          const text = (shot.background || '') + '\n' + (shot.content || '');
          // 补充角色：在文本中出现的角色名加入 characters
          for (const name of charNames) {
            if (text.includes(name) && !(shot.characters || []).includes(name)) {
              if (!shot.characters) shot.characters = [];
              shot.characters.push(name);
            }
          }
          // 场景匹配：从分析结果中找最匹配的场景名（确保与场景图key一致）
          if (shot.scene && sceneNames.length) {
            // 已有场景名 → 优先精确匹配，再模糊匹配（子串包含）
            const exact = sceneNames.find(n => n === shot.scene);
            if (exact) {
              // 完全一致，无需处理
            } else {
              // 模糊匹配：shot.scene 包含分析场景名 或 分析场景名包含 shot.scene
              const fuzzy = sceneNames.find(n => shot.scene.includes(n) || n.includes(shot.scene));
              if (fuzzy) {
                console.log(`[convert-script] 场景名标准化: "${shot.scene}" → "${fuzzy}"`);
                shot.scene = fuzzy;
              } else {
                // 文本中搜索
                for (const name of sceneNames) {
                  if (text.includes(name)) {
                    console.log(`[convert-script] 场景名从文本匹配: "${shot.scene}" → "${name}"`);
                    shot.scene = name;
                    break;
                  }
                }
              }
            }
          } else if (!shot.scene) {
            // 无场景名 → 从文本中搜索
            for (const name of sceneNames) {
              if (text.includes(name)) { shot.scene = name; break; }
            }
          }
          // 补充道具
          for (const name of propNames) {
            if (text.includes(name) && !(shot.props || []).includes(name)) {
              if (!shot.props) shot.props = [];
              shot.props.push(name);
            }
          }
        }
        console.log('[convert-script] 已用 analysis.json 补充角色/场景/道具匹配');
      } catch (e) {
        console.warn('[convert-script] 读取 analysis.json 失败:', e.message);
      }
    }

    fs.writeFileSync(p.shotPlans, JSON.stringify(shots, null, 2), 'utf-8');
    res.json({ ok: true, shotCount: shots.length, shots });
  } catch (err) {
    console.error('[convert-script] 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 步骤2：提取角色/场景/道具
app.post('/api/workflow/analyze', async (req, res) => {
  const { projectPath } = req.body;
  try {
    const p = projectPaths(projectPath);
    const script = fs.existsSync(p.corrected)
      ? fs.readFileSync(p.corrected, 'utf-8')
      : fs.readFileSync(p.original, 'utf-8');
    const analysis = await analyzeScript(script);
    fs.writeFileSync(p.analysis, JSON.stringify(analysis, null, 2), 'utf-8');
    res.json({ ok: true, analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 步骤2.5：拆分章节
app.post('/api/workflow/split-chapters', async (req, res) => {
  const { projectPath, skipIfExists } = req.body;
  try {
    const p = projectPaths(projectPath);
    // 如果前端指定 skipIfExists 且 chapters.json 已存在，直接返回已有数据
    if (skipIfExists && fs.existsSync(p.chapters)) {
      const existing = JSON.parse(fs.readFileSync(p.chapters, 'utf-8'));
      return res.json({ ok: true, chapters: existing, skipped: true });
    }
    const script = fs.existsSync(p.corrected)
      ? fs.readFileSync(p.corrected, 'utf-8')
      : fs.readFileSync(p.original, 'utf-8');
    const result = await splitChapters(script);
    fs.writeFileSync(p.chapters, JSON.stringify(result.chapters || result, null, 2), 'utf-8');
    res.json({ ok: true, chapters: result.chapters || result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 步骤3：分镜规划

// 保存编辑后的章节
app.post('/api/workflow/save-chapters', (req, res) => {
  const { projectPath, chapters } = req.body;
  try {
    const p = projectPaths(projectPath);
    fs.writeFileSync(p.chapters, JSON.stringify(chapters, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workflow/plan-shots', async (req, res) => {
  const { projectPath, shotDuration } = req.body;
  try {
    const p = projectPaths(projectPath);
    const chapters = JSON.parse(fs.readFileSync(p.chapters, 'utf-8'));
    const analysis = JSON.parse(fs.readFileSync(p.analysis, 'utf-8'));
    const shots = await planShots(chapters, analysis, shotDuration || 5);
    fs.writeFileSync(p.shotPlans, JSON.stringify(shots, null, 2), 'utf-8');
    res.json({ ok: true, shotCount: shots.length, shots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 保存编辑后的分析结果
app.post('/api/workflow/save-analysis', (req, res) => {
  const { projectPath, analysis } = req.body;
  try {
    const p = projectPaths(projectPath);
    fs.writeFileSync(p.analysis, JSON.stringify(analysis, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 保存编辑后的分镜规划
app.post('/api/workflow/save-shot-plans', (req, res) => {
  const { projectPath, shotPlans } = req.body;
  try {
    const p = projectPaths(projectPath);
    fs.writeFileSync(p.shotPlans, JSON.stringify(shotPlans, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 保存编辑后的提示词（同步 Step 4 角色/场景/道具到 shots.json）
app.post('/api/workflow/save-shots', (req, res) => {
  const { projectPath, shots } = req.body;
  try {
    const p = projectPaths(projectPath);
    fs.writeFileSync(p.shots, JSON.stringify(shots, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 步骤4：生成提示词
app.post('/api/workflow/generate-prompts', async (req, res) => {
  const { projectPath, presetIndex } = req.body;
  try {
    const p = projectPaths(projectPath);
    const shotPlans = JSON.parse(fs.readFileSync(p.shotPlans, 'utf-8'));
    const analysis = JSON.parse(fs.readFileSync(p.analysis, 'utf-8'));
    let style = '写实';
    if (fs.existsSync(p.config)) {
      try { style = JSON.parse(fs.readFileSync(p.config, 'utf-8')).visualStyle || '写实'; } catch {}
    }

    let customPrompt;
    if (presetIndex !== undefined && presetIndex >= 0) {
      const presets = getPromptGenPresets();
      if (presets[presetIndex]) customPrompt = presets[presetIndex];
    } else if (presetIndex !== undefined && presetIndex <= -2) {
      // 内置预设：-2 = BUILTIN_GEN_PRESETS[0], -3 = BUILTIN_GEN_PRESETS[1], ...
      const builtinIdx = (-presetIndex) - 2;
      if (BUILTIN_GEN_PRESETS[builtinIdx]) customPrompt = BUILTIN_GEN_PRESETS[builtinIdx];
    }
    // presetIndex === -1 → 默认模式，使用 DEFAULT_PROMPTS.generatePrompts

    console.log(`[generate-prompts] 开始, shotPlans=${shotPlans.length}, presetIndex=${presetIndex}, customPrompt=${!!customPrompt}`);

    // SSE 流式推送
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // 防止 Node.js HTTP 超时关闭连接
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    let clientClosed = false;
    res.on('close', () => { clientClosed = true; });

    const allShots = [];
    for (let i = 0; i < shotPlans.length; i++) {
      if (clientClosed) { console.log(`[generate-prompts] 客户端已断开, 停止在 shot ${i}`); break; }
      const shot = shotPlans[i];
      console.log(`[generate-prompts] 开始生成 shot ${i + 1}/${shotPlans.length}`);
      try {
        const context = { shotPlans, allShots, index: i };
        const prompts = await generateShotPrompt(shot, analysis, style, customPrompt, context);
        const shotData = { ...shot, imagePrompt: prompts.imagePrompt || '', videoPrompt: prompts.videoPrompt || '' };
        allShots.push(shotData);
        res.write(`data: ${JSON.stringify({ type: 'shot', index: i, total: shotPlans.length, shot: shotData })}\n\n`);
        console.log(`[generate-prompts] shot ${i + 1} 完成, vpLen=${shotData.videoPrompt.length}`);
      } catch (err) {
        console.error(`[generate-prompts] shot ${i + 1} 错误:`, err.message);
        const shotData = { ...shot, imagePrompt: '', videoPrompt: '' };
        allShots.push(shotData);
        res.write(`data: ${JSON.stringify({ type: 'shot', index: i, total: shotPlans.length, shot: shotData, error: err.message })}\n\n`);
      }
    }
    fs.writeFileSync(p.shots, JSON.stringify(allShots, null, 2), 'utf-8');
    res.write(`data: ${JSON.stringify({ type: 'done', shots: allShots })}\n\n`);
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    }
  }
});

// 步骤4.5：重新推理单个分镜的视频提示词
app.post('/api/workflow/regenerate-single-prompt', async (req, res) => {
  const { projectPath, shotIndex, presetIndex } = req.body;
  try {
    const p = projectPaths(projectPath);
    const shotPlans = JSON.parse(fs.readFileSync(p.shotPlans, 'utf-8'));
    const shots = fs.existsSync(p.shots) ? JSON.parse(fs.readFileSync(p.shots, 'utf-8')) : [];
    const analysis = JSON.parse(fs.readFileSync(p.analysis, 'utf-8'));
    let style = '写实';
    if (fs.existsSync(p.config)) {
      try { style = JSON.parse(fs.readFileSync(p.config, 'utf-8')).visualStyle || '写实'; } catch {}
    }

    let customPrompt;
    if (presetIndex !== undefined && presetIndex >= 0) {
      const presets = getPromptGenPresets();
      if (presets[presetIndex]) customPrompt = presets[presetIndex];
    } else if (presetIndex !== undefined && presetIndex <= -2) {
      const builtinIdx = (-presetIndex) - 2;
      if (BUILTIN_GEN_PRESETS[builtinIdx]) customPrompt = BUILTIN_GEN_PRESETS[builtinIdx];
    }

    const shot = shotPlans[shotIndex];
    if (!shot) return res.status(400).json({ error: `分镜 ${shotIndex} 不存在` });

    // 构造上下文（已生成的 shots 作为 allShots）
    const context = { shotPlans, allShots: shots.slice(0, shotIndex), index: shotIndex };
    const prompts = await generateShotPrompt(shot, analysis, style, customPrompt, context);
    const shotData = { ...(shots[shotIndex] || shot), imagePrompt: prompts.imagePrompt || '', videoPrompt: prompts.videoPrompt || '' };
    
    // 更新 shots 数组并保存
    while (shots.length <= shotIndex) shots.push({});
    shots[shotIndex] = shotData;
    fs.writeFileSync(p.shots, JSON.stringify(shots, null, 2), 'utf-8');

    res.json({ ok: true, shot: shotData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 步骤5：保存编辑后的提示词
app.post('/api/workflow/save-prompts', (req, res) => {
  const { projectPath, shots } = req.body;
  try {
    const p = projectPaths(projectPath);
    fs.writeFileSync(p.shots, JSON.stringify(shots, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 步骤5.5：为分镜生成关键帧图片（使用 imagePrompt + 关联参考图信息）
app.post('/api/workflow/generate-shot-images', async (req, res) => {
  const { projectPath, imageParams } = req.body;
  const ip = imageParams || {};
  try {
    const p = projectPaths(projectPath);
    const shots = JSON.parse(fs.readFileSync(p.shots, 'utf-8'));
    // 加载参考图
    const charImgs  = fs.existsSync(p.charImages)  ? JSON.parse(fs.readFileSync(p.charImages, 'utf-8'))  : {};
    const sceneImgs = fs.existsSync(p.sceneImages) ? JSON.parse(fs.readFileSync(p.sceneImages, 'utf-8')) : {};
    const propsImgs = fs.existsSync(p.propsImages) ? JSON.parse(fs.readFileSync(p.propsImages, 'utf-8')) : {};

    const results = [];
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      // 收集关联参考图URL
      const refUrls = [];
      for (const name of (shot.characters || [])) {
        if (charImgs[name]) refUrls.push(charImgs[name]);
      }
      if (shot.scene && sceneImgs[shot.scene]) refUrls.push(sceneImgs[shot.scene]);
      for (const name of (shot.props || [])) {
        if (propsImgs[name]) refUrls.push(propsImgs[name]);
      }
      shot.refImageUrls = refUrls;

      // 使用 imagePrompt 生成关键帧
      if (shot.imagePrompt) {
        try {
          const imgSize = ip.aspectRatio === '9:16' ? '768x1344' : ip.aspectRatio === '1:1' ? '1024x1024' : '1344x768';
          const urls = await callImageGeneration(shot.imagePrompt, { size: imgSize });
          shot.keyFrameUrl = urls[0] || '';
        } catch (err) {
          console.error(`镜头 ${shot.shotNumber} 关键帧生成失败:`, err.message);
          shot.keyFrameUrl = '';
        }
      }
      results.push({ shotNumber: shot.shotNumber, keyFrameUrl: shot.keyFrameUrl || '', refImageUrls: refUrls });
    }
    // 保存更新后的shots
    fs.writeFileSync(p.shots, JSON.stringify(shots, null, 2), 'utf-8');
    res.json({ ok: true, results, shots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 生成单个分镜关键帧
app.post('/api/workflow/generate-single-shot-image', async (req, res) => {
  const { projectPath, shotIndex, imageParams } = req.body;
  try {
    const p = projectPaths(projectPath);
    const shots = JSON.parse(fs.readFileSync(p.shots, 'utf-8'));
    const shot = shots[shotIndex];
    if (!shot) return res.status(400).json({ error: `分镜 ${shotIndex} 不存在` });

    if (!shot.imagePrompt) return res.status(400).json({ error: '该分镜没有 imagePrompt' });

    // 加载参考图URL（与批量端点一致）
    const charImgs  = fs.existsSync(p.charImages)  ? JSON.parse(fs.readFileSync(p.charImages, 'utf-8'))  : {};
    const sceneImgs = fs.existsSync(p.sceneImages) ? JSON.parse(fs.readFileSync(p.sceneImages, 'utf-8')) : {};
    const propsImgs = fs.existsSync(p.propsImages) ? JSON.parse(fs.readFileSync(p.propsImages, 'utf-8')) : {};
    const refUrls = [];
    for (const name of (shot.characters || [])) { if (charImgs[name]) refUrls.push(charImgs[name]); }
    if (shot.scene && sceneImgs[shot.scene]) refUrls.push(sceneImgs[shot.scene]);
    for (const name of (shot.props || [])) { if (propsImgs[name]) refUrls.push(propsImgs[name]); }
    shot.refImageUrls = refUrls;

    const ip = imageParams || {};
    const imgSize = ip.aspectRatio === '9:16' ? '768x1344' : ip.aspectRatio === '1:1' ? '1024x1024' : '1344x768';
    const urls = await callImageGeneration(shot.imagePrompt, { size: imgSize });
    shot.keyFrameUrl = urls[0] || '';
    fs.writeFileSync(p.shots, JSON.stringify(shots, null, 2), 'utf-8');
    res.json({ ok: true, keyFrameUrl: shot.keyFrameUrl, shotIndex });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 读取分镜数据
app.get('/api/workflow/shots', (req, res) => {
  const { projectPath } = req.query;
  try {
    const p = projectPaths(projectPath);
    if (!fs.existsSync(p.shots)) return res.json({ shots: [] });
    const shots = JSON.parse(fs.readFileSync(p.shots, 'utf-8'));
    res.json({ shots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取参考图数据（角色/场景/道具图片URL映射）
app.get('/api/workflow/ref-images', (req, res) => {
  const { projectPath } = req.query;
  try {
    const p = projectPaths(projectPath);
    const result = { characters: {}, scenes: {}, props: {} };
    if (fs.existsSync(p.charImages))  result.characters = JSON.parse(fs.readFileSync(p.charImages, 'utf-8'));
    if (fs.existsSync(p.sceneImages)) result.scenes     = JSON.parse(fs.readFileSync(p.sceneImages, 'utf-8'));
    if (fs.existsSync(p.propsImages)) result.props      = JSON.parse(fs.readFileSync(p.propsImages, 'utf-8'));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 跨项目资产库 — 扫描所有历史项目的参考图资产 */
app.get('/api/assets/library', (req, res) => {
  const { exclude } = req.query; // 排除当前项目
  try {
    const history = loadProjectHistory();
    const projects = [];
    for (const pp of history) {
      if (pp === exclude) continue;
      try {
        const p = projectPaths(pp);
        const assets = { characters: {}, scenes: {}, props: {} };
        let hasAny = false;
        if (fs.existsSync(p.charImages))  { assets.characters = JSON.parse(fs.readFileSync(p.charImages, 'utf-8')); if (Object.keys(assets.characters).length) hasAny = true; }
        if (fs.existsSync(p.sceneImages)) { assets.scenes = JSON.parse(fs.readFileSync(p.sceneImages, 'utf-8')); if (Object.keys(assets.scenes).length) hasAny = true; }
        if (fs.existsSync(p.propsImages)) { assets.props = JSON.parse(fs.readFileSync(p.propsImages, 'utf-8')); if (Object.keys(assets.props).length) hasAny = true; }
        if (hasAny) projects.push({ name: path.basename(pp), path: pp, assets });
      } catch (_) {}
    }
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 步骤5.5：生成参考图（角色/场景/道具）
app.post('/api/workflow/generate-images', async (req, res) => {
  const { projectPath, type, imageParams, names, visualStyle } = req.body;  // type: 'characters' | 'scenes' | 'props' | 'all', names: optional filter
  try {
    const p = projectPaths(projectPath);
    const analysis = JSON.parse(fs.readFileSync(p.analysis, 'utf-8'));
    const results = {};
    const ip = imageParams || {};
    const style = visualStyle || '';

    // 下载生成的图片到项目 images/ 目录
    const saveGenerated = async (generated, category) => {
      const dir = path.join(projectPath, 'images', category);
      const saved = {};
      for (const [name, url] of Object.entries(generated)) {
        if (!url) { saved[name] = ''; continue; }
        const safeName = name.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]/g, '_');
        const ext = url.startsWith('data:image/png') ? 'png' : url.startsWith('data:image/webp') ? 'webp' : 'jpg';
        const savePath = path.join(dir, `${safeName}.${ext}`);
        try {
          saved[name] = await downloadImageToLocal(url, savePath);
        } catch (e) {
          console.error(`下载图片失败 ${name}:`, e.message);
          saved[name] = url; // 回退到原始URL
        }
      }
      return saved;
    };

    if (type === 'characters' || type === 'all') {
      let items = analysis.characters || [];
      if (names && names.length) items = items.filter(c => names.includes(c.name));
      const generated = await generateCharacterImages(items, null, ip, style);
      const saved = await saveGenerated(generated, 'characters');
      let existing = {};
      if (fs.existsSync(p.charImages)) existing = JSON.parse(fs.readFileSync(p.charImages, 'utf-8'));
      results.characters = { ...existing, ...saved };
      fs.writeFileSync(p.charImages, JSON.stringify(results.characters, null, 2), 'utf-8');
    }
    if (type === 'scenes' || type === 'all') {
      let items = analysis.scenes || [];
      if (names && names.length) items = items.filter(s => names.includes(s.name));
      const generated = await generateSceneImages(items, null, ip, style);
      const saved = await saveGenerated(generated, 'scenes');
      let existing = {};
      if (fs.existsSync(p.sceneImages)) existing = JSON.parse(fs.readFileSync(p.sceneImages, 'utf-8'));
      results.scenes = { ...existing, ...saved };
      fs.writeFileSync(p.sceneImages, JSON.stringify(results.scenes, null, 2), 'utf-8');
    }
    if (type === 'props' || type === 'all') {
      let items = analysis.props || [];
      if (names && names.length) items = items.filter(pr => names.includes(pr.name));
      const generated = await generatePropsImages(items, null, ip, style);
      const saved = await saveGenerated(generated, 'props');
      let existing = {};
      if (fs.existsSync(p.propsImages)) existing = JSON.parse(fs.readFileSync(p.propsImages, 'utf-8'));
      results.props = { ...existing, ...saved };
      fs.writeFileSync(p.propsImages, JSON.stringify(results.props, null, 2), 'utf-8');
    }

    // 统计生成结果
    let total = 0, failed = 0;
    for (const cat of Object.values(results)) {
      for (const url of Object.values(cat)) {
        total++;
        if (!url) failed++;
      }
    }
    if (total > 0 && failed === total) {
      return res.status(500).json({ error: '所有图片生成均失败，请检查图片生成API配置' });
    }

    res.json({ ok: true, results, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 即梦生成参考图（浏览器自动化，返回多张候选图） */
app.post('/api/workflow/generate-image-jimeng', async (req, res) => {
  const { projectPath, category, name, prompt, aspectRatio, referenceImageUrl, quality } = req.body;
  try {
    await jimeng.initBrowser();
    const imgPrompt = prompt || `${name}, character design, high quality, detailed`;
    const taskParams = { prompt: imgPrompt, shotNumber: 0 };
    if (referenceImageUrl) taskParams.referenceImageUrl = referenceImageUrl;
    if (quality) taskParams.quality = quality;
    const result = await jimeng.submitImageTask(taskParams);
    res.json({ ok: true, taskId: result.taskId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 上传参考图（base64） */
app.post('/api/workflow/upload-ref-image', (req, res) => {
  const { projectPath, category, name, imageData } = req.body;
  // category: 'characters' | 'scenes' | 'props'
  const VALID_CATEGORIES = ['characters', 'scenes', 'props'];
  if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: '无效的分类' });
  try {
    const p = projectPaths(projectPath);
    const dir = path.join(projectPath, 'images', category);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // imageData is "data:image/png;base64,xxx"
    const match = imageData.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: '无效的图片数据' });
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const buf = Buffer.from(match[2], 'base64');
    const safeName = name.replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(dir, `${safeName}.${ext}`);
    fs.writeFileSync(filePath, buf);

    // 更新对应的JSON引用
    const jsonMap = { characters: p.charImages, scenes: p.sceneImages, props: p.propsImages };
    const jsonPath = jsonMap[category];
    let data = {};
    if (jsonPath && fs.existsSync(jsonPath)) data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    data[name] = filePath;
    if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');

    res.json({ ok: true, url: filePath, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 设置参考图（从资产库拖拽，使用已有的图片URL/路径） */
app.post('/api/workflow/set-ref-image', (req, res) => {
  const { projectPath, category, name, imageUrl } = req.body;
  try {
    const p = projectPaths(projectPath);
    const jsonMap = { characters: p.charImages, scenes: p.sceneImages, props: p.propsImages };
    const jsonPath = jsonMap[category];
    if (!jsonPath) return res.status(400).json({ error: '无效的分类' });
    let data = {};
    if (fs.existsSync(jsonPath)) data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    data[name] = imageUrl;
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 删除参考图 */
app.post('/api/workflow/delete-ref-image', (req, res) => {
  const { projectPath, category, name } = req.body;
  try {
    const p = projectPaths(projectPath);
    const jsonMap = { characters: p.charImages, scenes: p.sceneImages, props: p.propsImages };
    const jsonPath = jsonMap[category];
    if (!jsonPath) return res.status(400).json({ error: '无效的分类' });
    let data = {};
    if (fs.existsSync(jsonPath)) data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    delete data[name];
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** ======== 即梦视频生成 API（内置浏览器） ======== */

/** 向内置即梦服务提交视频生成任务 */
app.post('/api/workflow/generate-video', async (req, res) => {
  const { projectPath, shotIndex, videoParams, refMode, service, accountId } = req.body;
  const vp = videoParams || {};
  const svc = _getVideoService(service || vp.service || 'jimeng');
  try {
    const p = projectPaths(projectPath);
    // 优先读 shots.json（含提示词），其次 shot_plans.json（直接转换后）
    const shotsFile = fs.existsSync(p.shots) ? p.shots : p.shotPlans;
    const shots = JSON.parse(fs.readFileSync(shotsFile, 'utf-8'));
    const shot = shots[shotIndex];
    if (!shot) return res.status(400).json({ error: `分镜 ${shotIndex} 不存在` });

    // 收集参考图
    const charImgs  = fs.existsSync(p.charImages)  ? JSON.parse(fs.readFileSync(p.charImages, 'utf-8'))  : {};
    const sceneImgs = fs.existsSync(p.sceneImages) ? JSON.parse(fs.readFileSync(p.sceneImages, 'utf-8')) : {};
    const propsImgs = fs.existsSync(p.propsImages) ? JSON.parse(fs.readFileSync(p.propsImages, 'utf-8')) : {};

    const referenceImages = [];
    for (const name of (shot.characters || [])) {
      if (charImgs[name]) referenceImages.push({ url: charImgs[name], name, type: 'character_reference' });
    }
    if (shot.scene) {
      const sceneUrl = sceneImgs[shot.scene] || Object.entries(sceneImgs).find(([k]) => shot.scene.includes(k) || k.includes(shot.scene))?.[1];
      if (sceneUrl) referenceImages.push({ url: sceneUrl, name: shot.scene, type: 'scene_reference' });
    }
    for (const name of (shot.props || [])) {
      if (propsImgs[name]) referenceImages.push({ url: propsImgs[name], name, type: 'props_reference' });
    }

    // 确保浏览器已启动
    await svc.initBrowser();

    const result = await svc.submitVideoTask({
      videoPrompt: shot.videoPrompt || shot.content || '',
      imagePrompt: shot.imagePrompt || shot.background || '',
      referenceImages,
      aspectRatio: vp.aspectRatio || '16:9',
      duration: vp.duration || 5,
      model: vp.model || (svc === kling ? 'kling-standard' : 'seedance-2.0'),
      generationMode: 'omni_reference',
      shotNumber: shot.shotNumber,
      refMode: refMode || 'inline',
      projectName: path.basename(projectPath),
      projectPath,
      shotIndex,
      accountId: accountId || vp.accountId || null,
    });

    addPendingTask(result.taskId, projectPath, shotIndex);

    res.json({ ok: true, taskId: result.taskId, shotIndex });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 查询任务状态（直接从内置服务获取） */
app.post('/api/workflow/check-task', async (req, res) => {
  const { taskId } = req.body;
  try {
    const svc = _getVideoService(taskId);
    const status = svc.getTaskStatus(taskId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workflow/cancel-task', async (req, res) => {
  const { taskId } = req.body;
  try {
    const svc = _getVideoService(taskId);
    const result = svc.cancelTask(taskId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 保存视频结果到项目（串行化防竞态） */
let _saveVideoQueue = Promise.resolve();
app.post('/api/workflow/save-video-result', (req, res) => {
  const { projectPath, shotIndex, videoUrl, videoUrls, taskId, taskIds } = req.body;
  _saveVideoQueue = _saveVideoQueue.then(async () => {
    try {
      const p = projectPaths(projectPath);
      const projectName = path.basename(projectPath);
      const videosDir = path.join(p.generation, 'videos');
      fs.mkdirSync(videosDir, { recursive: true });

      // 从URL中提取视频扩展名
      function videoExt(url) {
        try {
          if (/^[A-Z]:\\/i.test(url)) return path.extname(url).toLowerCase() || '.mp4';
          const pathname = new URL(url).pathname;
          const ext = path.extname(pathname).toLowerCase();
          return ['.mp4', '.webm', '.mov', '.avi'].includes(ext) ? ext : '.mp4';
        } catch { return '.mp4'; }
      }

      // 复制/下载视频到项目文件夹
      // downloadImageToLocal 不处理本地服务器路径（如 /images/xxx），需要特殊处理
      const _tempFilesToClean = [];
      function copyOrDownloadVideo(srcUrl, destPath) {
        // 已经在项目视频文件夹中（绝对路径且在 videosDir 下）→ 直接使用
        if (/^[A-Z]:\\/i.test(srcUrl) && srcUrl.toLowerCase().startsWith((videosDir + path.sep).toLowerCase())) {
          return srcUrl;
        }
        if (srcUrl.startsWith('/images/') || srcUrl.startsWith('/output/')) {
          const localFile = path.join(APP_DATA, srcUrl);
          if (fs.existsSync(localFile)) {
            fs.copyFileSync(localFile, destPath);
            _tempFilesToClean.push(localFile);
            return destPath;
          }
        }
        // 其他绝对路径（不在项目文件夹中）→ 复制
        if (/^[A-Z]:\\/i.test(srcUrl) && fs.existsSync(srcUrl)) {
          fs.copyFileSync(srcUrl, destPath);
          return destPath;
        }
        return downloadImageToLocal(srcUrl, destPath);
      }

      // 时间戳用于文件名，避免覆盖旧视频
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // 20250101143025

      let localVideoUrl = videoUrl;
      let localVideoUrls;

      if (videoUrls && videoUrls.length > 1) {
        localVideoUrls = [...videoUrls];
        for (let i = 0; i < localVideoUrls.length; i++) {
          const ext = videoExt(localVideoUrls[i]);
          const fileName = `${projectName}_分镜${shotIndex + 1}_${i + 1}_${ts}${ext}`;
          localVideoUrls[i] = await copyOrDownloadVideo(localVideoUrls[i], path.join(videosDir, fileName));
        }
        localVideoUrl = localVideoUrls[0];
      } else {
        const ext = videoExt(videoUrl);
        const fileName = `${projectName}_分镜${shotIndex + 1}_${ts}${ext}`;
        localVideoUrl = await copyOrDownloadVideo(videoUrl, path.join(videosDir, fileName));
        localVideoUrls = [localVideoUrl];
      }

      let videoData = {};
      if (fs.existsSync(p.shotVideos)) videoData = JSON.parse(fs.readFileSync(p.shotVideos, 'utf-8'));
      videoData[shotIndex] = { videoUrl: localVideoUrl, videoUrls: localVideoUrls, generatedAt: new Date().toISOString() };
      fs.writeFileSync(p.shotVideos, JSON.stringify(videoData, null, 2), 'utf-8');

      // 也更新 shots.json
      const shots = JSON.parse(fs.readFileSync(p.shots, 'utf-8'));
      if (shots[shotIndex]) {
        shots[shotIndex].videoUrl = localVideoUrl;
        if (localVideoUrls.length > 1) shots[shotIndex].videoUrls = localVideoUrls;
      }
      fs.writeFileSync(p.shots, JSON.stringify(shots, null, 2), 'utf-8');

      // 从持久化列表中清除已完成任务
      if (taskId) removePendingTask(taskId);
      if (taskIds && Array.isArray(taskIds)) taskIds.forEach(id => removePendingTask(id));

      // 清理 images/ 中的临时视频文件（已复制到项目文件夹）
      for (const tmpFile of _tempFilesToClean) {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
      }

      res.json({ ok: true, videoUrl: localVideoUrl, videoUrls: localVideoUrls });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

/** 查询所有进行中的任务（用于恢复监控） */
app.post('/api/workflow/pending-tasks', (req, res) => {
  try {
    const tasks = loadPendingTasks();
    const result = [];
    for (const [taskId, info] of Object.entries(tasks)) {
      const svc = _getVideoService(taskId);
      const status = svc.getTaskStatus(taskId);
      result.push({
        taskId,
        projectPath: info.projectPath,
        shotIndex: info.shotIndex,
        startedAt: info.startedAt,
        ...status,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** ======== 抖音热门 ======== */

app.get('/api/douyin/hot', async (req, res) => {
  try {
    const keywords = req.query.keywords
      ? req.query.keywords.split(',').map(k => k.trim()).filter(Boolean)
      : [];
    const resp = await fetch('https://newsnow.busiyi.world/api/s?id=douyin&latest', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!resp.ok) throw new Error(`NewsNow API 返回 ${resp.status}`);
    const data = await resp.json();
    let items = (data.items || []).map((it, i) => ({
      rank: i + 1,
      title: it.title || '',
      url: it.url || it.mobileUrl || '',
      hot: it.extra?.info || '',
    }));
    if (keywords.length) {
      items = items.filter(it =>
        keywords.some(kw => it.title.includes(kw))
      );
    }
    res.json({ ok: true, items, total: items.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** ======== B站搞笑/沙雕搜索 ======== */

app.get('/api/bilibili/funny', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize) || 20, 50);
    const order = req.query.order || 'click'; // click=播放量, scores=综合, stow=收藏, dm=弹幕
    const keyword = req.query.keyword || '沙雕动漫';
    const days = parseInt(req.query.days) || 3;

    // 用分区搜索API+关键词+时间范围，实现「近期热门」
    const now = new Date();
    const timeTo = now.toISOString().slice(0, 10).replace(/-/g, '');
    const from = new Date(now.getTime() - days * 86400000);
    const timeFrom = from.toISOString().slice(0, 10).replace(/-/g, '');

    const url = `https://s.search.bilibili.com/cate/search?main_ver=v3&search_type=video&view_type=hot_rank&order=${encodeURIComponent(order)}&copy_right=-1&cate_id=27&page=${page}&pagesize=${pageSize}&time_from=${timeFrom}&time_to=${timeTo}&keyword=${encodeURIComponent(keyword)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com',
      },
    });
    if (!resp.ok) throw new Error(`Bilibili API 返回 ${resp.status}`);
    const data = await resp.json();
    if (data.code !== 0) throw new Error(data.message || '请求失败');

    const items = (data.result || []).map((v, i) => ({
      rank: (page - 1) * pageSize + i + 1,
      title: (v.title || '').replace(/<[^>]*>/g, ''),
      author: v.author || '',
      play: v.play || 0,
      danmaku: v.video_review || v.danmaku || 0,
      favorites: v.favorites || 0,
      cover: v.pic ? v.pic.replace(/^\/\//, 'https://') : '',
      url: v.arcurl || `https://www.bilibili.com/video/${v.bvid || ''}`,
      duration: v.duration || '',
      pubdate: v.pubdate || 0,
    }));

    res.json({ ok: true, items, total: data.numResults || items.length, page, pageSize, timeRange: `${timeFrom}-${timeTo}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 全局错误处理 —— 确保所有错误返回 JSON（而非 Express 默认 HTML）
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

/** ======== 启动 ======== */

export function startServer(port = 13579) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      resolve(port);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // 端口被占用，尝试下一个
        resolve(startServer(port + 1));
      } else {
        reject(err);
      }
    });
  });
}
