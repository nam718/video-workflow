/**
 * 可灵(Kling AI)Web视频生成服务（内置版）
 * 
 * 通过 puppeteer 控制内置 Chromium 浏览器访问 app.klingai.com
 * 实现自动化视频生成（文生视频 / 图生视频）
 * 
 * 架构与即梦服务一致：CDP浏览器 → 多账号并发 → 任务队列 → 网络拦截 → 自动下载
 */

const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

// ==================== 配置 ====================

const DATA_DIR = process.env.APP_USER_DATA || path.join(__dirname, '..');

const _LOG_FILE = path.join(DATA_DIR, 'kling_trace.log');
function _traceLog(msg) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    try { fs.appendFileSync(_LOG_FILE, `[${ts}] ${msg}\n`); } catch (_) {}
    console.log(msg);
}

const CONFIG = {
    chromePath: findChromePath(),
    userDataDir: path.join(
        process.env.APPDATA || path.join(os.homedir(), '.config'),
        'video-workflow',
        '.kling_profile'
    ),

    // ===== URL 配置 =====
    baseUrl: 'https://app.klingai.com/cn',
    createUrl: 'https://app.klingai.com/cn/omni/new?ac=1',
    imageToVideoUrl: 'https://app.klingai.com/cn/omni/new?ac=1',
    loginUrl: 'https://app.klingai.com/cn',

    // CDP 远程调试端口（与即梦错开，避免冲突）
    cdpPort: 9333,

    // ===== 模型配置 =====
    // 可灵统一使用 3.0 Omni 模型，通过分辨率（720p/1080p）区分
    // 前端传 'kling-720p' 或 'kling-1080p'，都选择 "视频 3.0 Omni"
    // 分辨率通过 _configureAllSettings 的 mode 参数控制
    models: {
        'kling-720p': { display: '视频 3.0 Omni', clickText: '视频 3.0 Omni', resolution: '720p' },
        'kling-1080p': { display: '视频 3.0 Omni', clickText: '视频 3.0 Omni', resolution: '1080p' },
        // 兼容旧值
        'kling-standard': { display: '视频 3.0 Omni', clickText: '视频 3.0 Omni', resolution: '720p' },
    },
    defaultModel: 'kling-720p',

    // 画幅比例选项（可灵: 智能/9:16/1:1/16:9）
    aspectRatioOptions: ['智能', '9:16', '1:1', '16:9'],

    // 时长选项（可灵支持 3s-15s）
    durationOptions: ['3s', '4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],

    // 分辨率选项
    resolutionOptions: ['720p', '1080p'],

    // ===== DOM 选择器（基于 app.klingai.com/cn/omni 实际 DOM）=====
    // UI框架: Element Plus (Vue) + TipTap/ProseMirror 富文本编辑器
    selectors: {
        // 提示词输入区 — TipTap ProseMirror 编辑器
        promptEditor: '.tiptap.ProseMirror',
        promptEditorParent: '.editor',
        // 参考图上传
        imageFileInput: 'input.el-upload__input[accept*="jpg"]',
        videoFileInput: 'input.el-upload__input[accept*="mp4"]',
        uploadArea: '.omni-material-pool__material-select-section',
        // 生成按钮
        generateBtn: 'button.generic-button.critical.big',
        generateBtnContainer: '.button-pay-container',
        // 模型选择 — Element Plus Dropdown
        modelSelector: '.model-type-select',
        modelDropdown: '.el-dropdown',
        // 设置区域
        settingArea: '.omni-setting-area',
        settingSelect: '.setting-select',  // 显示 "720p · 5s"
        settingSwitch: '.setting-switch',   // 音画同步、智能分镜
        // 时长元素
        durationItem: '.omni-video-item',
        // 登录检测
        avatarSection: '.avatar-section',
        // 主体选择
        subjectBtn: '.subject-btn',
        // 主容器
        mainContainer: '.omni-main-container',
        inputFieldContainer: '.input-field-container',
    },

    // 超时配置
    loginTimeout: 300000,
    taskTimeout: 28800000,
    pollInterval: 5000,
    cookieFile: path.join(
        process.env.APPDATA || path.join(os.homedir(), '.config'),
        'video-workflow',
        '.kling_profile',
        'cookies.json'
    ),
};

function findChromePath() {
    if (os.platform() === 'win32') {
        const extraChrome = path.join(__dirname, '..', 'resources', 'chrome-win', 'chrome.exe');
        if (fs.existsSync(extraChrome)) return extraChrome;
        const possiblePaths = [
            path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ];
        for (const p of possiblePaths) { if (fs.existsSync(p)) return p; }
    } else if (os.platform() === 'darwin') {
        const paths = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ];
        for (const p of paths) { if (fs.existsSync(p)) return p; }
    }
    return null;
}

// ==================== 任务存储 ====================

const taskStore = {};
const taskQueue = [];
const videoTaskQueue = [];
const activeVideoTaskPages = new Map();
let isProcessingQueue = false;
let activeVideoTaskCount = 0;
let activePollingCount = 0;
const _claimedVideoUrls = new Set();
let _videoSubmitLock = Promise.resolve();

// ==================== 账号管理 ====================

const _accounts = new Map();

function _createAccountState(accountId, cdpPort, name) {
    const profileDir = accountId === 'default'
        ? CONFIG.userDataDir
        : path.join(path.dirname(CONFIG.userDataDir), `.kling_profile_${accountId}`);
    return {
        id: accountId,
        name: name || (accountId === 'default' ? '默认账号' : accountId),
        browser: null,
        mainPage: null,
        chromeProcess: null,
        isInitializing: false,
        cdpPort: cdpPort,
        userDataDir: profileDir,
        cookieFile: path.join(profileDir, 'cookies.json'),
        activeTaskCount: 0,
    };
}

_accounts.set('default', _createAccountState('default', CONFIG.cdpPort, '默认账号'));

function _loadAccountsFromConfig() {
    try {
        const cfgPath = path.join(
            process.env.APPDATA || path.join(os.homedir(), '.config'),
            'video-workflow', 'config.json'
        );
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            if (Array.isArray(cfg.klingAccounts)) {
                cfg.klingAccounts.forEach(acc => {
                    if (acc.id && acc.id !== 'default' && !_accounts.has(acc.id)) {
                        _accounts.set(acc.id, _createAccountState(acc.id, acc.cdpPort, acc.name));
                    }
                });
                console.log(`[可灵] 已加载 ${_accounts.size} 个账号`);
            }
        }
    } catch (e) {
        console.log('[可灵] 加载账号配置失败:', e.message);
    }
}
_loadAccountsFromConfig();

function _getAccount(accountId = 'default') {
    return _accounts.get(accountId) || _accounts.get('default');
}

// ==================== 网络拦截 ====================

/**
 * 判断 URL 是否为可灵的生成 API 端点
 * 可灵 Omni 使用 /api/omni/ 系列端点 + /api/task/ 端点
 */
function _isGenerateEndpoint(url) {
    return url.includes('/api/omni/submit') ||
           url.includes('/api/omni/intent-recognition') ||
           url.includes('/api/task/submit') ||
           url.includes('/api/generate') ||
           url.includes('/web/v1/video/generate');
}

/**
 * 判断 URL 是否为可灵的任务状态查询 API
 * 可灵通过 /api/user/works/personal/feeds 轮询作品列表
 */
function _isTaskStatusEndpoint(url) {
    return url.includes('/api/user/works/personal/feeds') ||
           url.includes('/api/task/status') ||
           url.includes('/api/task/query') ||
           url.includes('/api/omni/status') ||
           url.includes('/web/v1/video/query');
}

function _looksLikeVideoUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return (lower.includes('.mp4') || lower.includes('.m3u8') || lower.includes('.webm') || lower.includes('video'))
        && (lower.startsWith('http') || lower.startsWith('blob:'));
}

function _sanitizeUrlForLog(url) {
    if (!url) return 'null';
    return url.length > 120 ? url.substring(0, 120) + '...' : url;
}

function _setupNetworkInterceptor(page) {
    let capturedTaskId = null;
    let capturedVideoUrl = null;
    let capturedFailure = null;
    let taskIdLocked = false;

    const onResponse = async (response) => {
        try {
            const url = response.url();
            const status = response.status();
            if (status < 200 || status >= 300) return;

            // 拦截生成请求的响应 → 提取 task_id
            if (_isGenerateEndpoint(url) && !capturedTaskId && !taskIdLocked) {
                try {
                    const json = await response.json();
                    const taskId = _deepFindTaskId(json);
                    if (taskId) {
                        capturedTaskId = taskId;
                        console.log(`[可灵] 网络拦截: 捕获 task_id=${taskId}`);
                    }
                } catch (e) {
                    try {
                        const text = await response.text();
                        const match = text.match(/"task_id"\s*:\s*"([^"]+)"/);
                        if (match) {
                            capturedTaskId = match[1];
                            console.log(`[可灵] 网络拦截: 从文本捕获 task_id=${capturedTaskId}`);
                        }
                    } catch (_) {}
                }
            }

            // 拦截任务状态查询响应 → 提取视频 URL
            if (_isTaskStatusEndpoint(url) && capturedTaskId && !capturedVideoUrl) {
                try {
                    const json = await response.json();
                    const videoUrl = _scanVideoFromResponse(json, capturedTaskId);
                    if (videoUrl) {
                        capturedVideoUrl = videoUrl;
                        console.log(`[可灵] 网络拦截: 视频 URL (task=${capturedTaskId}): ${_sanitizeUrlForLog(videoUrl)}`);
                    }
                    // 检测失败状态
                    if (!capturedVideoUrl && !capturedFailure) {
                        const failure = _scanFailureFromResponse(json, capturedTaskId);
                        if (failure) {
                            capturedFailure = failure;
                            console.log(`[可灵] 网络拦截: 失败状态 (task=${capturedTaskId}): ${failure}`);
                        }
                    }
                } catch (_) {}
            }
        } catch (_) {}
    };

    page.on('response', onResponse);
    console.log('[可灵] 网络拦截器已安装');

    return {
        getTaskId: () => capturedTaskId,
        getVideoUrl: () => capturedVideoUrl,
        getFailure: () => capturedFailure,
        lockTaskId: () => { taskIdLocked = true; },
        cleanup: () => {
            page.off('response', onResponse);
            console.log('[可灵] 网络拦截器已卸载');
        },
    };
}

/**
 * 从 JSON 中递归查找 task_id / taskId
 */
function _deepFindTaskId(obj) {
    if (!obj || typeof obj !== 'object') return null;
    // 优先：data.task.id（可灵 submit 响应的标准结构）
    if (obj.data?.task?.id && _isValidTaskId(String(obj.data.task.id))) {
        return String(obj.data.task.id);
    }
    // 其次：task_id / taskId 字段
    for (const key of ['task_id', 'taskId']) {
        const v = obj[key];
        if (typeof v === 'string' && _isValidTaskId(v)) return v;
        if (typeof v === 'number' && v > 100000) return String(v);
    }
    // data 层级
    if (obj.data) {
        for (const key of ['task_id', 'taskId', 'id']) {
            const v = obj.data[key];
            if (typeof v === 'string' && _isValidTaskId(v)) return v;
            if (typeof v === 'number' && v > 100000) return String(v);
        }
    }
    // 递归
    for (const val of Object.values(obj)) {
        if (typeof val === 'object') {
            const found = _deepFindTaskId(val);
            if (found) return found;
        }
    }
    return null;
}

function _isValidTaskId(s) {
    if (!s || s.length < 6) return false;
    // 排除纯小写字母+下划线（配置字段名如 model_mode）
    if (/^[a-z_]+$/.test(s)) return false;
    // 数字ID（如 305796835161046）或 UUID 格式
    return /^\d{6,}$/.test(s) || /^[0-9a-f-]{8,}$/i.test(s) || /\d/.test(s);
}

/**
 * 从任务状态响应中扫描视频 URL（精确匹配 taskId）
 */
function _scanVideoFromResponse(json, taskId) {
    if (!json || typeof json !== 'object') return null;
    // 优先：从 feeds history 中精确匹配 task_id 对应的 history item
    if (taskId && Array.isArray(json.data?.history)) {
        for (const h of json.data.history) {
            const hTaskId = String(h.task?.id || '');
            if (hTaskId === taskId) {
                // 精确匹配到我们的任务
                if (Array.isArray(h.works)) {
                    for (const w of h.works) {
                        if (w.resource?.resource && w.resource.resource.length > 10 && w.resource.resource.startsWith('http') && _looksLikeVideoUrl(w.resource.resource)) {
                            return w.resource.resource;
                        }
                    }
                }
                return null; // 匹配到任务但没有视频 URL（可能还在生成中）
            }
        }
    }
    // 回退：非 feeds 响应（如单任务状态查询），检查整个 JSON 是否包含 taskId
    const jsonStr = JSON.stringify(json);
    if (taskId && !jsonStr.includes(taskId)) return null;
    return _deepFindVideoUrl(json);
}

function _deepFindVideoUrl(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const key of ['video_url', 'videoUrl', 'result_url', 'resultUrl', 'url', 'download_url', 'downloadUrl']) {
        const val = obj[key];
        if (typeof val === 'string' && _looksLikeVideoUrl(val)) return val;
    }
    // 检查 works 数组
    if (Array.isArray(obj.works || obj.data?.works)) {
        const works = obj.works || obj.data?.works;
        for (const w of works) {
            if (w.resource?.resource && w.resource.resource.length > 10 && w.resource.resource.startsWith('http')) return w.resource.resource;
            if (w.url && _looksLikeVideoUrl(w.url)) return w.url;
        }
    }
    // 检查 history 数组（兜底，无 taskId 场景）
    if (Array.isArray(obj.data?.history)) {
        for (const h of obj.data.history) {
            if (Array.isArray(h.works)) {
                for (const w of h.works) {
                    if (w.resource?.resource && w.resource.resource.length > 10 && w.resource.resource.startsWith('http')) return w.resource.resource;
                }
            }
        }
    }
    for (const val of Object.values(obj)) {
        if (typeof val === 'object') {
            const found = _deepFindVideoUrl(val);
            if (found) return found;
        }
    }
    return null;
}

/**
 * 从响应中检测失败状态
 */
function _scanFailureFromResponse(json, taskId) {
    if (!json || typeof json !== 'object') return null;
    const str = JSON.stringify(json);
    if (taskId && !str.includes(taskId)) return null;
    // 常见失败关键词
    const failMatch = str.match(/"(?:error_msg|message|reason|fail_reason)"\s*:\s*"([^"]{5,100})"/);
    if (failMatch) {
        const msg = failMatch[1];
        const failKeywords = ['失败', '违规', '不合规', '审核', '余额', '积分', 'fail', 'error', 'reject', 'insufficient'];
        if (failKeywords.some(kw => msg.toLowerCase().includes(kw))) return msg;
    }
    // 检查 status 字段
    if (json.data?.status === 'failed' || json.data?.task_status === 'failed') {
        return json.data?.message || json.data?.error_msg || '生成失败';
    }
    return null;
}

// ==================== CDP / Chrome 管理 ====================

function _checkCdpAlive(port) {
    const cdpPort = port || CONFIG.cdpPort;
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${cdpPort}/json/version`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    });
}

async function _launchChrome(account) {
    const acct = account || _getAccount('default');
    if (!CONFIG.chromePath) CONFIG.chromePath = findChromePath();
    if (!CONFIG.chromePath) {
        throw new Error('未找到Chrome或Edge浏览器，请安装后重试');
    }
    if (!fs.existsSync(acct.userDataDir)) {
        fs.mkdirSync(acct.userDataDir, { recursive: true });
    }

    const args = [
        `--remote-debugging-port=${acct.cdpPort}`,
        `--user-data-dir=${acct.userDataDir}`,
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1280,900',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=IsolateOrigins,site-per-process',
        `--lang=zh-CN`,
        CONFIG.baseUrl,
    ];

    console.log(`[可灵] 启动Chrome(CDP): ${CONFIG.chromePath}, 账号: ${acct.name}`);
    console.log(`[可灵] CDP端口: ${acct.cdpPort}, 用户目录: ${acct.userDataDir}`);

    acct.chromeProcess = spawn(CONFIG.chromePath, args, {
        detached: true,
        stdio: 'ignore',
    });
    acct.chromeProcess.unref();
    acct.chromeProcess.on('error', (err) => {
        console.error(`[可灵] Chrome启动失败(${acct.name}):`, err.message);
        acct.chromeProcess = null;
    });

    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const info = await _checkCdpAlive(acct.cdpPort);
        if (info) {
            console.log(`[可灵] Chrome CDP就绪(${acct.name}): ${info.Browser || 'Chrome'}`);
            return;
        }
    }
    throw new Error(`Chrome CDP端口未就绪(${acct.name})，启动超时`);
}

async function initBrowser(accountId) {
    const acct = _getAccount(accountId);
    if (acct.browser && acct.browser.isConnected()) return acct.browser;

    if (acct.isInitializing) {
        while (acct.isInitializing) await new Promise(r => setTimeout(r, 500));
        if (!acct.browser || !acct.browser.isConnected()) throw new Error(`浏览器初始化失败(${acct.name})`);
        return acct.browser;
    }

    acct.isInitializing = true;
    try {
        let cdpInfo = await _checkCdpAlive(acct.cdpPort);
        if (cdpInfo) {
            console.log(`[可灵] 检测到已有Chrome(CDP, ${acct.name})`);
            try {
                const testBrowser = await puppeteer.connect({
                    browserURL: `http://127.0.0.1:${acct.cdpPort}`,
                    defaultViewport: null,
                });
                const pages = await testBrowser.pages();
                const hasVisiblePage = pages.some(p => {
                    const url = p.url();
                    return url && !url.startsWith('chrome://') && url !== 'about:blank';
                });
                if (!hasVisiblePage) {
                    try { await testBrowser.close(); } catch {}
                    acct.chromeProcess = null;
                    await new Promise(r => setTimeout(r, 1500));
                    cdpInfo = null;
                } else {
                    testBrowser.disconnect();
                }
            } catch { cdpInfo = null; }
        }

        if (!cdpInfo) {
            await _launchChrome(acct);
            cdpInfo = await _checkCdpAlive(acct.cdpPort);
            if (!cdpInfo) throw new Error(`Chrome启动后CDP仍不可用(${acct.name})`);
        }

        acct.browser = await puppeteer.connect({
            browserURL: `http://127.0.0.1:${acct.cdpPort}`,
            defaultViewport: null,
        });
        console.log(`[可灵] Puppeteer已连接Chrome(${acct.name})`);

        const pages = await acct.browser.pages();
        acct.mainPage = pages.find(p => p.url().includes('klingai.com')) || pages[0];
        if (!acct.mainPage) acct.mainPage = await acct.browser.newPage();

        // 反自动化检测
        try {
            await acct.mainPage.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
                window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
            });
        } catch (_) {}

        // 监听断开
        acct.browser.on('disconnected', () => {
            console.log(`[可灵] CDP连接已断开(${acct.name})`);
            acct.browser = null;
            acct.mainPage = null;
            acct.activeTaskCount = 0;
            for (const [tid, task] of Object.entries(taskStore)) {
                if ((task.status === 'processing' || task.status === 'pending') && task._accountId === acct.id) {
                    task.status = 'failed';
                    task.error = `浏览器连接已断开(${acct.name})`;
                    task.message = '浏览器被关闭或连接中断';
                }
            }
            const anyConnected = [..._accounts.values()].some(a => a.browser && a.browser.isConnected());
            if (!anyConnected) {
                taskQueue.length = 0;
                videoTaskQueue.length = 0;
                activeVideoTaskPages.clear();
                isProcessingQueue = false;
                activeVideoTaskCount = 0;
                activePollingCount = 0;
                _claimedVideoUrls.clear();
                _videoSubmitLock = Promise.resolve();
            }
        });

        return acct.browser;
    } finally {
        acct.isInitializing = false;
    }
}

async function getPage(accountId) {
    const acct = _getAccount(accountId);
    await initBrowser(acct.id);
    if (!acct.mainPage || acct.mainPage.isClosed()) {
        const pages = await acct.browser.pages();
        acct.mainPage = pages.find(p => p.url().includes('klingai.com')) || pages[0];
        if (!acct.mainPage) acct.mainPage = await acct.browser.newPage();
    }
    return acct.mainPage;
}

// ==================== 任务队列管理 ====================

function _pickLeastBusyAccount() {
    let best = null;
    let minTasks = Infinity;
    for (const acct of _accounts.values()) {
        if (acct.browser && acct.browser.isConnected() && acct.activeTaskCount < 3) {
            if (acct.activeTaskCount < minTasks) {
                minTasks = acct.activeTaskCount;
                best = acct;
            }
        }
    }
    return best;
}

function _getTotalMaxConcurrent() {
    let total = 0;
    for (const acct of _accounts.values()) {
        if (acct.browser && acct.browser.isConnected()) total += 3;
    }
    return Math.max(total, 3);
}

async function _createVideoTaskPage(taskId, accountId) {
    const acct = _getAccount(accountId);
    await initBrowser(acct.id);
    const page = await acct.browser.newPage();
    try {
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
            window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
        });
    } catch (_) {}
    activeVideoTaskPages.set(taskId, { page, accountId: acct.id });
    acct.activeTaskCount++;
    console.log(`[可灵] 为任务${taskId}创建独立页面(${acct.name})`);
    return page;
}

async function _closeVideoTaskPage(taskId, page) {
    const entry = activeVideoTaskPages.get(taskId);
    activeVideoTaskPages.delete(taskId);
    const ownedPage = page || (entry && entry.page);
    if (entry) {
        const acct = _getAccount(entry.accountId);
        acct.activeTaskCount = Math.max(0, acct.activeTaskCount - 1);
    }
    if (!ownedPage || ownedPage.isClosed()) return;
    for (const acct of _accounts.values()) {
        if (ownedPage === acct.mainPage) return;
    }
    try {
        await ownedPage.close({ runBeforeUnload: false });
        console.log(`[可灵] 任务${taskId}独立页面已关闭`);
    } catch (e) {
        console.log(`[可灵] 关闭任务${taskId}独立页面失败: ${e.message}`);
    }
}

function _refreshVideoTaskQueueMessages() {
    videoTaskQueue.forEach((item, idx) => {
        const task = taskStore[item.taskId];
        if (task && task.status === 'pending') {
            task.message = `等待空闲浏览器页（第${idx + 1}个）...`;
        }
    });
}

function _processVideoTaskQueue() {
    const maxTotal = _getTotalMaxConcurrent();
    while (activeVideoTaskCount < maxTotal && videoTaskQueue.length > 0) {
        const acct = _pickLeastBusyAccount();
        if (!acct) break;

        const { taskId, params } = videoTaskQueue.shift();
        activeVideoTaskCount++;
        _refreshVideoTaskQueueMessages();

        const task = taskStore[taskId];
        if (task) task._accountId = acct.id;

        _runVideoTaskOnIsolatedPage(taskId, params, acct.id)
            .catch((err) => {
                console.error(`[可灵] 视频任务${taskId}执行异常:`, err.message);
                const task = taskStore[taskId];
                if (task && task.status !== 'completed' && task.status !== 'failed') {
                    task.status = 'failed';
                    task.error = err.message;
                    task.message = '任务执行异常: ' + err.message;
                }
            })
            .finally(() => {
                activeVideoTaskCount = Math.max(0, activeVideoTaskCount - 1);
                _refreshVideoTaskQueueMessages();
                _processVideoTaskQueue();
            });
    }
}

async function _runVideoTaskOnIsolatedPage(taskId, params, accountId) {
    const task = taskStore[taskId];
    let page = null;
    try {
        let submitResult = null;
        const prevLock = _videoSubmitLock;
        _videoSubmitLock = new Promise(async (unlockSubmit) => {
            try {
                await prevLock;
                task.message = '准备独立浏览器页...';
                task.progress = 2;
                page = await _createVideoTaskPage(taskId, accountId);
                submitResult = await _executeSubmitPhase(taskId, params, page);
            } finally {
                unlockSubmit();
            }
        });
        await _videoSubmitLock;

        if (!submitResult) return;

        activePollingCount++;
        try {
            await _executePollPhase(taskId, submitResult.page, submitResult.interceptor);
        } finally {
            activePollingCount = Math.max(0, activePollingCount - 1);
        }
    } finally {
        await _closeVideoTaskPage(taskId, page);
    }
}

// ==================== 登录管理 ====================

async function checkLoginStatus(accountIdOrPage) {
    try {
        let page;
        if (accountIdOrPage && typeof accountIdOrPage === 'object' && typeof accountIdOrPage.evaluate === 'function') {
            page = accountIdOrPage;
        } else {
            page = await getPage(accountIdOrPage);
        }

        const currentUrl = page.url();
        console.log(`[可灵] checkLoginStatus: 当前URL=${currentUrl}`);

        // 如果当前页面不是 klingai.com，先导航过去
        if (!currentUrl.includes('klingai.com')) {
            console.log('[可灵] 页面不在 klingai.com，导航到首页...');
            await page.goto('https://app.klingai.com/cn', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000));
        }

        // 检查可灵登录状态
        const status = await page.evaluate(() => {
            const result = { loggedIn: false, username: '', debug: {} };

            // 已登录标志1：avatar-section
            const avatar = document.querySelector('.avatar-section');
            result.debug.hasAvatar = !!avatar;
            if (avatar) {
                result.loggedIn = true;
                return result;
            }

            // 已登录标志2：用户头像元素
            const userAvatar = document.querySelector('.user-avatar, .avatar-img, [class*="avatar"]');
            result.debug.hasUserAvatar = !!userAvatar;
            if (userAvatar && !document.querySelector('.login-btn')) {
                result.loggedIn = true;
                return result;
            }

            // 已登录标志3：导航菜单含"退出登录"
            const allPoppers = document.querySelectorAll('.el-popper');
            for (const p of allPoppers) {
                if (p.textContent && p.textContent.includes('退出登录')) {
                    result.debug.hasLogoutMenu = true;
                    result.loggedIn = true;
                    return result;
                }
            }

            // 已登录标志4：Cookie 检查
            const hasCookie = document.cookie.includes('userId') || document.cookie.includes('token') ||
                            document.cookie.includes('kuaishou') || document.cookie.includes('passToken');
            result.debug.hasCookie = hasCookie;
            if (hasCookie) {
                result.loggedIn = true;
                return result;
            }

            // 未登录标志
            result.debug.hasLoginBtn = !!document.querySelector('.login-btn');
            result.debug.hasLoginModal = !!document.querySelector('[class*="login-modal"], [class*="login-dialog"]');
            result.debug.url = window.location.href;
            result.debug.bodyText = document.body?.textContent?.slice(0, 200) || '';

            return result;
        });

        console.log(`[可灵] checkLoginStatus: loggedIn=${status.loggedIn}, debug=${JSON.stringify(status.debug)}`);
        return status;
    } catch (e) {
        console.error('[可灵] 登录状态检查失败:', e.message);
        return { loggedIn: false, username: '', error: e.message };
    }
}

async function openLoginPage(accountId) {
    try {
        const page = await getPage(accountId);
        await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log(`[可灵] 已打开登录页`);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function saveCookies(accountId) {
    try {
        const acct = _getAccount(accountId);
        if (!acct.browser || !acct.mainPage) {
            console.log('[可灵] saveCookies: 浏览器未初始化或页面不存在');
            return false;
        }
        const cookies = await acct.mainPage.cookies();
        if (!fs.existsSync(path.dirname(acct.cookieFile))) {
            fs.mkdirSync(path.dirname(acct.cookieFile), { recursive: true });
        }
        fs.writeFileSync(acct.cookieFile, JSON.stringify(cookies, null, 2), 'utf-8');
        console.log(`[可灵] Cookie已保存: ${acct.cookieFile} (${cookies.length}条)`);
        return true;
    } catch (e) {
        console.log('[可灵] Cookie保存失败:', e.message);
        return false;
    }
}

// ==================== 视频生成核心 ====================

async function submitVideoTask(params) {
    const { videoPrompt, aspectRatio, shotNumber, projectName, projectPath, shotIndex } = params;
    const taskId = `kling_${Date.now()}_${shotNumber || 0}`;

    await initBrowser('default');

    taskStore[taskId] = {
        status: 'pending',
        progress: 0,
        message: '排队中...',
        videoUrl: null,
        error: null,
        shotNumber,
        projectName: projectName || '',
        projectPath: projectPath || '',
        shotIndex: shotIndex != null ? shotIndex : -1,
        createdAt: Date.now(),
        _accountId: null,
    };

    videoTaskQueue.push({ taskId, params });
    const maxTotal = _getTotalMaxConcurrent();
    const queuePos = videoTaskQueue.length;
    if (activeVideoTaskCount >= maxTotal || queuePos > 1) {
        taskStore[taskId].message = `等待空闲浏览器页（第${queuePos}个）...`;
    } else {
        taskStore[taskId].message = '准备浏览器...';
    }

    _processVideoTaskQueue();
    return { taskId, status: 'pending' };
}

async function _executeSubmitPhase(taskId, params, pageOverride = null) {
    console.log(`[可灵] _executeSubmitPhase — taskId=${taskId}`);
    const { videoPrompt, aspectRatio, duration } = params;
    const referenceImages = params.referenceImages || [];
    const modelKey = params.model || CONFIG.defaultModel;
    const task = taskStore[taskId];

    try {
        const page = pageOverride || await getPage();

        // 1. 检查登录
        task.message = '检查登录状态...';
        task.progress = 5;
        const loginStatus = await checkLoginStatus(page);
        if (!loginStatus.loggedIn) {
            task.status = 'failed';
            task.error = '未登录，请先在浏览器中登录可灵';
            task.message = '未登录，请先登录';
            return null;
        }

        // 2. 导航到创作页面
        task.message = '打开创作页面...';
        task.progress = 10;
        // 如果有参考图则进入图生视频，否则文生视频
        const targetUrl = referenceImages.length > 0 ? CONFIG.imageToVideoUrl : CONFIG.createUrl;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await _randomDelay(2500, 3500);

        // 3. 等待页面加载 — 等待 TipTap 编辑器出现
        task.message = '等待页面加载...';
        task.progress = 15;
        await page.waitForSelector(
            '.tiptap.ProseMirror, [contenteditable="true"]',
            { timeout: 20000 }
        );
        await _randomDelay(500, 1000);

        // 4. 选择模型/模式
        task.message = `选择模型: ${modelKey}...`;
        task.progress = 18;
        await _selectModel(page, modelKey);
        await _randomDelay(500, 1000);

        // 5. 上传参考图（如果有）
        if (referenceImages.length > 0) {
            const maxRefs = Math.min(referenceImages.length, 4);
            for (let i = 0; i < maxRefs; i++) {
                const ref = referenceImages[i];
                task.message = `上传参考图 ${i + 1}/${maxRefs}: ${ref.name}...`;
                task.progress = 20 + Math.round((i / maxRefs) * 10);
                const localPath = await _ensureLocalImage(ref.url);
                if (localPath) {
                    // 记录上传前的图片数量
                    const beforeCount = await page.evaluate(() =>
                        document.querySelectorAll('[data-id^="image_"]').length
                    );
                    await _uploadReferenceImage(page, localPath);
                    // 等待上传完成：检查新 data-id 出现（数量增加）
                    const expectedId = `image_${i + 1}`;
                    let uploadOk = false;
                    for (let w = 0; w < 30; w++) {
                        await new Promise(r => setTimeout(r, 1000));
                        const currentCount = await page.evaluate(() =>
                            document.querySelectorAll('[data-id^="image_"]').length
                        );
                        const hasId = await page.evaluate((id) => !!document.querySelector(`[data-id="${id}"]`), expectedId);
                        if (hasId && currentCount > beforeCount) {
                            console.log(`[可灵] 图片${i + 1}上传确认 (${expectedId}, 总数 ${currentCount})`);
                            uploadOk = true;
                            break;
                        }
                    }
                    if (!uploadOk) {
                        console.log(`[可灵] ⚠ 图片${i + 1}上传确认超时，继续...`);
                    }
                    await _randomDelay(1000, 2000);
                }
            }
        }

        // 6. 填写提示词（自动为可灵添加 @图片N 引用头 + 正文中替换）
        task.message = '填写提示词...';
        task.progress = 32;
        let finalPrompt = videoPrompt;
        // 如果原始 prompt 不包含 @图片 引用，且有参考图上传，则自动生成引用头 + 替换正文
        if (referenceImages.length > 0 && !/@图片\d/.test(videoPrompt)) {
            const maxRefs = Math.min(referenceImages.length, 4);
            const refHeaders = [];
            const nameToRef = []; // { name, ref: "@图片N" }
            for (let i = 0; i < maxRefs; i++) {
                const ref = referenceImages[i];
                const label = ref.name || `参考${i + 1}`;
                const tag = `@图片${i + 1}`;
                refHeaders.push(`${tag}是${label}`);
                if (ref.name) nameToRef.push({ name: ref.name, tag });
            }
            // 正文中将角色/场景名替换为 @图片N（按名称长度降序，避免短名称误匹配）
            let bodyText = videoPrompt;
            nameToRef.sort((a, b) => b.name.length - a.name.length);
            for (const { name, tag } of nameToRef) {
                // 全局替换（但避免重复替换已有的 @图片N）
                bodyText = bodyText.split(name).join(tag);
            }
            finalPrompt = refHeaders.join('，') + '。' + bodyText;
            console.log(`[可灵] 自动添加引用: ${finalPrompt.slice(0, 120)}...`);
        }
        await _fillPrompt(page, finalPrompt);
        await _randomDelay(500, 1000);

        // 6.5-8.5 一次性配置所有生成参数（避免弹窗 toggle 问题）
        // 分辨率: 优先使用 params.resolution，其次从模型配置中获取
        const modelConfig = CONFIG.models[modelKey];
        const resolutionMode = params.resolution || params.resolutionMode || (modelConfig && modelConfig.resolution) || null;
        const genCount = params.generationCount || 1;
        task.message = '配置生成参数...';
        task.progress = 35;
        await _configureAllSettings(page, {
            mode: resolutionMode,
            ratio: aspectRatio || null,
            duration: duration || null,
            count: genCount
        });
        await _randomDelay(500, 1000);

        // 9. 安装网络拦截器
        task.message = '准备提交...';
        task.progress = 39;
        const interceptor = _setupNetworkInterceptor(page);

        // 10. 点击生成按钮
        task.message = '提交生成任务...';
        task.progress = 40;
        await _clickGenerateButton(page);

        // 11. 等待捕获 task_id
        task.message = '等待任务创建...';
        task.progress = 42;
        const waitStart = Date.now();
        for (let i = 0; i < 30; i++) {
            if (interceptor.getTaskId()) break;
            // 检查错误提示
            if (i > 0 && i % 4 === 0) {
                const toastError = await _detectErrorToast(page);
                if (toastError) {
                    interceptor.lockTaskId();
                    interceptor.cleanup();
                    task.status = 'failed';
                    task.error = toastError;
                    task.message = `生成失败: ${toastError}`;
                    return null;
                }
            }
            await new Promise(r => setTimeout(r, 500));
        }

        const remoteTaskId = interceptor.getTaskId();
        interceptor.lockTaskId();
        if (remoteTaskId) {
            _traceLog(`[可灵] ✅ task_id 已捕获: ${remoteTaskId} (耗时${Date.now() - waitStart}ms)`);
            task.remoteTaskId = remoteTaskId;
        } else {
            _traceLog(`[可灵] ❌ task_id 捕获失败，将使用 DOM 轮询`);
        }

        // 冻结页面 JS
        await page.evaluate(() => window.stop()).catch(() => {});

        task.status = 'processing';
        task.message = '任务已提交，等待生成...';
        task.progress = 45;

        return { page, interceptor };

    } catch (error) {
        console.error(`[可灵] 提交阶段失败:`, error.message);
        task.status = 'failed';
        task.error = error.message;
        task.message = '任务提交失败: ' + error.message;
        return null;
    }
}

async function _executePollPhase(taskId, page, interceptor) {
    try {
        console.log(`[可灵] 轮询阶段开始: ${taskId}`);
        await _waitForCompletion(taskId, page, interceptor);
    } finally {
        interceptor.cleanup();
        console.log(`[可灵] 轮询阶段结束: ${taskId}`);
    }
}

// ==================== 页面操作 ====================

async function _selectModel(page, modelKey) {
    const config = CONFIG.models[modelKey];
    if (!config) {
        console.log(`[可灵] 未知模型: ${modelKey}，跳过选择`);
        return;
    }
    const targetText = config.clickText;
    console.log(`[可灵] 选择模型: ${targetText}`);

    try {
        // 可灵 Omni 页面：模型通过 .model-type-select (Element Plus Dropdown) 选择
        // 先检查当前模型是否已匹配
        const currentModel = await page.evaluate(() => {
            const ms = document.querySelector('.model-type-select');
            return ms ? ms.textContent.trim() : '';
        });

        if (currentModel.includes(targetText)) {
            console.log(`[可灵] 模型已是: ${currentModel}，无需切换`);
            return;
        }

        // 点击 .model-type-select 展开下拉
        await page.click('.model-type-select');
        await _randomDelay(500, 800);

        // 在弹出的 el-dropdown-menu 中点击目标模型
        const clicked = await page.evaluate((text) => {
            // Element Plus dropdown menu items
            const items = document.querySelectorAll('.el-dropdown-menu__item, .el-dropdown-menu li, .kling-dropdown li');
            for (const item of items) {
                const t = (item.textContent || '').trim();
                if (t.includes(text)) {
                    item.click();
                    return true;
                }
            }
            return false;
        }, targetText);

        if (clicked) {
            console.log(`[可灵] 模型已选择: ${targetText}`);
        } else {
            console.log(`[可灵] 未找到模型选项: ${targetText}（当前: ${currentModel}）`);
            // 点击空白处关闭下拉
            await page.click('body');
        }
    } catch (e) {
        console.log(`[可灵] 模型选择失败: ${e.message}`);
    }
}

async function _fillPrompt(page, prompt) {
    if (!prompt) return;
    console.log(`[可灵] 填写提示词: ${prompt.substring(0, 60)}...`);

    try {
        // 可灵 Omni 使用 TipTap ProseMirror 富文本编辑器
        // 策略（经实测验证）：
        // 1. 上传图片后编辑器会自动出现 @图片N 引用 → 必须全部清除
        // 2. 清空后用真实 @mention 系统引用：输入@ → .mention-list → 选择 → Enter
        // 3. prompt 中 @图片N 会被解析为 mention 指令

        const editor = await page.$('.tiptap.ProseMirror');
        if (!editor) {
            console.log('[可灵] 未找到 ProseMirror 编辑器');
            return;
        }

        // 1. 清空编辑器（删除自动出现的@图片引用和所有内容）
        await editor.click();
        await _randomDelay(200, 300);
        const isMac = process.platform === 'darwin';
        const modKey = isMac ? 'Meta' : 'Control';
        await page.keyboard.down(modKey);
        await page.keyboard.press('a');
        await page.keyboard.up(modKey);
        await _randomDelay(50, 100);
        await page.keyboard.press('Backspace');
        await _randomDelay(300, 500);

        // 再检查一次，如果有残留再清
        const remaining = await page.evaluate(() => {
            const ed = document.querySelector('.tiptap.ProseMirror');
            return ed ? ed.textContent.trim().length : 0;
        });
        if (remaining > 0) {
            await page.keyboard.down(modKey);
            await page.keyboard.press('a');
            await page.keyboard.up(modKey);
            await page.keyboard.press('Backspace');
            await _randomDelay(200, 300);
        }
        console.log('[可灵] 编辑器已清空');

        // 2. 解析 prompt 中的 @图片N 引用，分段输入
        // 将 "@图片1在 @图片2床上醒来" 拆分为:
        //   [mention:1] [text:"在 "] [mention:2] [text:"床上醒来"]
        const segments = _parsePromptSegments(prompt);
        console.log(`[可灵] 提示词分段: ${segments.length} 段`);

        for (const seg of segments) {
            if (seg.type === 'text') {
                await page.keyboard.type(seg.content, { delay: 15 });
                await _randomDelay(100, 200);
            } else if (seg.type === 'mention') {
                // 输入 @ → 等待 .mention-list → 导航到目标 → Enter
                console.log(`[可灵] @mention: 图片${seg.imageIndex}`);
                await page.keyboard.type('@', { delay: 0 });
                await _randomDelay(500, 800);

                // 等待 .mention-list 出现
                let listFound = false;
                for (let w = 0; w < 10; w++) {
                    listFound = await page.evaluate(() => !!document.querySelector('.mention-list'));
                    if (listFound) break;
                    await new Promise(r => setTimeout(r, 300));
                }

                if (listFound) {
                    // 导航到目标: 图片1=index 0, 图片2=index 1, ...
                    const targetIdx = seg.imageIndex - 1;
                    for (let n = 0; n < targetIdx; n++) {
                        await page.keyboard.press('ArrowDown');
                        await _randomDelay(100, 200);
                    }
                    await page.keyboard.press('Enter');
                    await _randomDelay(300, 500);
                    console.log(`[可灵] @图片${seg.imageIndex} 已插入`);
                } else {
                    console.log(`[可灵] ⚠ .mention-list 未出现，回退输入文本`);
                    await page.keyboard.type(`图片${seg.imageIndex}`, { delay: 15 });
                }
            }
        }

        // 验证
        const finalTags = await page.evaluate(() => {
            const ed = document.querySelector('.tiptap.ProseMirror');
            return ed ? ed.querySelectorAll('.media-tag-wrapper').length : 0;
        });
        const finalText = await page.evaluate(() => {
            const ed = document.querySelector('.tiptap.ProseMirror');
            return ed ? ed.textContent.trim() : '';
        });
        console.log(`[可灵] 提示词已填写: ${finalTags} 个@标签, 文本: "${finalText.slice(0, 80)}"`);
    } catch (e) {
        console.error(`[可灵] 填写提示词失败:`, e.message);
    }
}

/**
 * 解析提示词中的 @图片N 引用，返回分段数组
 * "@图片1在 @图片2床上醒来" → [{mention:1}, {text:"在 "}, {mention:2}, {text:"床上醒来"}]
 */
function _parsePromptSegments(prompt) {
    const segments = [];
    const regex = /@图片(\d+)/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(prompt)) !== null) {
        // 前面的文本
        if (match.index > lastIndex) {
            segments.push({ type: 'text', content: prompt.slice(lastIndex, match.index) });
        }
        // @mention
        segments.push({ type: 'mention', imageIndex: parseInt(match[1], 10) });
        lastIndex = regex.lastIndex;
    }
    // 剩余文本
    if (lastIndex < prompt.length) {
        segments.push({ type: 'text', content: prompt.slice(lastIndex) });
    }
    // 如果没有任何 @引用，整体作为文本
    if (segments.length === 0) {
        segments.push({ type: 'text', content: prompt });
    }
    return segments;
}

async function _typeTextInChunks(page, text, charDelay = 10, chunkSize = 200) {
    for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.slice(i, i + chunkSize);
        await page.keyboard.type(chunk, { delay: charDelay });
        await _randomDelay(50, 150);
    }
}

async function _uploadReferenceImage(page, imagePath) {
    console.log(`[可灵] 上传参考图: ${imagePath}`);
    try {
        // 可灵 Omni 页面有两个 el-upload__input：
        // 1. accept=".jpg,.jpeg,.png" → 图片上传
        // 2. accept=".mp4,.mov" → 视频上传
        // 用 accept 属性区分
        const imageInput = await page.$('input.el-upload__input[accept*="jpg"]');
        if (imageInput) {
            await imageInput.uploadFile(imagePath);
            console.log(`[可灵] 图片已通过 el-upload 上传`);
            await _randomDelay(2000, 3000);
            return true;
        }

        // 备选：点击素材池上传区域触发
        console.log('[可灵] 未找到图片 file input，尝试点击上传区域');
        const uploadArea = await page.$('.omni-material-pool__material-select-section, [class*="upload"]');
        if (uploadArea) {
            await uploadArea.click();
            await _randomDelay(800, 1200);
            const fi = await page.$('input.el-upload__input[accept*="jpg"], input[type="file"][accept*="jpg"]');
            if (fi) {
                await fi.uploadFile(imagePath);
                await _randomDelay(2000, 3000);
                return true;
            }
        }

        // 最后备选：任何 file input
        const anyInput = await page.$('input[type="file"]');
        if (anyInput) {
            await anyInput.uploadFile(imagePath);
            await _randomDelay(2000, 3000);
            return true;
        }

        console.log('[可灵] 未能找到图片上传入口');
        return false;
    } catch (e) {
        console.error(`[可灵] 图片上传失败:`, e.message);
        return false;
    }
}

async function _ensureLocalImage(imageUrl) {
    if (!imageUrl) return null;
    // 本地文件
    if (fs.existsSync(imageUrl)) return imageUrl;
    // base64
    if (imageUrl.startsWith('data:image/')) return _base64ToTempFile(imageUrl);
    // 本地服务器路径
    if (imageUrl.startsWith('/images/') || imageUrl.startsWith('/output/')) {
        const localPath = path.join(DATA_DIR, imageUrl);
        if (fs.existsSync(localPath)) return localPath;
    }
    // Windows 绝对路径
    if (/^[A-Z]:\\/i.test(imageUrl) && fs.existsSync(imageUrl)) return imageUrl;
    // 远程 URL → 下载到临时文件
    if (imageUrl.startsWith('http')) return _downloadToTempFile(imageUrl);
    return null;
}

function _base64ToTempFile(dataUrl) {
    try {
        const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) return null;
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const buf = Buffer.from(match[2], 'base64');
        const tmpPath = path.join(os.tmpdir(), `kling_ref_${Date.now()}.${ext}`);
        fs.writeFileSync(tmpPath, buf);
        return tmpPath;
    } catch { return null; }
}

function _downloadToTempFile(url) {
    return new Promise((resolve) => {
        const ext = path.extname(new URL(url).pathname).toLowerCase() || '.png';
        const tmpPath = path.join(os.tmpdir(), `kling_ref_${Date.now()}${ext}`);
        const client = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(tmpPath);
        client.get(url, (response) => {
            if (response.statusCode !== 200) { file.close(); resolve(null); return; }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(tmpPath); });
        }).on('error', () => { file.close(); resolve(null); });
    });
}

/**
 * 一次性配置所有生成参数（只开关一次弹窗，避免 toggle 状态不一致）
 * @param {object} page - puppeteer page
 * @param {object} opts - { mode, ratio, duration, count }
 *   mode: "720p"|"1080p", ratio: "16:9"|"9:16"|"1:1"|"auto", duration: 3-15, count: 1-4
 */
async function _configureAllSettings(page, opts = {}) {
    const { mode, ratio, duration, count = 1 } = opts;
    console.log(`[可灵] 配置参数: mode=${mode||'不变'}, ratio=${ratio||'不变'}, duration=${duration||'不变'}, count=${count}`);

    try {
        // 辅助函数：检查弹窗是否可见（display !== none）
        const isPopoverVisible = () => page.evaluate(() => {
            const pop = document.querySelector('.omni-setting-popover');
            return pop ? window.getComputedStyle(pop).display !== 'none' : false;
        });

        // 1. 确保弹窗打开
        if (await isPopoverVisible()) {
            console.log('[可灵] 弹窗已打开，直接设置');
        } else {
            await page.click('.setting-select');
            await _randomDelay(800, 1200);
        }

        // 验证弹窗已打开
        if (!(await isPopoverVisible())) {
            console.log('[可灵] ⚠ 弹窗未打开，重试...');
            await page.click('.setting-select');
            await _randomDelay(800, 1200);
        }

        // 2. 设置生成模式
        if (mode) {
            const modeKey = mode === '720p' ? 'std' : (mode === '1080p' ? 'pro' : mode);
            const modeResult = await page.evaluate((key) => {
                const el = document.querySelector(`.option-tab-item.model_mode_${key}`);
                if (!el) return 'not-found';
                if (el.classList.contains('active')) return 'already-active';
                el.click();
                return 'clicked';
            }, modeKey);
            console.log(`[可灵]   模式 ${mode}: ${modeResult}`);
            await _randomDelay(200, 400);
        }

        // 3. 设置时长
        if (duration) {
            const durNum = parseInt(duration) || 3;
            const durResult = await page.evaluate((num) => {
                const el = document.querySelector(`.option-tab-item.duration_${num}`);
                if (!el) return 'not-found';
                if (el.classList.contains('active')) return 'already-active';
                el.click();
                return 'clicked';
            }, durNum);
            console.log(`[可灵]   时长 ${durNum}s: ${durResult}`);
            await _randomDelay(200, 400);
        }

        // 4. 设置画幅
        if (ratio) {
            const ratioResult = await page.evaluate((targetRatio) => {
                // 遍历所有 aspect_ratio 元素，用 className 包含判断
                const items = document.querySelectorAll('.option-tab-item');
                for (const item of items) {
                    const cls = item.className;
                    if (!cls.includes('aspect_ratio_')) continue;
                    // 比对文本（最可靠）
                    if (item.textContent.trim() === targetRatio) {
                        if (item.classList.contains('active')) return 'already-active';
                        if (item.classList.contains('disabled')) return 'disabled';
                        item.click();
                        return 'clicked';
                    }
                }
                return 'not-found';
            }, ratio);
            console.log(`[可灵]   画幅 ${ratio}: ${ratioResult}`);
            await _randomDelay(200, 400);
        }

        // 5. 设置生成数量（最关键 - 默认强制 1）
        const countNum = Math.max(1, Math.min(4, parseInt(count) || 1));
        const countResult = await page.evaluate((num) => {
            const el = document.querySelector(`.option-tab-item.imageCount_${num}`);
            if (!el) return 'not-found';
            if (el.classList.contains('active')) return 'already-active';
            el.click();
            return 'clicked';
        }, countNum);
        console.log(`[可灵]   数量 ${countNum}: ${countResult}`);
        await _randomDelay(200, 400);

        // 6. 验证所有设置生效
        const verify = await page.evaluate((opts) => {
            const result = {};
            // 验证数量
            const countEl = document.querySelector(`.option-tab-item.imageCount_${opts.count}`);
            result.countOk = countEl ? countEl.classList.contains('active') : false;
            // 验证模式
            if (opts.modeKey) {
                const modeEl = document.querySelector(`.option-tab-item.model_mode_${opts.modeKey}`);
                result.modeOk = modeEl ? modeEl.classList.contains('active') : false;
            }
            // 验证时长
            if (opts.durNum) {
                const durEl = document.querySelector(`.option-tab-item.duration_${opts.durNum}`);
                result.durOk = durEl ? durEl.classList.contains('active') : false;
            }
            // 验证画幅
            if (opts.ratio) {
                const items = document.querySelectorAll('.option-tab-item');
                for (const item of items) {
                    if (item.className.includes('aspect_ratio_') && item.textContent.trim() === opts.ratio) {
                        result.ratioOk = item.classList.contains('active');
                        break;
                    }
                }
            }
            return result;
        }, {
            count: countNum,
            modeKey: mode ? (mode === '720p' ? 'std' : 'pro') : null,
            durNum: duration ? parseInt(duration) : null,
            ratio: ratio || null
        });
        console.log(`[可灵]   验证: ${JSON.stringify(verify)}`);

        if (!verify.countOk) {
            console.log('[可灵] ⚠ 数量验证失败，用 page.click 重试...');
            await page.click(`.option-tab-item.imageCount_${countNum}`).catch(() => {});
            await _randomDelay(300, 500);
        }

        // 7. 关闭弹窗（通过 toggle）
        await page.click('.setting-select');
        await _randomDelay(500, 800);

        // 确认弹窗已关闭
        const isPopoverVisibleFn = () => page.evaluate(() => {
            const pop = document.querySelector('.omni-setting-popover');
            return pop ? window.getComputedStyle(pop).display !== 'none' : false;
        });
        if (await isPopoverVisibleFn()) {
            console.log('[可灵] ⚠ 弹窗未关闭，再次 toggle...');
            await page.click('.setting-select');
            await _randomDelay(500, 800);
        }

        console.log('[可灵] 参数配置完成 ✅');
    } catch (e) {
        console.log(`[可灵] 参数配置失败: ${e.message}`);
        // 尝试关闭弹窗
        await page.click('.setting-select').catch(() => {});
    }
}

async function _clickGenerateButton(page) {
    console.log('[可灵] 查找生成按钮...');

    try {
        // 确保设置弹窗已关闭（可能遮挡按钮）
        const popoverVisible = await page.evaluate(() => {
            const pop = document.querySelector('.omni-setting-popover');
            return pop ? window.getComputedStyle(pop).display !== 'none' : false;
        });
        if (popoverVisible) {
            console.log('[可灵] ⚠ 设置弹窗仍打开，先关闭...');
            await page.click('.setting-select');
            await _randomDelay(500, 800);
        }

        // 等待按钮可用
        await page.waitForFunction(() => {
            const b = document.querySelector('button.generic-button.critical.big');
            return b && !b.disabled && b.offsetParent !== null;
        }, { timeout: 15000 });
        await _randomDelay(500, 800);

        // 用 page.evaluate 内部点击（经验证更可靠）
        const clickResult = await page.evaluate(() => {
            const btn = document.querySelector('button.generic-button.critical.big');
            if (!btn) return 'not-found';
            if (btn.disabled) return 'disabled';
            // 滚动到可见区域
            btn.scrollIntoView({ block: 'center' });
            btn.focus();
            btn.click();
            return `clicked:${btn.textContent.trim().slice(0, 20)}`;
        });
        console.log(`[可灵] 生成按钮: ${clickResult}`);

        if (clickResult === 'not-found' || clickResult === 'disabled') {
            // 备选：通过文本查找
            const clicked = await page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                for (const b of buttons) {
                    const t = (b.textContent || '').trim();
                    if (t.includes('生成') && !b.disabled && b.offsetParent !== null) {
                        b.scrollIntoView({ block: 'center' });
                        b.focus();
                        b.click();
                        return t;
                    }
                }
                return null;
            });
            if (clicked) {
                console.log(`[可灵] 生成按钮已点击（文本匹配: "${clicked}"）`);
            } else {
                throw new Error('未找到可用的生成按钮');
            }
        }
    } catch (e) {
        console.error(`[可灵] 点击生成按钮失败:`, e.message);
        throw e;
    }
}

async function _detectErrorToast(page) {
    return page.evaluate(() => {
        const FAIL_KEYWORDS = ['失败', '违规', '不合规', '审核', '余额不足', '积分不足', '次数用完', '请登录', '服务繁忙', '内容不合规', '频率过高'];
        // Element Plus: el-message, el-notification, el-message-box
        const selectors = [
            '.el-message--error', '.el-message--warning', '.el-notification',
            '[class*="toast"]', '[class*="Toast"]', '[class*="message"]',
            '[class*="notice"]', '[role="alert"]', '[class*="error"]',
            '.el-message-box', '.el-alert'
        ];
        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const txt = (el.innerText || '').trim();
                if (txt && FAIL_KEYWORDS.some(kw => txt.includes(kw))) return txt.substring(0, 100);
            }
        }
        return null;
    }).catch(() => null);
}

// ==================== 完成等待 ====================

async function _waitForCompletion(taskId, page, interceptor) {
    const task = taskStore[taskId];
    const startTime = Date.now();

    while (Date.now() - startTime < CONFIG.taskTimeout) {
        if (task.status === 'failed' || task.status === 'completed') return;

        // 优先从网络拦截器获取
        const networkVideoUrl = interceptor.getVideoUrl();
        if (networkVideoUrl) {
            await _handleVideoFound(task, taskId, page, networkVideoUrl);
            return;
        }

        // 检查拦截器捕获的失败
        const networkFailure = interceptor.getFailure();
        if (networkFailure) {
            task.status = 'failed';
            task.error = networkFailure;
            task.message = `生成失败: ${networkFailure}`;
            return;
        }

        // DOM 轮询：在页面中查找视频元素
        const elapsed = Date.now() - startTime;
        const elapsedMin = Math.floor(elapsed / 60000);
        task.message = `等待生成完成... (${elapsedMin}分钟)`;
        task.progress = Math.min(45 + Math.floor(elapsed / CONFIG.taskTimeout * 50), 95);

        try {
            // 刷新页面以触发状态查询请求（可灵可能自动轮询）
            // 每30秒检查一次DOM中是否出现视频
            const domVideoUrl = await page.evaluate(() => {
                // 查找视频播放器
                const videos = document.querySelectorAll('video');
                for (const v of videos) {
                    const src = v.src || v.querySelector('source')?.src;
                    if (src && (src.includes('.mp4') || src.includes('video') || src.startsWith('blob:'))) {
                        return src;
                    }
                }
                // 查找下载链接
                const links = document.querySelectorAll('a[download], a[href*="video"], a[href*=".mp4"]');
                for (const a of links) {
                    if (a.href && (a.href.includes('.mp4') || a.href.includes('video'))) return a.href;
                }
                return null;
            }).catch(() => null);

            if (domVideoUrl && !_claimedVideoUrls.has(domVideoUrl)) {
                console.log(`[可灵] DOM中发现视频: ${_sanitizeUrlForLog(domVideoUrl)}`);
                await _handleVideoFound(task, taskId, page, domVideoUrl);
                return;
            }

            // 检查页面是否显示生成失败
            const pageError = await page.evaluate(() => {
                const FAIL_TEXTS = ['生成失败', '任务失败', '内容违规', '审核未通过'];
                const allText = document.body?.innerText || '';
                for (const ft of FAIL_TEXTS) {
                    if (allText.includes(ft)) return ft;
                }
                return null;
            }).catch(() => null);

            if (pageError) {
                task.status = 'failed';
                task.error = pageError;
                task.message = `生成失败: ${pageError}`;
                return;
            }
        } catch (_) {}

        await new Promise(r => setTimeout(r, CONFIG.pollInterval));
    }

    // 超时
    task.status = 'failed';
    task.error = '生成超时';
    task.message = '生成超时（已等待最大时限）';
}

async function _handleVideoFound(task, taskId, page, videoUrl) {
    _traceLog(`[可灵] 任务完成: ${taskId}, URL: ${_sanitizeUrlForLog(videoUrl)}`);
    _claimedVideoUrls.add(videoUrl);
    task.message = '正在下载视频到本地...';
    task.progress = 96;

    try {
        const localPath = await _downloadVideoToLocal(page, videoUrl, taskId);
        task.localVideoPath = localPath;
        task.videoUrl = localPath;
        console.log(`[可灵] 视频已下载: ${localPath}`);
    } catch (dlErr) {
        console.error(`[可灵] 视频下载失败，使用远程URL:`, dlErr.message);
        task.videoUrl = videoUrl;
    }

    task.status = 'completed';
    task.message = '视频生成完成！';
    task.progress = 100;
    await saveCookies();
}

// ==================== 视频下载 ====================

async function _downloadVideoToLocal(page, videoUrl, taskId) {
    const task = taskStore[taskId];
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const pName = task && task.projectName ? task.projectName : '';
    const pPath = task && task.projectPath ? task.projectPath : '';
    const sIdx = task && task.shotIndex >= 0 ? task.shotIndex : -1;

    let outputDir;
    let filename;
    if (pPath && pName && sIdx >= 0) {
        outputDir = path.join(pPath, '05_generation', 'videos');
        filename = `${pName}_分镜${sIdx + 1}_${ts}.mp4`;
    } else {
        outputDir = path.join(DATA_DIR, 'images');
        filename = `video_${taskId}_${Date.now()}.mp4`;
    }
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, filename);

    // blob: URL → 在浏览器中提取
    if (videoUrl.startsWith('blob:')) {
        console.log('[可灵] 检测到 blob: URL，在页面中提取...');
        const base64Data = await page.evaluate(async (url) => {
            try {
                const resp = await fetch(url);
                const blob = await resp.blob();
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            } catch { return null; }
        }, videoUrl);

        if (!base64Data) throw new Error('无法从 blob URL 提取视频数据');
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(outputPath, buffer);
        console.log(`[可灵] blob视频已保存: ${outputPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
        return outputPath;
    }

    // m3u8
    if (videoUrl.toLowerCase().includes('.m3u8')) {
        const mp4Path = await _remuxM3u8ToMp4(videoUrl, outputPath);
        if (mp4Path) return mp4Path;
        const m3u8File = path.join(outputDir, `video_${taskId}_${Date.now()}.m3u8.txt`);
        fs.writeFileSync(m3u8File, videoUrl, 'utf-8');
        return m3u8File;
    }

    // HTTP/HTTPS → 直接下载
    if (videoUrl.startsWith('http')) {
        return new Promise((resolve, reject) => {
            const client = videoUrl.startsWith('https') ? https : http;
            const file = fs.createWriteStream(outputPath);
            client.get(videoUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://app.klingai.com/',
                },
            }, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    file.close();
                    try { fs.unlinkSync(outputPath); } catch (_) {}
                    response.resume();
                    _downloadVideoToLocal(page, response.headers.location, taskId).then(resolve).catch(reject);
                    return;
                }
                if (response.statusCode !== 200) { file.close(); response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    const size = fs.statSync(outputPath).size;
                    console.log(`[可灵] 视频已下载: ${outputPath} (${(size / 1024 / 1024).toFixed(1)}MB)`);
                    resolve(outputPath);
                });
            }).on('error', (err) => {
                try { fs.unlinkSync(outputPath); } catch (_) {}
                reject(err);
            });
        });
    }

    throw new Error(`不支持的视频URL格式: ${videoUrl.substring(0, 30)}`);
}

function _findFfmpeg() {
    if (os.platform() === 'win32') {
        const extraFfmpeg = path.join(__dirname, '..', 'resources', 'ffmpeg.exe');
        if (fs.existsSync(extraFfmpeg)) return extraFfmpeg;
        const appDataFfmpeg = path.join(DATA_DIR, 'ffmpeg.exe');
        if (fs.existsSync(appDataFfmpeg)) return appDataFfmpeg;
    }
    try {
        const { execSync } = require('child_process');
        execSync('ffmpeg -version', { stdio: 'ignore' });
        return 'ffmpeg';
    } catch { return null; }
}

async function _remuxM3u8ToMp4(m3u8Url, outputPath) {
    const ffmpeg = _findFfmpeg();
    if (!ffmpeg) {
        console.log('[可灵] ffmpeg 未找到，无法转换 m3u8');
        return null;
    }

    return new Promise((resolve) => {
        const args = ['-i', m3u8Url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-y', outputPath];
        const proc = spawn(ffmpeg, args, { timeout: 300000, stdio: 'pipe' });
        let stderr = '';
        proc.stderr.on('data', d => stderr += d.toString().slice(-500));
        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                console.log(`[可灵] m3u8 转换完成: ${outputPath}`);
                resolve(outputPath);
            } else {
                console.log(`[可灵] m3u8 转换失败 (code=${code})`);
                resolve(null);
            }
        });
        proc.on('error', () => resolve(null));
    });
}

// ==================== 工具函数 ====================

function _randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(r => setTimeout(r, delay));
}

// ==================== 任务查询/取消 ====================

function getTaskStatus(taskId) {
    const task = taskStore[taskId];
    if (!task) return { status: 'unknown', error: '任务不存在' };

    if ((task.status === 'completed' || task.status === 'failed') &&
        Date.now() - task.createdAt > 10 * 3600000) {
        delete taskStore[taskId];
    }

    return {
        status: task.status,
        progress: task.progress,
        message: task.message,
        videoUrl: task.videoUrl,
        error: task.error,
    };
}

function cancelTask(taskId) {
    const task = taskStore[taskId];
    if (!task) return { ok: false, error: '任务不存在' };
    if (task.status === 'completed' || task.status === 'failed') return { ok: true, message: '任务已结束' };

    const qIdx = taskQueue.findIndex(q => q.taskId === taskId);
    if (qIdx >= 0) taskQueue.splice(qIdx, 1);
    const videoIdx = videoTaskQueue.findIndex(q => q.taskId === taskId);
    if (videoIdx >= 0) videoTaskQueue.splice(videoIdx, 1);

    task.status = 'failed';
    task.error = '已取消';
    task.message = '已取消';

    const entry = activeVideoTaskPages.get(taskId);
    if (entry) _closeVideoTaskPage(taskId, entry.page).catch(() => {});

    return { ok: true, message: '已取消' };
}

// ==================== 浏览器关闭 ====================

async function closeBrowser(accountId) {
    const acct = _getAccount(accountId);
    try {
        if (acct.browser) {
            acct.browser.disconnect();
            acct.browser = null;
            acct.mainPage = null;
        }
    } catch (_) {}
}

async function killChrome(accountId) {
    const acct = _getAccount(accountId);
    try {
        if (acct.chromeProcess) {
            acct.chromeProcess.kill('SIGTERM');
            acct.chromeProcess = null;
        }
        if (acct.browser) {
            try { await acct.browser.close(); } catch {}
            acct.browser = null;
            acct.mainPage = null;
        }
    } catch (_) {}
}

// ==================== 账号管理 ====================

function addAccount(accountId, name) {
    if (_accounts.has(accountId)) return { ok: false, error: '账号ID已存在' };
    const existingPorts = [..._accounts.values()].map(a => a.cdpPort);
    let newPort = CONFIG.cdpPort + 1;
    while (existingPorts.includes(newPort)) newPort++;
    _accounts.set(accountId, _createAccountState(accountId, newPort, name || accountId));
    _saveAccountsToConfig();
    return { ok: true, account: { id: accountId, name: name || accountId, cdpPort: newPort } };
}

async function removeAccount(accountId) {
    if (accountId === 'default') return { ok: false, error: '不能删除默认账号' };
    const acct = _accounts.get(accountId);
    if (!acct) return { ok: false, error: '账号不存在' };
    await killChrome(accountId);
    _accounts.delete(accountId);
    _saveAccountsToConfig();
    return { ok: true };
}

function getAccountList() {
    return [..._accounts.values()].map(a => ({
        id: a.id,
        name: a.name,
        cdpPort: a.cdpPort,
        connected: !!(a.browser && a.browser.isConnected()),
        activeTasks: a.activeTaskCount,
    }));
}

async function initAllBrowsers() {
    const results = [];
    for (const acct of _accounts.values()) {
        try {
            await initBrowser(acct.id);
            results.push({ id: acct.id, name: acct.name, ok: true });
        } catch (e) {
            results.push({ id: acct.id, name: acct.name, ok: false, error: e.message });
        }
    }
    return results;
}

function _saveAccountsToConfig() {
    try {
        const cfgPath = path.join(
            process.env.APPDATA || path.join(os.homedir(), '.config'),
            'video-workflow', 'config.json'
        );
        let cfg = {};
        if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        cfg.klingAccounts = [..._accounts.values()]
            .filter(a => a.id !== 'default')
            .map(a => ({ id: a.id, name: a.name, cdpPort: a.cdpPort }));
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
    } catch (e) {
        console.log('[可灵] 保存账号配置失败:', e.message);
    }
}

// ==================== 导出 ====================

module.exports = {
    initBrowser,
    checkLoginStatus,
    openLoginPage,
    submitVideoTask,
    getTaskStatus,
    cancelTask,
    closeBrowser,
    killChrome,
    saveCookies,
    addAccount,
    removeAccount,
    getAccountList,
    initAllBrowsers,
    CONFIG,
};
