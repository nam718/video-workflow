/**
 * 即梦Web视频生成服务（内置版）
 * 
 * 通过 puppeteer 控制内置 Chromium 浏览器访问 jimeng.jianying.com
 * 实现自动化视频生成（文生视频 / 图生视频）
 */

const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

// ==================== 配置 ====================

// 可写数据目录（打包后 APP_USER_DATA 由 Electron main.js 设置；开发模式用项目根目录）
const DATA_DIR = process.env.APP_USER_DATA || path.join(__dirname, '..');

// 关键事件文件日志（用于诊断 submit_id 捕获和视频匹配问题）
const _LOG_FILE = path.join(DATA_DIR, 'jimeng_trace.log');
function _traceLog(msg) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    try { fs.appendFileSync(_LOG_FILE, `[${ts}] ${msg}\n`); } catch (_) {}
    console.log(msg);
}

const CONFIG = {
    // Chrome 可执行文件路径（自动检测）
    chromePath: findChromePath(),
    // 用户数据目录（保存Cookie和登录状态）— 存在用户配置目录下，兼容打包后路径
    userDataDir: path.join(
        process.env.APPDATA || path.join(os.homedir(), '.config'),
        'video-workflow',
        '.jimeng_profile'
    ),

    // ===== URL 配置（从 .pyd: JIMENG_BASE_URL / JIMENG_GENERATE_URL / JIMENG_LOGIN_URL）=====
    baseUrl: 'https://jimeng.jianying.com',
    createUrl: 'https://jimeng.jianying.com/ai-tool/home?type=video',  // .pyd: type=video 直接进入视频模式
    generateUrl: 'https://jimeng.jianying.com/ai-tool/generate',       // .pyd: JIMENG_GENERATE_URL
    loginUrl: 'https://jimeng.jianying.com',                           // .pyd: JIMENG_LOGIN_URL

    // CDP 远程调试端口（与原始插件一致）
    cdpPort: 9222,

    // ===== 模式系统（从 .pyd 逆向的完整模式配置）=====
    // generation_mode: 'omni_reference' (全能参考) | 'first_end_frame' (首尾帧)
    generationMode: 'omni_reference',

    // 模型选择映射（.pyd: _model_value_map / _model_display_map / _model_click_map）
    // 底部栏 lv-select 中的模型选项
    models: {
        'seedance-2.0': { display: 'Seedance 2.0', clickText: 'Seedance 2.0' },
        'seedance-2.0-fast': { display: 'Seedance 2.0 Fast', clickText: 'Seedance 2.0 Fast' },
    },
    // 默认模型
    defaultModel: 'seedance-2.0',

    // ===== 图片生成配置 =====
    createImageUrl: 'https://jimeng.jianying.com/ai-tool/home?type=image',
    imageDefaultModel: '图片5.0lite',
    imageDefaultQuality: '高清2K',
    imageTaskTimeout: 180000, // 图片生成超时3分钟

    // 画幅比例选项（.pyd: aspect_ratio_options = '21:9,16:9,4:3,1:1,3:4,9:16'）
    aspectRatioOptions: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],

    // 时长选项（即梦实际支持 4s-15s）
    durationOptions: ['4s', '5s', '6s', '7s', '8s', '9s', '10s', '11s', '12s', '13s', '14s', '15s'],

    // 全能参考模式最大参考图数量（.pyd: OMNI_REF_MAX）
    omniRefMax: 9,

    // ===== 真实选择器（从 .pyd 二进制 + DOM扫描 综合获得）=====
    // 即梦使用字节跳动 Lark Design 组件库，class 前缀为 "lv-"
    selectors: {
        // 提示词输入框（DOM扫描确认）
        promptTextarea: 'textarea[class*="prompt-textarea"]',
        promptTextareaAlt: 'textarea[placeholder*="Seedance"]',
        promptContainer: '[class*="prompt-container"]',
        // 参考图上传 - file input（.pyd 确认使用 input[type=file] + set_input_files）
        fileInput: '[class*="reference-upload"] input[type="file"]',
        fileInputAlt: 'input[type="file"]',
        uploadArea: '[class*="reference-upload"]',
        // Lark Design 组件选择器（从 .pyd 提取）
        lvBtn: '.lv-btn',
        lvBtnSecondary: '.lv-btn-secondary',           // .pyd: cls.includes('lv-btn-secondary')
        lvBtnIconOnly: '.lv-btn-icon-only',             // .pyd: cls.includes('lv-btn-icon-only')
        lvBtnShapeSquare: '.lv-btn-shape-square',       // .pyd: cls.includes('lv-btn-shape-square')
        lvSelect: '[role="combobox"].lv-select, .lv-select',  // .pyd: 精确选择器
        lvSelectView: '.lv-select-view',
        lvSelectViewValue: '.lv-select-view-value',
        lvSelectViewSelector: '.lv-select-view-selector',
        // 工具栏按钮（.pyd 中的 toolbar-button-... 模式）
        toolbarButton: '[class*="toolbar-button"]',
        // "生成" 按钮区域（DOM扫描确认）
        generateText: '[class*="text-HLQFZY"]',
        generateContainer: '[class*="content-XAjJup"]',
        // 视频生成入口（首页卡片）
        videoEntryButton: 'button[class*="button-RNHVcx"]',
    },

    // 超时配置
    loginTimeout: 300000,   // 登录等待5分钟
    taskTimeout: 28800000,  // 任务超时8小时（覆盖排队5-6小时+生成时间）
    pollInterval: 5000,     // 轮询间隔5秒
    // Cookie备份文件
    cookieFile: path.join(
        process.env.APPDATA || path.join(os.homedir(), '.config'),
        'video-workflow',
        '.jimeng_profile',
        'cookies.json'
    ),
};

function findChromePath() {
    // 1. Windows: 优先使用打包内置的 Chrome (extraResources/chrome-win)
    if (os.platform() === 'win32') {
        const bundledPaths = [];
        if (process.resourcesPath) {
            bundledPaths.push(path.join(process.resourcesPath, 'chrome-win', 'chrome.exe'));
        }
        // 开发模式下的本地路径（动态查找版本目录）
        const devChromeBase = path.join(__dirname, '..', 'chrome-win', 'chrome');
        if (fs.existsSync(devChromeBase)) {
            try {
                const versions = fs.readdirSync(devChromeBase).filter(d => d.startsWith('win64-'));
                if (versions.length > 0) {
                    bundledPaths.push(path.join(devChromeBase, versions[0], 'chrome-win64', 'chrome.exe'));
                }
            } catch {}
        }
        for (const p of bundledPaths) {
            if (fs.existsSync(p)) {
                console.log('[即梦] 使用内置Chrome:', p);
                return p;
            }
        }
    }

    // 2. puppeteer-core 不自带浏览器，跳过此步

    const platform = os.platform();
    let possiblePaths;

    if (platform === 'darwin') {
        possiblePaths = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
        ];
    } else if (platform === 'linux') {
        possiblePaths = [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
        ];
    } else {
        // Windows: Chrome + Edge + 更多路径变体
        possiblePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            // Microsoft Edge (Chromium内核)
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ].filter(Boolean);
    }

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) return p;
    }
    // 不在模块加载时抛错，返回 null，延迟到启动时报错
    console.warn(`[即梦] 警告: 未找到Chrome/Edge，已检查: ${possiblePaths.join(', ')}`);
    return null;
}

// ==================== 多账号浏览器管理（CDP方式） ====================

// 存储任务状态（所有账号共享）
const taskStore = {};

// 图片任务队列（仍使用主账号主页面顺序执行）
const taskQueue = [];
let isProcessingQueue = false;

// 视频任务独立 page 池：跨多账号分发，每个任务绑定自己的 page
const videoTaskQueue = [];
const activeVideoTaskPages = new Map();
const MAX_CONCURRENT_PER_ACCOUNT = 9; // 每个账号最大并发标签页
let activeVideoTaskCount = 0;
let activePollingCount = 0;
let isSubmittingTask = false;
const _claimedVideoUrls = new Set();
const _pageReloadBaselineVideos = new Set();

// ==================== 账号注册表 ====================
// 每个即梦账号有独立的 Chrome 实例（独立CDP端口、用户配置目录、Cookie）
const _accounts = new Map(); // accountId -> AccountState

function _createAccountState(accountId, cdpPort, name) {
    const profileDir = accountId === 'default'
        ? CONFIG.userDataDir
        : path.join(path.dirname(CONFIG.userDataDir), `.jimeng_profile_${accountId}`);
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

// 初始化默认账号
_accounts.set('default', _createAccountState('default', CONFIG.cdpPort, '默认账号'));

// 从配置文件加载已注册的额外账号
function _loadAccountsFromConfig() {
    try {
        const cfgPath = path.join(
            process.env.APPDATA || path.join(os.homedir(), '.config'),
            'video-workflow', 'config.json'
        );
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            if (Array.isArray(cfg.jimengAccounts)) {
                cfg.jimengAccounts.forEach(acc => {
                    if (acc.id && acc.id !== 'default' && !_accounts.has(acc.id)) {
                        _accounts.set(acc.id, _createAccountState(acc.id, acc.cdpPort, acc.name));
                    }
                });
                console.log(`[即梦] 已加载 ${_accounts.size} 个账号`);
            }
        }
    } catch (e) {
        console.log('[即梦] 加载账号配置失败:', e.message);
    }
}
_loadAccountsFromConfig();

function _getAccount(accountId = 'default') {
    return _accounts.get(accountId) || _accounts.get('default');
}

// 兼容：获取默认账号的 browser/mainPage（供旧代码使用）
function _getDefaultBrowser() { return _getAccount('default').browser; }
function _getDefaultMainPage() { return _getAccount('default').mainPage; }

// ==================== 网络拦截层（从 .pyd 逆向） ====================
// 真实插件通过 page.on('response') 拦截 /aigc_draft/generate 的响应，
// 从中提取 submit_id，然后用 data-id 属性精确定位 DOM 卡片。
// 这比纯 DOM 扫描可靠得多。

/**
 * 判断 URL 是否为即梦的生成 API 端点
 * .pyd: _is_generate_endpoint
 */
function _isGenerateEndpoint(url) {
    return url.includes('/aigc_draft/generate') || url.includes('/mweb/v1/aigc_draft/generate');
}

/**
 * 判断 URL 是否为即梦的资源列表 API 端点
 */
function _isGetAssetListEndpoint(url) {
    return url.includes('/mweb/v1/get_asset_list') || url.includes('/get_asset_list');
}

/**
 * 判断 URL 是否像视频 URL
 * .pyd: _looks_like_video_url — 排除静态资源
 */
function _looksLikeVideoUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    // 排除页面锚点/fragment（如 #generate_video）
    if (lower.startsWith('#')) return false;
    // 必须以 http/https/blob 开头才是真实 URL
    if (!lower.startsWith('http') && !lower.startsWith('blob:')) return false;
    // 排除静态资源（.pyd 中明确排除的）
    if (lower.includes('vlabstatic.com') || lower.includes('/static/media/')) return false;
    // 必须包含视频特征
    return lower.includes('.mp4') || lower.includes('.m3u8') || lower.includes('video');
}

/**
 * 清理视频 URL 中的敏感 token 参数（用于日志）
 * .pyd: _sanitize_token / _strip_token
 */
function _sanitizeUrlForLog(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        for (const key of [...u.searchParams.keys()]) {
            if (key.toLowerCase().includes('token') || key.toLowerCase().includes('auth') || key.toLowerCase().includes('sign')) {
                u.searchParams.set(key, '***');
            }
        }
        return u.toString();
    } catch {
        return url.substring(0, 100) + '...';
    }
}

/**
 * 在页面上安装网络拦截器
 * .pyd: _on_response / _on_gen_request / _on_gen_response
 *
 * 监听所有网络响应，当检测到 /aigc_draft/generate 的响应时，
 * 从 JSON body 中提取 submit_id。
 *
 * @param {Page} page - Puppeteer 页面
 * @returns {Object} interceptor - { getSubmitId(), getVideoUrl(), cleanup() }
 */
function _setupNetworkInterceptor(page) {
    let capturedSubmitId = null;
    let capturedVideoUrl = null;
    let capturedAssetData = null;
    let capturedAssetFailure = null; // API 响应中检测到的失败原因
    let submitIdLocked = false; // 锁定后不再捕获新的 submit_id，防止跨任务污染
    let cachedApiProbe = null;  // 缓存 get_asset_list 请求详情，用于直接 API 探测

    const onResponse = async (response) => {
        try {
            const url = response.url();
            const status = response.status();
            if (status < 200 || status >= 300) return;

            // 拦截生成请求的响应 → 提取 submit_id
            // 注意：只捕获第一个 submit_id，捕获后锁定，避免被后续任务的 generate 响应覆盖
            if (_isGenerateEndpoint(url) && !capturedSubmitId && !submitIdLocked) {
                try {
                    // 记录请求体中的模型参数，用于诊断 UI 显示 vs 实际请求 差异
                    const reqBody = response.request().postData();
                    if (reqBody) {
                        const modelMatch = reqBody.match(/"model_req_key"\s*:\s*"([^"]+)"/);
                        const modeMatch = reqBody.match(/"generate_type"\s*:\s*"([^"]+)"/);
                        const seedanceMatch = reqBody.match(/"seedance[^"]*"/gi);
                        console.log(`[即梦] playwright: [generate-req] model_req_key=${modelMatch?.[1] || '?'}, generate_type=${modeMatch?.[1] || '?'}, seedance_refs=${JSON.stringify(seedanceMatch || [])}`);
                        // 也记录完整 body 的前500字符方便调试
                        console.log(`[即梦] playwright: [generate-req-body] ${reqBody.substring(0, 500)}`);
                    }
                    const json = await response.json();
                    // .pyd: "submit_id"\s*:\s*"([^"]+)"
                    const submitId = _deepFindSubmitId(json);
                    if (submitId) {
                        capturedSubmitId = submitId;
                        console.log(`[即梦] playwright: CAPTURED generate request submit_id=${submitId}`);
                    }
                } catch (e) {
                    // 响应可能不是 JSON
                    try {
                        const text = await response.text();
                        const match = text.match(/"submit_id"\s*:\s*"([^"]+)"/);
                        if (match) {
                            capturedSubmitId = match[1];
                            console.log(`[即梦] playwright: CAPTURED submit_id from text=${capturedSubmitId}`);
                        }
                    } catch (_) { /* ignore */ }
                }
            }

            // 拦截 get_asset_list 响应 → 提取视频 URL
            // 通过 capturedSubmitId 精确匹配自己任务的视频，不会和其他任务混淆
            if (_isGetAssetListEndpoint(url) && capturedSubmitId && !capturedVideoUrl) {
                try {
                    // 捕获请求详情用于后续直接 API 探测
                    if (!cachedApiProbe) {
                        const req = response.request();
                        cachedApiProbe = { url: req.url(), method: req.method(), postData: req.postData() || null };
                        console.log(`[即梦] playwright: [api-probe] captured: ${req.method()} ${req.url().substring(0, 80)}`);
                    }
                    const json = await response.json();
                    capturedAssetData = json;
                    const videoUrl = _scanTranscodedFromResponse(json, capturedSubmitId);
                    if (videoUrl) {
                        capturedVideoUrl = videoUrl;
                        console.log(`[即梦] playwright: [network] video url (submit_id=${capturedSubmitId}): ${_sanitizeUrlForLog(videoUrl)}`);
                    }
                    // 检测 API 响应中的失败状态
                    if (!capturedVideoUrl && !capturedAssetFailure) {
                        const failure = _scanFailureFromResponse(json, capturedSubmitId);
                        if (failure) {
                            capturedAssetFailure = failure;
                            console.log(`[即梦] playwright: [network] 检测到失败状态 (submit_id=${capturedSubmitId}): ${failure}`);
                        }
                    }
                } catch (_) { /* ignore */ }
            }
        } catch (e) {
            // response 可能已被销毁，忽略
        }
    };

    page.on('response', onResponse);
    console.log('[即梦] 网络拦截器已安装');

    return {
        getSubmitId: () => capturedSubmitId,
        getVideoUrl: () => capturedVideoUrl,
        getAssetData: () => capturedAssetData,
        getAssetFailure: () => capturedAssetFailure,
        getApiProbe: () => cachedApiProbe,
        // 锁定 submit_id：无论是否已捕获，都不再接受新的 generate 响应
        // 必须在提交阶段等待 submit_id 结束后调用，防止后续任务的 generate 响应污染此拦截器
        lockSubmitId: () => { submitIdLocked = true; },
        cleanup: () => {
            page.off('response', onResponse);
            console.log('[即梦] 网络拦截器已卸载');
        },
    };
}

/**
 * 从 JSON 对象中递归查找 submit_id
 * .pyd: _deep_find_submit_id
 */
function _deepFindSubmitId(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.submit_id) return obj.submit_id;
    if (obj.data && obj.data.submit_id) return obj.data.submit_id;
    // 递归搜索
    for (const key of Object.keys(obj)) {
        if (key === 'submit_id' && typeof obj[key] === 'string') return obj[key];
        if (typeof obj[key] === 'object') {
            const found = _deepFindSubmitId(obj[key]);
            if (found) return found;
        }
    }
    return null;
}

/**
 * 从 get_asset_list 响应中扫描 transcoded_video URL
 * .pyd: _scan_transcoded
 */
function _scanTranscodedFromResponse(json, submitId) {
    if (!json) return null;
    try {
        // 遍历 asset_list / data.asset_list / data.data.asset_list
        const assetList = json.asset_list || json.data?.asset_list || json.data?.data?.asset_list || [];
        const arr = Array.isArray(assetList) ? assetList : [];
        let matched = 0, skipped = 0;
        for (const asset of arr) {
            // 严格 submit_id 匹配：有 submit_id 时，只接受完全匹配的 asset
            // 旧版逻辑: asset 无 submit_id 字段时会误通过，导致下载旧任务视频
            if (submitId) {
                if (!asset.submit_id || asset.submit_id !== submitId) { skipped++; continue; }
                matched++;
            }
            // 查找 transcoded_video
            const videoUrl = _deepFindVideoUrl(asset);
            if (videoUrl) {
                console.log(`[即梦] _scanTranscoded: 找到视频 (assets=${arr.length}, matched=${matched}, skipped=${skipped})`);
                return videoUrl;
            }
        }
        if (arr.length > 0 && submitId) {
            console.log(`[即梦] _scanTranscoded: 无匹配视频 (assets=${arr.length}, matched=${matched}, skipped=${skipped}, submitId=${submitId.substring(0, 8)}...)`);
        }
    } catch (e) {
        console.error('[即梦] _scanTranscodedFromResponse error:', e.message);
    }
    return null;
}

/**
 * 从 API 响应中检测匹配 submit_id 的 asset 是否失败
 * 返回失败原因字符串，未失败返回 null
 */
function _scanFailureFromResponse(json, submitId) {
    if (!json || !submitId) return null;
    try {
        const assetList = json.asset_list || json.data?.asset_list || json.data?.data?.asset_list || [];
        const arr = Array.isArray(assetList) ? assetList : [];
        for (const asset of arr) {
            if (!asset.submit_id || asset.submit_id !== submitId) continue;
            // 检查常见的失败状态字段
            const st = (asset.state || asset.status || '').toString().toLowerCase();
            if (st === 'failed' || st === 'error' || st === 'fail') {
                return asset.fail_reason || asset.error_msg || asset.error || asset.message || '生成失败';
            }
            // 检查 sub_status / state 数字编码（即梦用数字状态：100=排队中, 110=生成中, 130=完成, 160/170=失败）
            const stNum = parseInt(asset.state || asset.status || '0');
            if (stNum >= 150 && stNum < 200) {
                return asset.fail_reason || asset.error_msg || `生成失败(状态码${stNum})`;
            }
        }
    } catch (e) { /* ignore */ }
    return null;
}

/**
 * 从对象中递归查找视频 URL
 * .pyd: _deep_find_video_url
 */
function _deepFindVideoUrl(obj) {
    if (!obj || typeof obj !== 'object') return null;
    // 优先检查 transcoded_video
    if (obj.transcoded_video && _looksLikeVideoUrl(obj.transcoded_video)) {
        return obj.transcoded_video;
    }
    // 检查 video_url
    if (obj.video_url && _looksLikeVideoUrl(obj.video_url)) {
        return obj.video_url;
    }
    // 递归
    for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'string' && _looksLikeVideoUrl(obj[key])) {
            return obj[key];
        }
        if (typeof obj[key] === 'object') {
            const found = _deepFindVideoUrl(obj[key]);
            if (found) return found;
        }
    }
    return null;
}

/**
 * 检查 CDP 端口是否已有 Chrome 在监听
 */
function _checkCdpAlive(port) {
    const cdpPort = port || CONFIG.cdpPort;
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${cdpPort}/json/version`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const info = JSON.parse(data);
                    resolve(info);
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    });
}

/**
 * 启动 Chrome 进程（带 --remote-debugging-port）
 * 与原始即梦插件一致的 CDP 方式
 */
async function _launchChrome(account) {
    const acct = account || _getAccount('default');
    // 检查 Chrome 路径（延迟检测，允许运行时重新查找）
    if (!CONFIG.chromePath) {
        CONFIG.chromePath = findChromePath();
    }
    if (!CONFIG.chromePath) {
        throw new Error('未找到Chrome或Edge浏览器，请安装 Google Chrome 或 Microsoft Edge 后重试');
    }

    // 确保用户数据目录存在
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
        // 指纹隔离：每个账号独立配置目录已天然隔离Cookie/Storage；
        // 以下参数减少自动化检测特征
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security=false',
        '--disable-reading-from-canvas=false',
        `--lang=zh-CN`,
        CONFIG.baseUrl,  // 启动时直接打开即梦
    ];

    console.log(`[即梦] 启动Chrome(CDP): ${CONFIG.chromePath}, 账号: ${acct.name}`);
    console.log(`[即梦] CDP端口: ${acct.cdpPort}, 用户目录: ${acct.userDataDir}`);

    acct.chromeProcess = spawn(CONFIG.chromePath, args, {
        detached: true,
        stdio: 'ignore',
    });
    acct.chromeProcess.unref();

    acct.chromeProcess.on('error', (err) => {
        console.error(`[即梦] Chrome启动失败(${acct.name}):`, err.message);
        acct.chromeProcess = null;
    });

    // 等待 CDP 端口就绪
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const info = await _checkCdpAlive(acct.cdpPort);
        if (info) {
            console.log(`[即梦] Chrome CDP就绪(${acct.name}): ${info.Browser || 'Chrome'}`);
            return;
        }
    }
    throw new Error(`Chrome CDP端口未就绪(${acct.name})，启动超时`);
}

/**
 * 初始化浏览器（per-account，CDP attach 方式）
 * @param {string} accountId - 账号ID，默认 'default'
 */
async function initBrowser(accountId) {
    const acct = _getAccount(accountId);
    // 如果已连接，直接返回
    if (acct.browser && acct.browser.isConnected()) {
        return acct.browser;
    }

    if (acct.isInitializing) {
        while (acct.isInitializing) {
            await new Promise(r => setTimeout(r, 500));
        }
        if (!acct.browser || !acct.browser.isConnected()) {
            throw new Error(`浏览器初始化失败(${acct.name})，请重试`);
        }
        return acct.browser;
    }

    acct.isInitializing = true;

    try {
        // 1. 检查是否已有 Chrome 在 CDP 端口监听
        let cdpInfo = await _checkCdpAlive(acct.cdpPort);
        if (cdpInfo) {
            console.log(`[即梦] 检测到已有Chrome(CDP, ${acct.name}): ${cdpInfo.Browser || 'Chrome'}`);
            try {
                const testBrowser = await puppeteer.connect({
                    browserURL: `http://127.0.0.1:${acct.cdpPort}`,
                    defaultViewport: null,
                });
                const pages = await testBrowser.pages();
                const hasVisiblePage = pages.some(p => {
                    const url = p.url();
                    return url && !url.startsWith('chrome://') && url !== 'about:blank' && url !== 'chrome-error://';
                });
                if (!hasVisiblePage) {
                    console.log(`[即梦] 已有Chrome无可用页面(${acct.name})，通过CDP关闭后重启`);
                    try { await testBrowser.close(); } catch {}
                    acct.chromeProcess = null;
                    await new Promise(r => setTimeout(r, 1500));
                    cdpInfo = null;
                } else {
                    testBrowser.disconnect();
                }
            } catch {
                cdpInfo = null;
            }
        }

        if (!cdpInfo) {
            // 2. 没有可用 Chrome → 启动新的 Chrome 进程
            await _launchChrome(acct);
            cdpInfo = await _checkCdpAlive(acct.cdpPort);
            if (!cdpInfo) throw new Error(`Chrome启动后CDP仍不可用(${acct.name})`);
        }

        // 3. 通过 CDP 连接
        acct.browser = await puppeteer.connect({
            browserURL: `http://127.0.0.1:${acct.cdpPort}`,
            defaultViewport: null,
        });

        console.log(`[即梦] Puppeteer已通过CDP连接到Chrome(${acct.name})`);

        const pages = await acct.browser.pages();
        acct.mainPage = pages.find(p => p.url().includes('jimeng.jianying.com')) || pages[0];
        if (!acct.mainPage) {
            acct.mainPage = await acct.browser.newPage();
        }

        // 指纹隔离：注入反自动化检测脚本
        try {
            await acct.mainPage.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'Chrome PDF Plugin' })),
                });
                Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
                window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
            });
        } catch (e) {
            console.log(`[即梦] 指纹注入失败(${acct.name}): ${e.message}`);
        }

        // 监听断开
        acct.browser.on('disconnected', () => {
            console.log(`[即梦] CDP连接已断开(${acct.name})`);
            acct.browser = null;
            acct.mainPage = null;
            acct.activeTaskCount = 0;
            // 标记该账号相关的进行中任务为失败
            for (const [tid, task] of Object.entries(taskStore)) {
                if ((task.status === 'processing' || task.status === 'pending') && task._accountId === acct.id) {
                    task.status = 'failed';
                    task.error = `浏览器连接已断开(${acct.name})`;
                    task.message = '浏览器被关闭或连接中断';
                    console.log(`[即梦] 任务${tid}因浏览器断开标记为失败`);
                }
            }
            // 如果所有账号都断开，清空共享队列
            const anyConnected = [..._accounts.values()].some(a => a.browser && a.browser.isConnected());
            if (!anyConnected) {
                taskQueue.length = 0;
                videoTaskQueue.length = 0;
                activeVideoTaskPages.clear();
                isProcessingQueue = false;
                activeVideoTaskCount = 0;
                activePollingCount = 0;
                _claimedVideoUrls.clear();
                _pageReloadBaselineVideos.clear();
                _videoSubmitLock = Promise.resolve();
            }
        });

        return acct.browser;
    } finally {
        acct.isInitializing = false;
    }
}

/**
 * 获取可用页面（默认账号）
 */
async function getPage(accountId) {
    const acct = _getAccount(accountId);
    await initBrowser(acct.id);
    if (!acct.mainPage || acct.mainPage.isClosed()) {
        const pages = await acct.browser.pages();
        acct.mainPage = pages.find(p => p.url().includes('jimeng.jianying.com')) || pages[0];
        if (!acct.mainPage) {
            acct.mainPage = await acct.browser.newPage();
        }
    }
    return acct.mainPage;
}

/**
 * 选择最空闲的已连接账号用于创建视频任务页面
 */
function _pickLeastBusyAccount() {
    let best = null;
    let minTasks = Infinity;
    for (const acct of _accounts.values()) {
        if (acct.browser && acct.browser.isConnected() && acct.activeTaskCount < MAX_CONCURRENT_PER_ACCOUNT) {
            if (acct.activeTaskCount < minTasks) {
                minTasks = acct.activeTaskCount;
                best = acct;
            }
        }
    }
    return best;
}

function _getAvailableAccountById(accountId) {
    const acct = _accounts.get(accountId);
    if (acct && acct.browser && acct.browser.isConnected() && acct.activeTaskCount < MAX_CONCURRENT_PER_ACCOUNT) {
        return acct;
    }
    return null;
}

/**
 * 获取所有账号的最大总并发数
 */
function _getTotalMaxConcurrent() {
    let total = 0;
    for (const acct of _accounts.values()) {
        if (acct.browser && acct.browser.isConnected()) {
            total += MAX_CONCURRENT_PER_ACCOUNT;
        }
    }
    return Math.max(total, MAX_CONCURRENT_PER_ACCOUNT); // 至少允许默认账号的量
}

async function _createVideoTaskPage(taskId, accountId) {
    const acct = _getAccount(accountId);
    await initBrowser(acct.id);
    const page = await acct.browser.newPage();
    // 指纹隔离
    try {
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
            window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
        });
    } catch (_) {}
    activeVideoTaskPages.set(taskId, { page, accountId: acct.id });
    acct.activeTaskCount++;
    console.log(`[即梦] 为任务${taskId}创建独立页面(${acct.name})`);
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
    // 不关闭任何账号的 mainPage
    for (const acct of _accounts.values()) {
        if (ownedPage === acct.mainPage) return;
    }
    try {
        await ownedPage.close({ runBeforeUnload: false });
        console.log(`[即梦] 任务${taskId}独立页面已关闭`);
    } catch (e) {
        console.log(`[即梦] 关闭任务${taskId}独立页面失败: ${e.message}`);
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

function _isTaskCancelled(taskId) {
    const task = taskStore[taskId];
    return !task || (task.status === 'failed' && task.error === '已取消');
}

let _videoSubmitLock = Promise.resolve();

function _processVideoTaskQueue() {
    const maxTotal = _getTotalMaxConcurrent();
    while (activeVideoTaskCount < maxTotal && videoTaskQueue.length > 0) {
        let queueIndex = -1;
        let acct = null;
        for (let i = 0; i < videoTaskQueue.length; i++) {
            const candidate = videoTaskQueue[i];
            const forcedAccountId = candidate?.params?.accountId;
            const candidateAccount = forcedAccountId
                ? _getAvailableAccountById(forcedAccountId)
                : _pickLeastBusyAccount();
            if (candidateAccount) {
                queueIndex = i;
                acct = candidateAccount;
                break;
            }
        }
        if (!acct || queueIndex < 0) break; // 所有可用账号都满了，或指定账号暂时不可用

        const [{ taskId, params }] = videoTaskQueue.splice(queueIndex, 1);
        activeVideoTaskCount++;
        _refreshVideoTaskQueueMessages();

        // 存储任务绑定的账号
        const task = taskStore[taskId];
        if (task) task._accountId = acct.id;

        _runVideoTaskOnIsolatedPage(taskId, params, acct.id)
            .catch((err) => {
                console.error(`[即梦] 视频任务${taskId}执行异常:`, err.message);
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
        if (_isTaskCancelled(taskId)) return;
        // 串行提交：等待前一个任务的提交阶段完成后再开始本次提交
        let submitResult = null;
        const prevLock = _videoSubmitLock;
        _videoSubmitLock = new Promise(async (unlockSubmit) => {
            try {
                await prevLock; // 等待前一个提交完成
                if (_isTaskCancelled(taskId)) return;
                task.message = '准备独立浏览器页...';
                task.progress = 2;
                page = await _createVideoTaskPage(taskId, accountId);
                if (_isTaskCancelled(taskId)) return;
                submitResult = await _executeSubmitPhase(taskId, params, page);
            } finally {
                unlockSubmit(); // 释放锁，允许下一个任务开始提交
            }
        });
        await _videoSubmitLock;

        if (!submitResult || _isTaskCancelled(taskId)) return;

        // 提交完成后，轮询阶段并行执行（不占锁）
        activePollingCount++;
        try {
            if (_isTaskCancelled(taskId)) return;
            await _executePollPhase(taskId, submitResult.page, submitResult.interceptor);
        } finally {
            activePollingCount = Math.max(0, activePollingCount - 1);
        }
    } finally {
        await _closeVideoTaskPage(taskId, page);
    }
}

// ==================== 登录管理 ====================

/**
 * 检查登录状态
 * @param {string|Object} accountIdOrPage - 账号ID或page对象（兼容旧调用方式）
 */
async function checkLoginStatus(accountIdOrPage) {
    try {
        let page;
        if (accountIdOrPage && typeof accountIdOrPage === 'object' && typeof accountIdOrPage.evaluate === 'function') {
            // 传入的是page对象（兼容旧的 pageOverride 用法）
            page = accountIdOrPage;
        } else {
            const accountId = (typeof accountIdOrPage === 'string') ? accountIdOrPage : 'default';
            page = await getPage(accountId);
        }

        // 访问即梦首页
        const currentUrl = page.url();
        if (!currentUrl.includes('jimeng.jianying.com')) {
            await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        const isLoggedIn = await page.evaluate(() => {
            const prompt = document.querySelector('textarea[class*="prompt-textarea"], textarea[placeholder*="Seedance"]');
            if (prompt) return true;
            const videoEntry = document.querySelector('button[class*="button-RNHVcx"]');
            if (videoEntry) return true;
            const avatar = document.querySelector('[class*="avatar"], [class*="user-info"]');
            if (avatar) return true;
            if (window.location.href.includes('login') || window.location.href.includes('sign')) return false;
            return false;
        });

        return {
            loggedIn: isLoggedIn,
            browserOpen: true,
            url: page.url(),
        };
    } catch (error) {
        const acct = _getAccount(typeof accountIdOrPage === 'string' ? accountIdOrPage : 'default');
        return {
            loggedIn: false,
            browserOpen: acct.browser && acct.browser.isConnected(),
            error: error.message,
        };
    }
}

/**
 * 打开登录页面（让用户手动登录）
 * @param {string} accountId - 账号ID
 */
async function openLoginPage(accountId) {
    const acct = _getAccount(accountId);
    await initBrowser(acct.id);
    let page = await getPage(acct.id);
    await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    try {
        await page.bringToFront();
        const cdp = await page.createCDPSession();
        try {
            const { windowId } = await cdp.send('Browser.getWindowForTarget');
            await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        } finally {
            await cdp.detach();
        }
    } catch (e) {
        console.log(`[即梦] Chrome窗口不可访问(${acct.name})，重新启动Chrome`);
        try { acct.browser.disconnect(); } catch {}
        acct.browser = null;
        acct.mainPage = null;
        try {
            const tmpBrowser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${acct.cdpPort}`, defaultViewport: null });
            await tmpBrowser.close();
        } catch {}
        acct.chromeProcess = null;
        await new Promise(r => setTimeout(r, 1500));
        await initBrowser(acct.id);
        page = await getPage(acct.id);
        await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    return {
        message: `已打开即梦网站(${acct.name})，请在浏览器中手动登录。登录后点击"检查登录状态"确认。`,
        url: page.url(),
    };
}

/**
 * 保存Cookie
 * @param {string} accountId - 账号ID
 */
async function saveCookies(accountId) {
    try {
        const acct = _getAccount(accountId);
        const page = await getPage(acct.id);
        const cookies = await page.cookies();

        const dir = path.dirname(acct.cookieFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(acct.cookieFile, JSON.stringify(cookies, null, 2), 'utf-8');
        console.log(`[即梦] 已保存 ${cookies.length} 个Cookie(${acct.name})`);
        return true;
    } catch (error) {
        console.error(`[即梦] Cookie保存失败:`, error.message);
        return false;
    }
}

// ==================== 视频生成核心 ====================

/**
 * 提交视频生成任务
 * 
 * @param {Object} params
 * @param {string} params.videoPrompt - 视频提示词
 * @param {string} [params.imagePrompt] - 图片提示词
 * @param {Array} [params.referenceImages] - 参考图数组 [{url, name, type}]
 * @param {string} [params.aspectRatio] - 宽高比 16:9 / 9:16 / 1:1
 * @param {number} [params.shotNumber] - 分镜编号
 * @returns {Object} { taskId, status }
 */
async function submitVideoTask(params) {
    const { videoPrompt, aspectRatio, shotNumber, projectName, projectPath, shotIndex, accountId } = params;
    const taskId = `jimeng_${Date.now()}_${shotNumber || 0}`;

    // 确保目标账号的浏览器已初始化；未指定时兼容默认账号
    await initBrowser(accountId || 'default');

    // 初始化任务状态
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
        _accountId: accountId || null, // 指定账号时预填，实际运行账号在队列分发时最终确认
    };

    // 加入视频任务页队列
    videoTaskQueue.push({ taskId, params });
    const maxTotal = _getTotalMaxConcurrent();
    const queuePos = videoTaskQueue.length;
    if (activeVideoTaskCount >= maxTotal || queuePos > 1) {
        taskStore[taskId].message = `等待空闲浏览器页（第${queuePos}个）...`;
        console.log(`[即梦] 视频任务${taskId}（分镜${shotNumber}）加入独立页队列，位置=${queuePos}`);
    } else {
        taskStore[taskId].message = '准备独立浏览器页...';
        console.log(`[即梦] 视频任务${taskId}（分镜${shotNumber}）立即启动独立页面`);
    }

    _processVideoTaskQueue();

    return { taskId, status: 'pending' };
}

/**
 * 队列处理器：顺序执行任务，避免多任务同时操作浏览器页面
 */
async function _processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (taskQueue.length > 0) {
        const { taskId, params } = taskQueue.shift();
        const remaining = taskQueue.length;
        console.log(`[即梦] 开始提交任务 ${taskId}（分镜${params.shotNumber}），剩余排队: ${remaining}`);

        // 更新排队中任务的位置
        taskQueue.forEach((item, idx) => {
            if (taskStore[item.taskId]) {
                taskStore[item.taskId].message = `排队中（第${idx + 1}个）...`;
            }
        });

        taskStore[taskId].message = '准备提交任务...';
        const isImageTask = !!params._isImageTask;
        try {
            // 只等待提交阶段（填词+上传图+点击生成+捕获submit_id）
            isSubmittingTask = true;
            const submitResult = isImageTask
                ? await _executeImageSubmitPhase(taskId, params)
                : await _executeSubmitPhase(taskId, params);
            isSubmittingTask = false;

            if (submitResult) {
                if (isImageTask) {
                    // 图片任务：顺序等待（图片生成快，不需要并行）
                    console.log(`[即梦] 图片任务${taskId}，顺序等待完成`);
                    try {
                        await _waitForImageCompletion(taskId, submitResult.page, submitResult.interceptor);
                    } catch (err) {
                        console.error(`[即梦] 图片任务${taskId}轮询异常:`, err.message);
                        taskStore[taskId].status = 'failed';
                        taskStore[taskId].error = err.message;
                        taskStore[taskId].message = '轮询异常: ' + err.message;
                    } finally {
                        submitResult.interceptor.cleanup();
                    }
                } else if (submitResult.hasSubmitId) {
                    // 有 submit_id → 安全并行：轮询通过 submit_id 精确匹配，不怕页面导航
                    activePollingCount++;
                    _executePollPhase(taskId, submitResult.page, submitResult.interceptor).catch(err => {
                        console.error(`[即梦] 任务${taskId}轮询异常:`, err.message);
                        taskStore[taskId].status = 'failed';
                        taskStore[taskId].error = err.message;
                        taskStore[taskId].message = '轮询异常: ' + err.message;
                    }).finally(() => { activePollingCount--; });
                    console.log(`[即梦] 任务${taskId} 有submit_id，轮询在后台并行`);
                    // 等待3秒让平台后端完全处理当前提交，再导航到新创作页提交下一个
                    await new Promise(r => setTimeout(r, 3000));
                    console.log(`[即梦] 继续下一个任务`);
                } else {
                    // 无 submit_id → 后台轮询（不再阻塞队列）
                    // window.stop() 冻结了 SPA，先 reload 恢复，使 DOM 轮询能正常工作
                    console.log(`[即梦] 任务${taskId} 无submit_id，恢复SPA后转入后台轮询`);
                    try {
                        await submitResult.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                        await new Promise(r => setTimeout(r, 3000));
                        // 快照reload后的页面视频到全局排除集
                        const rv = await submitResult.page.evaluate(() => {
                            const urls = [];
                            document.querySelectorAll('video').forEach(v => { const s = v.currentSrc || v.src || ''; if (s) urls.push(s); });
                            return urls;
                        }).catch(() => []);
                        rv.forEach(url => _pageReloadBaselineVideos.add(url));
                        console.log(`[即梦] 页面已恢复，快照视频${rv.length}个，开始后台DOM轮询`);
                    } catch (reloadErr) {
                        console.log(`[即梦] 页面恢复失败: ${reloadErr.message}，仍尝试轮询`);
                    }
                    activePollingCount++;
                    _executePollPhase(taskId, submitResult.page, submitResult.interceptor).catch(err => {
                        console.error(`[即梦] 任务${taskId}轮询异常:`, err.message);
                        taskStore[taskId].status = 'failed';
                        taskStore[taskId].error = err.message;
                        taskStore[taskId].message = '轮询异常: ' + err.message;
                    }).finally(() => { activePollingCount--; });
                    console.log(`[即梦] 任务${taskId} 无submit_id，轮询已转入后台`);
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        } catch (err) {
            isSubmittingTask = false;
            console.error(`[即梦] 任务${taskId}提交异常:`, err.message);
            taskStore[taskId].status = 'failed';
            taskStore[taskId].error = err.message;
            taskStore[taskId].message = '任务提交异常: ' + err.message;
        }
    }

    console.log('[即梦] 队列提交阶段全部完成，轮询在后台进行');

    // window.stop() 冻结了页面 JS（防止导航时额外生成），现在需要恢复 SPA 让轮询正常工作
    // 关键：reload 时拦截 generate API 防止 SPA 自动恢复草稿并提交，但放行 get_asset_list
    if (activePollingCount > 0) {
        try {
            const page = await getPage();
            await page.setRequestInterception(true);
            const blockGenerateHandler = (request) => {
                if (_isGenerateEndpoint(request.url())) {
                    console.log('[即梦] 拦截并阻止自动生成请求（SPA草稿恢复）');
                    request.abort();
                } else {
                    request.continue();
                }
            };
            page.on('request', blockGenerateHandler);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            console.log('[即梦] 页面已刷新（generate API 已拦截），等待 SPA 初始化...');
            // 等待 SPA 初始化并发出 get_asset_list 请求
            await new Promise(r => setTimeout(r, 5000));
            // 移除拦截，避免影响后续操作
            page.off('request', blockGenerateHandler);
            await page.setRequestInterception(false).catch(() => { });
            console.log('[即梦] SPA 恢复运行，轮询可正常捕获视频');

            // 刷新后快照页面上所有已有视频URL，防止无submit_id任务的全局扫描误抓旧视频
            const reloadVideos = await page.evaluate(() => {
                const urls = [];
                document.querySelectorAll('video').forEach(v => {
                    const src = v.currentSrc || v.src || '';
                    if (src) urls.push(src);
                });
                return urls;
            }).catch(() => []);
            reloadVideos.forEach(url => _pageReloadBaselineVideos.add(url));
            console.log(`[即梦] 页面reload后快照视频: ${reloadVideos.length}个, 全局排除集: ${_pageReloadBaselineVideos.size}个`);
        } catch (e) {
            console.log('[即梦] 页面刷新失败:', e.message);
        }
    }

    isProcessingQueue = false;
}

/**
 * 提交阶段：填写提示词、上传图片、点击生成、捕获 submit_id
 * 返回 { page, interceptor } 用于后续轮询，失败时返回 null
 */
async function _executeSubmitPhase(taskId, params, pageOverride = null) {
    const isDryRun = !!params.dryRun;
    console.log(`[即梦] _executeSubmitPhase v6 — fast-submit queue${isDryRun ? ' [DRY-RUN]' : ''}`);
    const { videoPrompt, aspectRatio, duration } = params;
    const referenceImages = params.referenceImages || []; // [{url, name, type}]
    const generationMode = params.generationMode || CONFIG.generationMode; // 默认 omni_reference
    const modelKey = params.model || CONFIG.defaultModel; // 默认 seedance-2.0
    const task = taskStore[taskId];
    const ensureNotCancelled = () => {
        if (_isTaskCancelled(taskId)) throw new Error('已取消');
    };

    try {
        ensureNotCancelled();
        const page = pageOverride || await getPage();

        // 1. 检查登录
        ensureNotCancelled();
        task.message = '检查登录状态...';
        task.progress = 5;
        const loginStatus = await checkLoginStatus(page);
        if (!loginStatus.loggedIn) {
            task.status = 'failed';
            task.error = '未登录，请先在浏览器中登录即梦';
            task.message = '未登录，请先登录';
            return null;
        }

        // 2. 打开创作页面
        ensureNotCancelled();
        task.message = '正在打开创作页面...';
        task.progress = 10;
        await page.goto(CONFIG.createUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await _randomDelay(2500, 3500);

        // 3. 确认进入视频生成模式
        ensureNotCancelled();
        task.message = '确认视频生成模式...';
        task.progress = 12;
        await _ensureVideoMode(page);
        await _randomDelay(500, 1000);

        // 4. 等待页面加载
        ensureNotCancelled();
        task.message = '等待页面加载...';
        task.progress = 15;
        await page.waitForSelector(
            `${CONFIG.selectors.promptTextarea}, ${CONFIG.selectors.promptTextareaAlt}, textarea, [contenteditable="true"]`,
            { timeout: 15000 }
        );
        await _randomDelay(500, 1000);

        // 4.5 先切换到目标生成模式（首尾帧 / 全能参考）— 必须在选模型之前，否则切模式会重置模型
        ensureNotCancelled();
        task.message = `切换到${generationMode === 'omni_reference' ? '全能参考' : '首尾帧'}模式...`;
        task.progress = 16;
        console.log(`[即梦] playwright: generation_mode=${generationMode}, inputs: model=${modelKey}`);
        await _switchReferenceMode(page, generationMode);
        await _randomDelay(500, 1000);

        // 切换模式后等待正确的编辑器出现（全能参考=contenteditable, 首尾帧=textarea）
        if (generationMode === 'omni_reference') {
            for (let waitI = 0; waitI < 10; waitI++) {
                const hasContentEditable = await page.evaluate(() => {
                    const el = document.querySelector('[contenteditable="true"]');
                    return el && el.offsetParent !== null;
                }).catch(() => false);
                if (hasContentEditable) {
                    console.log(`[即梦] 全能参考编辑器(contenteditable)已就绪`);
                    break;
                }
                if (waitI === 9) console.log(`[即梦] 警告: 等待 contenteditable 编辑器超时，将使用当前编辑器`);
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // 5. 选择模型（.pyd: _model_click_map — Seedance 2.0 / 2.0 Fast）
        ensureNotCancelled();
        task.message = `选择模型: ${modelKey}...`;
        task.progress = 18;
        await _selectModel(page, modelKey);
        await _randomDelay(500, 1000);

        // 5.5 选模型后验证模式：选模型可能重置模式，必须在上传图片前确认
        {
            const modeAfterModel = await _detectReferenceMode(page);
            if (modeAfterModel !== generationMode) {
                console.log(`[即梦] 警告: 选模型后模式被重置为 ${modeAfterModel}，重新切换到 ${generationMode === 'omni_reference' ? '全能参考' : '首尾帧'}`);
                await _switchReferenceMode(page, generationMode);
                await _randomDelay(500, 1000);
                if (generationMode === 'omni_reference') {
                    for (let waitI = 0; waitI < 10; waitI++) {
                        const ok = await page.evaluate(() => {
                            const el = document.querySelector('[contenteditable="true"]');
                            return el && el.offsetParent !== null;
                        }).catch(() => false);
                        if (ok) break;
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            } else {
                console.log(`[即梦] 选模型后模式验证通过: ${modeAfterModel}`);
            }
        }

        // 6-7. 根据模式不同，提示词和图片的处理顺序完全不同
        if (generationMode === 'omni_reference') {
            // ===== 全能参考模式 =====
            // 真实流程:
            //   1. 先逐张上传参考图（让图片在编辑器中可被 @ 引用）
            //   2. 构建结构化提示词: 清空编辑器 → @图片N 这是{name} → 用户提示词
            //   最终效果: @图片1 这是韩秀景 @图片2 这是宫殿寝室 用户的提示词...

            const uploadedLabels = [];
            const maxRefs = Math.min(referenceImages.length, CONFIG.omniRefMax);
            console.log(`[即梦] 全能参考模式: 共 ${referenceImages.length} 张参考图, 最多上传 ${maxRefs} 张`);

            for (let i = 0; i < maxRefs; i++) {
                ensureNotCancelled();
                const ref = referenceImages[i];
                console.log(`[即梦] 参考图[${i}]: name=${ref.name}, type=${ref.type}, url=${ref.url ? ref.url.substring(0, 80) : '无'}`);
                task.message = `上传参考图 ${i + 1}/${maxRefs}: ${ref.name}...`;
                task.progress = 20 + Math.round((i / maxRefs) * 8);
                const localPath = await _ensureLocalImage(ref.url);
                console.log(`[即梦] 参考图[${i}] localPath=${localPath || '失败'}`);
                if (localPath) {
                    const uploaded = await _uploadReferenceImageForOmni(page, localPath);
                    if (uploaded) {
                        const shortName = (ref.name || `参考图${i + 1}`).split('/')[0].trim();
                        uploadedLabels.push(shortName);
                        console.log(`[即梦] 参考图[${i}] 上传完成, label=${shortName}`);
                    } else {
                        console.log(`[即梦] 参考图[${i}] 上传失败, 跳过label`);
                    }
                    await _randomDelay(2000, 3000);
                }
            }
            console.log(`[即梦] 上传完成, labels=[${uploadedLabels.join(', ')}]`);

            // 识别音色标签（不再预处理提示词，音色引用放在开头而非内联散布）
            const voiceLabelSet = new Set();
            for (let i = 0; i < maxRefs; i++) {
                if (referenceImages[i]?.type === 'voice') {
                    voiceLabelSet.add(uploadedLabels[i]);
                }
            }
            let processedPrompt = videoPrompt;
            if (voiceLabelSet.size > 0) {
                console.log(`[即梦] 音色标签: ${[...voiceLabelSet].join(', ')} (将在开头@引用，不修改提示词文本)`);
            }

            // 构建结构化提示词（带 @引用 + 名字标签）
            ensureNotCancelled();
            task.message = '构建结构化提示词...';
            task.progress = 30;
            await _setStructuredPromptWithRefs(page, processedPrompt, uploadedLabels, voiceLabelSet, params.picRefMap, params.refMode);
            await _randomDelay(500, 1000);

        } else {
            // ===== 首尾帧模式（2张图：首帧 + 尾帧）=====
            // 先填提示词（textarea），再上传首帧/尾帧

            ensureNotCancelled();
            task.message = '填写视频提示词...';
            task.progress = 22;
            await _fillPrompt(page, videoPrompt);
            await _randomDelay(500, 1000);

            if (referenceImages.length > 0) {
                // 第1张作为首帧
                const firstFrameUrl = referenceImages[0]?.url;
                const firstFramePath = firstFrameUrl ? await _ensureLocalImage(firstFrameUrl) : null;
                // 第2张作为尾帧（如果有）
                const endFrameUrl = referenceImages[1]?.url;
                const endFramePath = endFrameUrl ? await _ensureLocalImage(endFrameUrl) : null;

                if (firstFramePath) {
                    ensureNotCancelled();
                    task.message = `上传首帧${endFramePath ? '+尾帧' : ''}...`;
                    task.progress = 30;
                    await _uploadFrames(page, firstFramePath, endFramePath);
                    await _randomDelay(1000, 2000);
                }
            }
        }

        // 8. 设置宽高比
        if (aspectRatio) {
            ensureNotCancelled();
            task.message = '设置宽高比...';
            task.progress = 35;
            await _setAspectRatio(page, aspectRatio);
            await _randomDelay(500, 1000);
        }

        // 9. 设置视频时长
        if (duration) {
            ensureNotCancelled();
            task.message = `设置时长 ${duration}秒...`;
            task.progress = 38;
            await _setDuration(page, duration);
            await _randomDelay(500, 1000);
        }

        // 9.5 提交前最终模式验证：设比例/设时长也可能重置模式
        {
            const finalMode = await _detectReferenceMode(page);
            if (finalMode !== generationMode) {
                console.log(`[即梦] 警告: 提交前模式被重置为 ${finalMode}，重新切换到 ${generationMode === 'omni_reference' ? '全能参考' : '首尾帧'}`);
                await _switchReferenceMode(page, generationMode);
                await _randomDelay(800, 1200);
            } else {
                console.log(`[即梦] 提交前最终模式验证通过: ${finalMode}`);
            }
        }

        // 9.6 提交前比例验证：上传参考图可能导致比例被重置为"自动"
        if (aspectRatio) {
            const currentRatio = await page.evaluate(() => {
                // 在底部栏找当前选中的比例（高亮/选中状态的比例按钮）
                const btns = document.querySelectorAll('span, div, button, [role="radio"], [role="option"]');
                for (const el of btns) {
                    const t = (el.textContent || '').trim();
                    if (/^\d+[：:]\d+$/.test(t) && el.offsetParent !== null) {
                        const r = el.getBoundingClientRect();
                        if (r.y > window.innerHeight * 0.5) {
                            // 检查是否处于选中状态（高亮/active class）
                            const cls = el.className || '';
                            const parentCls = (el.parentElement?.className || '');
                            if (cls.includes('active') || cls.includes('selected') || cls.includes('checked') ||
                                parentCls.includes('active') || parentCls.includes('selected') || parentCls.includes('checked') ||
                                el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-active') === 'true') {
                                return t.replace('：', ':');
                            }
                        }
                    }
                }
                // fallback：找底部栏中所有比例文本，看哪个样式不同
                const allRatios = [];
                for (const el of btns) {
                    const t = (el.textContent || '').trim();
                    if (/^\d+[：:]\d+$/.test(t) && el.offsetParent !== null) {
                        const r = el.getBoundingClientRect();
                        if (r.y > window.innerHeight * 0.5) {
                            const style = window.getComputedStyle(el);
                            allRatios.push({ text: t.replace('：', ':'), color: style.color, bg: style.backgroundColor, fontWeight: style.fontWeight });
                        }
                    }
                }
                // 如果有一个比例颜色/粗细与众不同，那就是当前选中的
                if (allRatios.length > 1) {
                    const first = allRatios[0];
                    for (const r of allRatios) {
                        if (r.color !== first.color || r.fontWeight !== first.fontWeight || r.bg !== first.bg) {
                            return r.text;
                        }
                    }
                }
                return null;
            });
            if (currentRatio && currentRatio === aspectRatio) {
                console.log(`[即梦] 提交前比例验证通过: ${currentRatio}`);
            } else {
                console.log(`[即梦] 提交前比例强制重设: 检测到 [${currentRatio || '未知'}]，目标 [${aspectRatio}]`);
                await _setAspectRatio(page, aspectRatio);
                await _randomDelay(500, 800);
            }
        }

        // 10. DRY-RUN 检查：如果是测试模式，到此为止，不点击生成
        if (isDryRun) {
            const dryRunFinalMode = await _detectReferenceMode(page);
            console.log(`[即梦] [DRY-RUN] ✅ 全部步骤完成，最终模式: ${dryRunFinalMode}，期望: ${generationMode}`);
            console.log(`[即梦] [DRY-RUN] 模式匹配: ${dryRunFinalMode === generationMode ? '✅ 正确' : '❌ 不匹配!'}`);
            task.status = 'completed';
            task.progress = 100;
            task.message = `[DRY-RUN] 完成 — 最终模式: ${dryRunFinalMode === generationMode ? '✅正确' : '❌不匹配'}(${dryRunFinalMode})`;
            return null; // 不进入轮询阶段
        }

        // 10.5 提交前最终模型验证：设比例/设时长/模式重切都可能重置模型为 Fast
        {
            ensureNotCancelled();
            const modelConfig = CONFIG.models[modelKey];
            if (modelConfig) {
                const targetModel = modelConfig.clickText;
                const currentModel = await page.evaluate(() => {
                    const vals = document.querySelectorAll('.lv-select-view-value');
                    for (const v of vals) {
                        let directText = '';
                        for (const node of v.childNodes) {
                            if (node.nodeType === 3) directText += node.textContent;
                        }
                        directText = directText.trim();
                        if (directText.includes('Seedance')) return directText;
                    }
                    for (const v of vals) {
                        const t = (v.innerText || '').replace(/\s+/g, ' ').trim();
                        if (t.includes('Seedance')) return t;
                    }
                    return null;
                });
                if (currentModel && currentModel.trim() !== targetModel.trim()) {
                    console.log(`[即梦] 警告: 提交前模型被重置为 [${currentModel}]，重新选择 [${targetModel}]`);
                    await _selectModel(page, modelKey);
                    await _randomDelay(500, 800);
                } else {
                    console.log(`[即梦] 提交前最终模型验证通过: [${currentModel}]`);
                }
            }
        }

        // 11. 安装网络拦截器（在点击生成前安装，捕获 submit_id）
        // .pyd: page.on('response', _on_response) — 在生成前注册
        ensureNotCancelled();
        task.message = '安装网络拦截器...';
        task.progress = 39;
        const interceptor = _setupNetworkInterceptor(page);

        // 12. 点击生成按钮
        ensureNotCancelled();
        task.message = '提交生成任务...';
        task.progress = 40;
        await _clickGenerateButton(page);

        // 等待网络拦截器捕获 submit_id（最多等 15 秒），同时检查 toast 错误
        ensureNotCancelled();
        task.message = '等待捕获 submit_id...';
        task.progress = 42;
        const submitIdWaitStart = Date.now();
        for (let i = 0; i < 30; i++) {
            if (interceptor.getSubmitId()) break;
            // 每轮检查页面上是否出现错误 toast（平台规则违规等）
            if (i > 0 && i % 4 === 0) {
                const toastError = await page.evaluate(() => {
                    const FAIL_KEYWORDS = ['不符合平台规则', '平台规则', '违规', '审核未通过', '请稍后再试', '内容不合规', '敏感', '违反', '生成失败', '积分不足', '余额不足', '次数不足', '免费次数已用完', '额度不足', '购买会员', '服务繁忙', '请登录'];
                    // 检查 lark toast、arco-message、通用 toast 等
                    const toastSelectors = ['.lv-message', '.arco-message', '[class*="toast"]', '[class*="Toast"]', '[class*="message-wrapper"]', '[class*="notice"]', '[role="alert"]'];
                    for (const sel of toastSelectors) {
                        const els = document.querySelectorAll(sel);
                        for (const el of els) {
                            const txt = (el.innerText || '').trim();
                            if (txt && FAIL_KEYWORDS.some(kw => txt.includes(kw))) return txt.substring(0, 100);
                        }
                    }
                    // 也检查全局可见 div/span
                    const allEls = document.querySelectorAll('div, span');
                    for (const el of allEls) {
                        const r = el.getBoundingClientRect();
                        if (r.width < 50 || r.height < 10 || r.height > 200) continue;
                        const txt = (el.innerText || '').trim();
                        if (txt.length > 5 && txt.length < 100 && FAIL_KEYWORDS.some(kw => txt.includes(kw))) return txt;
                    }
                    return null;
                }).catch(() => null);
                if (toastError) {
                    console.log(`[即梦] 提交后检测到错误 toast: ${toastError}`);
                    interceptor.lockSubmitId();
                    interceptor.cleanup();
                    task.status = 'failed';
                    task.error = toastError;
                    task.message = `生成失败: ${toastError}`;
                    return null; // 立即返回，不进入轮询阶段，队列继续下一个
                }
            }
            await new Promise(r => setTimeout(r, 500));
            ensureNotCancelled();
        }
        const submitId = interceptor.getSubmitId();
        const submitIdElapsed = Date.now() - submitIdWaitStart;
        // 无论是否捕获到，立即锁定，防止后续任务的 generate 响应污染此拦截器
        interceptor.lockSubmitId();
        if (submitId) {
            _traceLog(`[即梦] ✅ submit_id 已捕获: ${submitId} (耗时${submitIdElapsed}ms) taskId=${taskId}`);
            task.submitId = submitId;
        } else {
            _traceLog(`[即梦] ❌ submit_id 捕获失败 (等待${submitIdElapsed}ms超时) taskId=${taskId} — 将使用纯 DOM 轮询，视频匹配可能不精确！`);
        }

        // 提交阶段完成
        // 冻结页面 JS：阻止 SPA 的 beforeunload / auto-save 在下个任务导航时触发额外生成
        await page.evaluate(() => window.stop()).catch(() => { });
        console.log('[即梦] playwright: window.stop() — 页面JS已冻结，防止导航触发额外提交');

        task.status = 'processing';
        task.message = '任务已提交，等待生成...';
        task.progress = 45;
        console.log('[即梦] playwright: submit phase done, handing off to poll phase');

        return { page, interceptor, hasSubmitId: !!submitId };

    } catch (error) {
        console.error(`[即梦] 提交阶段失败:`, error.message);
        if (_isTaskCancelled(taskId) || error.message === '已取消') {
            task.status = 'failed';
            task.error = '已取消';
            task.message = '已取消';
            return null;
        }
        task.status = 'failed';
        task.error = error.message;
        task.message = '任务提交失败: ' + error.message;
        return null;
    }
}

/**
 * 轮询阶段：等待视频生成完成 + 下载（异步并行执行，不阻塞队列）
 */
async function _executePollPhase(taskId, page, interceptor) {
    try {
        if (_isTaskCancelled(taskId)) return;
        console.log(`[即梦] 轮询阶段开始: ${taskId}`);
        await _waitForCompletion(taskId, page, interceptor);
    } finally {
        interceptor.cleanup();
        console.log(`[即梦] 轮询阶段结束: ${taskId}`);
    }
}

// ==================== 模式切换（从 .pyd 逆向完整还原） ====================

/**
 * 检测底部栏当前处于哪种模式
 * .pyd: _detect_bar_mode → 返回 'video_mode' / 'agent_mode' / 'image_mode' / 'unknown'
 *
 * 检测逻辑（从 .pyd 提取）:
 * - 包含 'Agent 模式' 或 (包含 'Agent' 且长度<20) → 'agent_mode'
 * - 包含 'Seedance' 或 '首尾帧' 或 '全能参考' → 'video_mode'
 * - 包含 '图片生成' → 'image_mode'（需要切换到视频）
 */
async function _detectBarMode(page) {
    return await page.evaluate(() => {
        const els = document.querySelectorAll('div, span, button');
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const t = (el.innerText || '').trim();
            if (!t) continue;
            // .pyd: Agent 模式检测
            if (t === 'Agent 模式' || (t.includes('Agent') && t.length < 20)) return 'agent_mode';
            // .pyd: 视频模式检测 — Seedance / 首尾帧 / 全能参考
            if (t.includes('Seedance') || t.includes('首尾帧') || t.includes('全能参考')) return 'video_mode';
        }
        // 图片模式检测：底部栏有图片模型名（图片5.0lite、图片3.0等）
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const t = (el.innerText || '').trim();
            if (!t) continue;
            if ((t.includes('图片') && (t.includes('5.0') || t.includes('3.0') || t.includes('2.1'))) && t.length < 30) return 'image_mode';
        }
        // fallback: 检查是否有图片生成相关文本
        const allText = document.body.innerText || '';
        if (allText.includes('图片生成') && !allText.includes('视频生成')) return 'image_mode';
        return 'unknown';
    });
}

/**
 * 确保当前在视频生成模式（不是图片/Agent等模式）
 * .pyd: 最多重试3次，每次点击 '视频生成' option
 *
 * 流程:
 * 1. _detect_bar_mode 检测当前模式
 * 2. 如果不是 video_mode，点击 '视频生成' 选项
 * 3. 重试最多3次，每次验证
 */
async function _ensureVideoMode(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const mode = await _detectBarMode(page);
        console.log(`[即梦] playwright: bottom bar mode: ${mode}`);

        if (mode === 'video_mode') {
            console.log('[即梦] playwright: confirmed: now in video generation mode');
            return;
        }

        // .pyd: playwright: switching to video mode (attempt N)
        console.log(`[即梦] playwright: switching to video mode (attempt ${attempt + 1})`);

        const clickResult = await page.evaluate(() => {
            // .pyd: 查找包含 '视频生成' 文本的可见元素并点击
            const all = document.querySelectorAll('div, span, button, li, a');
            // 精确匹配优先
            for (const el of all) {
                const t = (el.innerText || el.textContent || '').trim();
                if (t === '视频生成' && el.offsetParent !== null) {
                    el.click();
                    return { ok: true, text: t };
                }
            }
            // 模糊匹配
            for (const el of all) {
                const t = (el.innerText || el.textContent || '').trim();
                if (t.includes('视频生成') && t.length < 20 && el.offsetParent !== null) {
                    el.click();
                    return { ok: true, text: t };
                }
            }
            // .pyd: 也尝试包含 Seedance 的入口
            for (const el of all) {
                const t = (el.innerText || el.textContent || '').trim();
                if (t.includes('Seedance') && t.includes('视频') && el.offsetParent !== null) {
                    el.click();
                    return { ok: true, text: t };
                }
            }
            return { ok: false, reason: 'no mode trigger found' };
        });

        console.log(`[即梦] playwright: '视频生成' option click result: ${JSON.stringify(clickResult)}`);

        if (clickResult.ok) {
            await _randomDelay(2000, 3000);
            const newMode = await _detectBarMode(page);
            console.log(`[即梦] playwright: bar mode after switch: ${newMode}`);
            if (newMode === 'video_mode') return;
        }

        await _randomDelay(1000, 1500);
    }

    // .pyd: PLUGIN_ERROR:::无法切换到视频生成模式
    console.error('[即梦] playwright: FAILED to switch to video mode after 3 attempts');
}

/**
 * 检测底部栏的参考模式（首尾帧 / 全能参考）
 * .pyd: 在底部栏切换 首尾帧 / 全能参考 模式
 *
 * 检测逻辑: 找到文本为 '首尾帧' 或 '全能参考' 的元素，
 * 通过 active/selected class、aria-selected、fontWeight 判断哪个被选中
 */
async function _detectReferenceMode(page) {
    return await page.evaluate(() => {
        // 优先：读取 option-label 元素的文字（下拉选择器当前显示的值）
        const labels = document.querySelectorAll('.lv-typography[class*="option-label"]');
        for (const el of labels) {
            const text = el.textContent?.trim();
            if (text === '全能参考') return 'omni_reference';
            if (text === '首尾帧') return 'first_end_frame';
        }

        // fallback: 扫描所有可见元素
        const allEls = document.querySelectorAll('span, div, button, label, [role="tab"]');
        const foundModes = [];

        for (const el of allEls) {
            const text = (el.textContent || '').trim();
            if (text === '首尾帧' || text === '全能参考') {
                const cls = el.className || '';
                const parentCls = el.parentElement?.className || '';
                const isActive = cls.includes('active') || cls.includes('selected') ||
                    parentCls.includes('active') || parentCls.includes('selected') ||
                    el.getAttribute('aria-selected') === 'true' ||
                    el.getAttribute('data-active') === 'true';
                const style = window.getComputedStyle(el);
                const isBold = parseInt(style.fontWeight) >= 600;
                const color = style.color;
                const opacity = parseFloat(style.opacity);
                const isHighlighted = opacity === 1 || (color && !color.includes('128'));

                foundModes.push({ text, isActive: isActive || isBold || isHighlighted });
            }
        }

        const active = foundModes.find(m => m.isActive);
        if (active) return active.text === '全能参考' ? 'omni_reference' : 'first_end_frame';
        if (foundModes.length > 0) return 'unknown_active';
        return 'no_tabs_found';
    });
}

/**
 * 切换底部栏的参考模式
 * .pyd: _pw_switch_reference_mode → '在底部栏切换 首尾帧 / 全能参考 模式'
 * 最多重试3次
 */
async function _switchReferenceMode(page, targetMode) {
    const targetText = targetMode === 'omni_reference' ? '全能参考' : '首尾帧';

    const currentMode = await _detectReferenceMode(page);
    console.log(`[即梦] playwright: switching reference mode to '${targetText}', current=${currentMode}`);

    if (currentMode === targetMode) {
        console.log(`[即梦] 已在 ${targetText} 模式`);
        return;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
        console.log(`[即梦] playwright: mode trigger click (attempt ${attempt + 1})`);

        // 第一步：点击当前模式的下拉触发器（展开选项菜单）
        const triggerClicked = await page.evaluate(() => {
            // 找到 option-label 元素（当前显示的模式文字，如"首尾帧"）
            const labels = document.querySelectorAll('.lv-typography[class*="option-label"]');
            for (const el of labels) {
                const text = el.textContent?.trim();
                if (text === '首尾帧' || text === '全能参考') {
                    // 点击它或它的父容器来展开下拉
                    const clickTarget = el.closest('[class*="option"]') || el.parentElement || el;
                    clickTarget.click();
                    return { ok: true, currentText: text };
                }
            }
            // fallback: 找任何包含这两个文字的可见元素
            const els = document.querySelectorAll('div, span, button');
            for (const el of els) {
                const text = el.textContent?.trim();
                if ((text === '首尾帧' || text === '全能参考') && el.offsetParent !== null && el.children.length === 0) {
                    el.click();
                    return { ok: true, currentText: text };
                }
            }
            return { ok: false };
        });

        console.log(`[即梦] playwright: trigger dropdown: ${JSON.stringify(triggerClicked)}`);

        if (!triggerClicked.ok) {
            await _randomDelay(500, 1000);
            continue;
        }

        await _randomDelay(500, 800);

        // 第二步：在弹出的下拉菜单中选择目标模式
        const selected = await page.evaluate((target) => {
            // 在弹出的 popup/dropdown/overlay 中找目标文字
            const candidates = document.querySelectorAll(
                '[class*="popup"] *, [class*="dropdown"] *, [class*="overlay"] *, ' +
                '[class*="select-popup"] *, [class*="option"] *, [role="option"], [role="listbox"] *, li'
            );
            for (const el of candidates) {
                const text = el.textContent?.trim();
                if (text === target && el.offsetParent !== null) {
                    el.click();
                    return { ok: true, method: 'popup' };
                }
            }
            // fallback: 找所有 lv-typography 中匹配的
            const typos = document.querySelectorAll('.lv-typography');
            for (const el of typos) {
                if (el.textContent?.trim() === target) {
                    const clickTarget = el.closest('[class*="option"]') || el.parentElement || el;
                    clickTarget.click();
                    return { ok: true, method: 'typography' };
                }
            }
            return { ok: false };
        }, targetText);

        console.log(`[即梦] playwright: select mode option: ${JSON.stringify(selected)}`);

        if (selected.ok) {
            await _randomDelay(800, 1200);
            const newMode = await _detectReferenceMode(page);
            console.log(`[即梦] playwright: bar mode after switch: ${newMode}`);
            if (newMode === targetMode) {
                console.log(`[即梦] 已切换到 ${targetText} 模式`);
                return;
            }
        }
        await _randomDelay(500, 1000);
    }

    console.log(`[即梦] 全能参考 tab not found, may already be on it or page structure changed`);
}

/**
 * 选择底部栏的模型（Seedance 2.0 / 2.0 Fast）
 * .pyd: _model_click_map / _model_value_map / _model_display_map
 *
 * 即梦底部栏有一个 lv-select 下拉框显示当前模型名称，
 * 点击后展开选项列表，再点击目标模型。
 */
async function _selectModel(page, modelKey) {
    const modelConfig = CONFIG.models[modelKey];
    if (!modelConfig) {
        console.log(`[即梦] 未知模型: ${modelKey}, 使用默认`);
        return;
    }
    const targetModel = modelConfig.clickText;
    console.log(`[即梦] playwright: selecting model: ${targetModel}`);

    // 检查当前模型是否已经是目标
    const currentModel = await page.evaluate(() => {
        // 从 lv-select-view-value 中只取直接文本节点（跳过 SVG 内容）
        const vals = document.querySelectorAll('.lv-select-view-value');
        for (const v of vals) {
            let directText = '';
            for (const node of v.childNodes) {
                if (node.nodeType === 3) directText += node.textContent;
            }
            directText = directText.trim();
            if (directText.includes('Seedance')) return directText;
        }
        // fallback: innerText 规范化空白
        for (const v of vals) {
            const t = (v.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.includes('Seedance')) return t;
        }
        return null;
    });

    console.log(`[即梦] 当前模型: [${currentModel}]`);
    console.log(`[即梦] 目标模型: [${targetModel}]`);
    // 精确比较（防止 "Seedance 2.0 Fast" 误匹配 "Seedance 2.0"）
    if (currentModel && currentModel.trim() === targetModel.trim()) {
        // 防止页面未完全渲染导致误判：等待1.5秒后重新读取确认
        // 例如 "Seedance 2.0 Fast" 先渲染为 "Seedance 2.0"，延迟后才出现 "Fast"
        await new Promise(r => setTimeout(r, 1500));
        const recheck = await page.evaluate(() => {
            const vals = document.querySelectorAll('.lv-select-view-value');
            for (const v of vals) {
                let directText = '';
                for (const node of v.childNodes) {
                    if (node.nodeType === 3) directText += node.textContent;
                }
                directText = directText.trim();
                if (directText.includes('Seedance')) return directText;
            }
            for (const v of vals) {
                const t = (v.innerText || '').replace(/\s+/g, ' ').trim();
                if (t.includes('Seedance')) return t;
            }
            return null;
        });
        console.log(`[即梦] 模型二次确认: [${recheck}]`);
        if (recheck && recheck.trim() === targetModel.trim()) {
            console.log(`[即梦] 模型确认是 ${targetModel}，无需切换`);
            return;
        }
        console.log(`[即梦] 模型从 [${currentModel}] 变为 [${recheck}]，需要切换`);
    }

    // 点击 lv-select 打开下拉
    const selectorClicked = await page.evaluate(() => {
        // .pyd: 查找包含 Seedance 的 lv-select，点击 trigger
        const selects = document.querySelectorAll('[role="combobox"].lv-select, .lv-select');
        for (const sel of selects) {
            const valSpan = sel.querySelector('.lv-select-view-value');
            if (!valSpan) continue;
            const text = (valSpan.innerText || valSpan.textContent || '').trim();
            if (text.includes('Seedance')) {
                const trigger = sel.querySelector('.lv-select-view-selector') || sel;
                trigger.click();
                return { ok: true, text, method: 'lv-select-trigger' };
            }
        }
        // Fallback: 直接查找并点击 lv-select-view-value
        const vals = document.querySelectorAll('.lv-select-view-value');
        for (const v of vals) {
            const t = (v.innerText || '').trim();
            if (t.includes('Seedance')) { v.click(); return { ok: true, text: t, method: 'lv-select-value' }; }
        }
        return { ok: false };
    });

    console.log(`[即梦] playwright: model selector click result: ${JSON.stringify(selectorClicked)}`);
    if (!selectorClicked.ok) {
        console.log('[即梦] 未找到模型选择器');
        return;
    }

    await _randomDelay(500, 800);

    // 在下拉选项中精确匹配目标模型
    const selected = await page.evaluate((target) => {
        // 方法0: div[class*="option-label-pa"] 精确匹配（即梦新版 DOM 结构）
        const optLabels = document.querySelectorAll('div[class*="option-label-pa"]');
        for (const el of optLabels) {
            const t = (el.innerText || '').trim().split('\n')[0].trim();
            if (t === target && el.offsetParent !== null) {
                const clickTarget = el.closest('li') || el.closest('[class*="option"]') || el;
                clickTarget.click();
                return { ok: true, text: t, method: 'option-label-pa' };
            }
        }
        // 方法1: 精确匹配 li.lv-select-option 的首行文本
        const lis = document.querySelectorAll('li.lv-select-option');
        for (const li of lis) {
            const t = (li.innerText || '').trim().split('\n')[0].trim();
            if (t === target && li.offsetParent !== null) {
                li.click();
                return { ok: true, text: t, method: 'li-exact' };
            }
        }
        // 方法2: img[alt] 精确匹配，点击 closest li
        const imgs = document.querySelectorAll('img[alt]');
        for (const img of imgs) {
            if (img.alt === target && img.offsetParent !== null) {
                const li = img.closest('li');
                if (li) { li.click(); return { ok: true, text: img.alt, method: 'img-alt-li' }; }
            }
        }
        // 方法3: 任何包含目标文本的可见元素
        const all = document.querySelectorAll('[role="option"], li, [class*="option"]');
        for (const el of all) {
            const t = (el.innerText || '').trim().split('\n')[0].trim();
            if (t === target && el.offsetParent !== null) {
                el.click();
                return { ok: true, text: t, method: 'fallback' };
            }
        }
        return { ok: false };
    }, targetModel);

    console.log(`[即梦] playwright: model selection: ${JSON.stringify(selected)}`);
    if (selected.ok) {
        await _randomDelay(800, 1200);
    } else {
        console.log(`[即梦] 未能选中模型 ${targetModel}，按 Escape 关闭下拉`);
        await page.keyboard.press('Escape');
        await _randomDelay(300, 500);
    }

    // 验证模型是否真的切换成功
    const afterModel = await page.evaluate(() => {
        const vals = document.querySelectorAll('.lv-select-view-value');
        for (const v of vals) {
            const t = (v.innerText || v.textContent || '').trim();
            const match = t.match(/(Seedance\s+[\d.]+(?:\s+Fast)?)/i);
            if (match) return match[1].trim();
            if (t.includes('Seedance')) return t;
        }
        return null;
    });
    console.log(`[即梦] 模型选择后验证: 当前=[${afterModel}], 目标=[${targetModel}]`);

    if (afterModel && afterModel.trim() !== targetModel.trim()) {
        console.log(`[即梦] 模型未切换成功，重试一次...`);
        // 重试：再次点击选择器
        await page.evaluate(() => {
            const vals = document.querySelectorAll('.lv-select-view-value');
            for (const v of vals) {
                const t = (v.innerText || '').trim();
                if (t.includes('Seedance')) { v.click(); return; }
            }
        });
        await _randomDelay(600, 1000);

        // 重试选择 - 这次尝试点击所有可能的元素直到成功
        const retry = await page.evaluate((target) => {
            // 尝试1: 找 img[alt] 然后点击各层父元素
            const imgs = document.querySelectorAll('img[alt]');
            for (const img of imgs) {
                if (img.alt === target && img.offsetParent !== null) {
                    // 逐层向上尝试点击
                    let el = img.parentElement;
                    for (let i = 0; i < 5 && el; i++) {
                        el.click();
                        el = el.parentElement;
                    }
                    return { ok: true, method: 'retry-img-bubble' };
                }
            }
            // 尝试2: 找包含目标文本的 option 类元素
            const all = document.querySelectorAll('[class*="option"], li, [role="option"]');
            for (const el of all) {
                const t = (el.innerText || '').trim().split('\n')[0].trim();
                if (t === target && el.offsetParent !== null) {
                    el.click();
                    return { ok: true, method: 'retry-option-el', text: t };
                }
            }
            return { ok: false };
        }, targetModel);
        console.log(`[即梦] 模型重试结果: ${JSON.stringify(retry)}`);
        await _randomDelay(800, 1200);

        // 最终验证
        const finalModel = await page.evaluate(() => {
            const vals = document.querySelectorAll('.lv-select-view-value');
            for (const v of vals) {
                const t = (v.innerText || v.textContent || '').trim();
                const match = t.match(/(Seedance\s+[\d.]+(?:\s+Fast)?)/i);
                if (match) return match[1].trim();
            }
            return null;
        });
        console.log(`[即梦] 模型最终验证: [${finalModel}]`);
    }
}

/**
 * 全能参考模式: 上传参考图片（使其可被 @ 引用）
 * 先点击"参考内容"/"+"区域，再通过 file input 上传
 */
async function _uploadReferenceImageForOmni(page, imagePath) {
    if (!imagePath || !fs.existsSync(imagePath)) {
        console.log(`[即梦] 全能参考: 跳过上传, path=${imagePath}, exists=${imagePath ? fs.existsSync(imagePath) : false}`);
        return false;
    }

    console.log(`[即梦] 全能参考: 上传参考图 ${imagePath}`);

    // 直接找 reference-upload 容器内的 file input
    // DOM: div.reference-upload-xxx > input[type="file"].file-input-xxx
    const fileInput = await page.$('div[class*="reference-upload"] input[type="file"]');
    if (fileInput) {
        await fileInput.uploadFile(imagePath);
        console.log('[即梦] 全能参考: 参考图已上传 (reference-upload file input)');
        await _randomDelay(1500, 2500);
        return true;
    }

    // fallback: 任何 file input（不限 accept，音频文件也需要上传）
    const anyFileInput = await page.$('input[type="file"]');
    if (anyFileInput) {
        await anyFileInput.uploadFile(imagePath);
        console.log('[即梦] 全能参考: 参考图已上传 (fallback file input)');
        await _randomDelay(1500, 2500);
        return true;
    }

    // fallback2: 点击参考内容区域触发 fileChooser
    console.log('[即梦] 全能参考: 未找到 file input，尝试点击参考内容区域');
    try {
        const uploadArea = await page.$('div[class*="reference-upload"]');
        if (uploadArea) {
            const [fileChooser] = await Promise.all([
                page.waitForFileChooser({ timeout: 5000 }),
                uploadArea.click(),
            ]);
            await fileChooser.accept([imagePath]);
            console.log('[即梦] 全能参考: 参考图已上传 (fileChooser)');
            return true;
        } else {
            console.error('[即梦] 全能参考: 未找到上传区域');
        }
    } catch (e) {
        console.error('[即梦] 全能参考: 参考图上传失败:', e.message);
    }
    return false;
}

/**
 * 构建结构化提示词（全能参考模式）
 * .pyd: _pw_set_structured_prompt_with_refs
 * 
 * 真实流程（从 .pyd 逆向）:
 *   1. 清空文本输入框
 *   2. 对每张参考图: 点 @ 按钮 → 从下拉选图 → keyboard.type(" 这是{label}")
 *   3. 最后 keyboard.type(用户提示词)
 *
 * @ 按钮的 class: lv-btn-icon-only + lv-btn-secondary + lv-btn-shape-square
 * 最终效果: @图片1 这是韩秀景 @图片2 这是宫殿寝室 用户提示词...
 * 
 * @param {Page} page 
 * @param {string} userPrompt - 用户的原始提示词
 * @param {string[]} refLabels - 每张参考图的标签 ['首帧图片', '尾帧图片', '人物xxx']
 */

/**
 * 分段输入文本（避免 keyboard.type 长文本时丢字符）
 * 每 100 字符一段，段间加延迟
 */
async function _typeTextInChunks(page, text, charDelay = 10, chunkSize = 200) {
    // 使用 execCommand('insertText') 直接插入，绕过 IME 吞字符问题
    // 分段插入避免一次性插入过长文本导致编辑器卡顿
    for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.substring(i, Math.min(i + chunkSize, text.length));
        const inserted = await page.evaluate((t) => {
            const el = document.activeElement;
            if (el && (el.contentEditable === 'true' || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
                // 方法1: execCommand insertText（最兼容 contenteditable）
                const ok = document.execCommand('insertText', false, t);
                if (ok) return 'execCommand';
                // 方法2: 直接操作 selection + insertNode
                const sel = window.getSelection();
                if (sel && sel.rangeCount > 0) {
                    const range = sel.getRangeAt(0);
                    range.deleteContents();
                    const textNode = document.createTextNode(t);
                    range.insertNode(textNode);
                    range.setStartAfter(textNode);
                    range.setEndAfter(textNode);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    // 触发 input 事件让编辑器感知变化
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    return 'insertNode';
                }
            }
            return null;
        }, chunk);

        if (!inserted) {
            // fallback: 用 keyboard.type（可能丢字符但总比没有好）
            console.log('[即梦] execCommand 失败，fallback 到 keyboard.type');
            await page.keyboard.type(chunk, { delay: charDelay });
        }

        if (i + chunkSize < text.length) {
            await _randomDelay(30, 80);
        }
    }
}

async function _setStructuredPromptWithRefs(page, userPrompt, refLabels = [], voiceLabels = new Set(), picRefMap = null, refMode = 'inline') {
    console.log(`[即梦] 构建结构化提示词(${refMode}模式): ${refLabels.length} 个参考图, ${voiceLabels.size} 个音色, 提示词长度=${userPrompt.length}, picRefMap=${picRefMap ? Object.keys(picRefMap).length + '个' : '无'}`);

    // 步骤1: 清空编辑器
    const editorType = await page.evaluate(() => {
        const editables = document.querySelectorAll('[contenteditable="true"]');
        for (const el of editables) {
            if (el.offsetParent) {
                el.focus();
                el.innerHTML = '';
                return 'contenteditable';
            }
        }
        const ta = document.querySelector('textarea[class*="prompt-textarea"], textarea[placeholder*="Seedance"], textarea');
        if (ta) {
            ta.focus();
            ta.value = '';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            return 'textarea';
        }
        return null;
    });

    if (!editorType) {
        console.error('[即梦] 未找到编辑器，直接用 _fillPrompt 兜底');
        await _fillPrompt(page, userPrompt);
        return;
    }
    console.log(`[即梦] 编辑器类型: ${editorType}, 已清空`);
    await _randomDelay(300, 500);

    // 确保编辑器有焦点（点击一下）
    await page.evaluate(() => {
        const editable = document.querySelector('[contenteditable="true"]');
        if (editable && editable.offsetParent) { editable.click(); editable.focus(); return; }
        const ta = document.querySelector('textarea[class*="prompt-textarea"], textarea[placeholder*="Seedance"], textarea');
        if (ta) { ta.click(); ta.focus(); }
    });
    await _randomDelay(200, 300);

    // 步骤2: 构建 label→下拉编号 映射（即梦按类型分开编号：图片1/2/3 + 音频1）
    const labelToIndex = {}; // { "韩秀晶": 3, "韩秀晶参考音色": 4 } — 顺序索引，用于排序
    const labelToDropdown = {}; // { "韩秀晶": ["图片3"], "韩秀晶参考音色": ["音频1"] } — 实际下拉搜索词
    let imgCount = 0, audioCount = 0;
    for (let i = 0; i < refLabels.length; i++) {
        labelToIndex[refLabels[i]] = i + 1;
        if (voiceLabels.has(refLabels[i])) {
            audioCount++;
            labelToDropdown[refLabels[i]] = [`音频${audioCount}`, `文件${audioCount}`, `图片${i + 1}`];
        } else {
            imgCount++;
            labelToDropdown[refLabels[i]] = [`图片${imgCount}`, `文件${imgCount}`];
        }
    }
    console.log(`[即梦] 下拉编号映射: 图片${imgCount}个, 音频${audioCount}个`);

    // 步骤3: 扫描提示词，找到所有🖼图片N和角色名的位置
    const occurrences = []; // [{ pos, label, imageIndex, isPicRef, consumeLength }]

    // 3a: 扫描🖼图片N（每次出现都@引用，替代角色名）
    if (picRefMap && Object.keys(picRefMap).length > 0) {
        for (const [picTag, charName] of Object.entries(picRefMap)) {
            // picTag = "🖼图片1", charName = "陈思"
            const dropdownTargets = labelToDropdown[charName];
            if (!dropdownTargets) {
                console.log(`[即梦] 🖼图片映射: ${picTag} → ${charName} 未在上传列表中，跳过`);
                continue;
            }
            let searchFrom = 0;
            while (true) {
                const pos = userPrompt.indexOf(picTag, searchFrom);
                if (pos === -1) break;
                occurrences.push({
                    pos, label: charName, imageIndex: labelToIndex[charName],
                    isPicRef: true, consumeLength: picTag.length
                });
                searchFrom = pos + picTag.length;
            }
            console.log(`[即梦] 🖼图片映射: ${picTag} → ${charName} → ${dropdownTargets[0]}`);
        }
    }

    // 3b: 扫描角色名/场景名（每次出现都@引用并替换名字）
    // 构建额外匹配名：去掉 " - 服装名" 后缀（如 "韩秀晶 - 手术服" → 也尝试匹配 "韩秀晶"）
    const labelAliases = {}; // { label: [alias1, alias2, ...] }
    for (const label of refLabels) {
        if (!label) continue;
        const aliases = [];
        // 跳过含||的标签（定位图等带附加数据的标签，不做别名匹配）
        if (!label.includes('||')) {
            // 去掉 " - xxx" 后缀（角色服装）
            const dashIdx = label.indexOf(' - ');
            if (dashIdx > 0) {
                aliases.push(label.substring(0, dashIdx).trim());
            }
            // 去掉 "xxx " 前缀空格分隔的场景全名（如 "首尔大学附属医院手术室" 也尝试匹配 "手术室"）
            // 不对短于4字的label做拆分
            if (label.length > 4 && !label.includes(' - ')) {
                // 尝试最后2-4个字作为短名（常见场景名如"手术室""客厅""卧室"）
                for (let suffixLen = 2; suffixLen <= Math.min(4, label.length - 1); suffixLen++) {
                    const suffix = label.substring(label.length - suffixLen);
                    if (suffix !== label) aliases.push(suffix);
                }
            }
        }
        labelAliases[label] = aliases;
    }
    console.log(`[即梦] 别名映射:`, Object.entries(labelAliases).filter(([,v]) => v.length > 0).map(([k,v]) => `${k} → [${v.join(', ')}]`).join('; '));

    for (const label of refLabels) {
        if (!label) continue;
        // 先尝试完整label匹配
        let searchFrom = 0;
        while (true) {
            const pos = userPrompt.indexOf(label, searchFrom);
            if (pos === -1) break;
            occurrences.push({ pos, label, imageIndex: labelToIndex[label], isPicRef: false, consumeLength: label.length });
            searchFrom = pos + label.length;
        }
        // 再尝试别名匹配（仅匹配完整label未命中的位置）
        const aliases = labelAliases[label] || [];
        for (const alias of aliases) {
            if (!alias || alias.length < 2) continue;
            let aliasFrom = 0;
            while (true) {
                const pos = userPrompt.indexOf(alias, aliasFrom);
                if (pos === -1) break;
                // 检查此位置是否已被完整label覆盖
                const alreadyCovered = occurrences.some(o => pos >= o.pos && pos < o.pos + o.consumeLength);
                if (!alreadyCovered) {
                    occurrences.push({ pos, label, imageIndex: labelToIndex[label], isPicRef: false, consumeLength: alias.length });
                }
                aliasFrom = pos + alias.length;
            }
        }
    }

    // 按位置排序，同位置时🖼图片优先（它会消费文本），然后长标签优先
    occurrences.sort((a, b) => a.pos - b.pos || (b.isPicRef ? 1 : 0) - (a.isPicRef ? 1 : 0) || b.label.length - a.label.length);

    // 去重重叠（如果两个标签在同一位置区间重叠，保留🖼图片引用或较长的那个）
    const deduped = [];
    let lastEnd = -1;
    for (const occ of occurrences) {
        const occEnd = occ.pos + (occ.isPicRef ? occ.consumeLength : occ.label.length);
        if (occ.pos >= lastEnd) {
            deduped.push(occ);
            lastEnd = occEnd;
        }
    }

    // 过滤：所有名字引用每次都@并替换
    // refMode === 'header' 时强制置空 filtered，使其走 filtered.length===0 的分支
    // 该分支会将所有参考图以 @图片1 @图片2 ... 形式统一放在提示词开头，不做内联替换
    const filtered = refMode === 'header' ? [] : [...deduped];
    const nameRefCount = filtered.filter(f => !f.isPicRef).length;
    const picRefCount = filtered.filter(f => f.isPicRef).length;
    console.log(`[即梦] @引用: ${deduped.length}处匹配 → ${filtered.length}处引用 (名字替换${nameRefCount}处, 🖼图片${picRefCount}处)`);

    // 打印匹配详情
    for (const label of refLabels) {
        const firstPos = userPrompt.indexOf(label);
        console.log(`[即梦] label匹配: "${label}" → ${firstPos >= 0 ? '找到(pos=' + firstPos + ')' : '未找到'}`);
    }
    console.log(`[即梦] 提示词中找到 ${filtered.length} 处@引用点`);

    // 记录哪些图片在提示词中被引用过
    const referencedImages = new Set();

    if (filtered.length === 0) {
        // 没有匹配到任何角色名，回退到旧模式：先在开头 @引用所有图片，再输入提示词
        console.log('[即梦] 提示词中未匹配到角色名，回退到开头引用模式');
        for (let i = 0; i < refLabels.length; i++) {
            const isVoice = voiceLabels.has(refLabels[i]);
            if (isVoice) {
                // 音色引用：角色名+参考音色@音频N
                const charName = refLabels[i].replace('参考音色', '').trim();
                await page.evaluate((t) => {
                    document.execCommand('insertText', false, t);
                }, `${charName}参考音色`);
                await _randomDelay(100, 200);
            }
            const ok = await _clickAtButtonAndSelect(page, i + 1, labelToDropdown[refLabels[i]]);
            if (ok) {
                if (!isVoice) {
                    await page.evaluate((t) => {
                        document.execCommand('insertText', false, t);
                    }, ` 这是${refLabels[i]}`);
                } else {
                    await page.evaluate(() => {
                        document.execCommand('insertText', false, ' ');
                    });
                }
                await _randomDelay(200, 400);
            }
        }
        // 前缀引用后直接继续输入，不插入换行（避免触发即梦编辑器的提交快捷键）
        // 确保编辑器重新获得焦点（@按钮操作可能导致失焦）
        await page.evaluate(() => {
            const editable = document.querySelector('[contenteditable="true"]');
            if (editable && editable.offsetParent) {
                editable.focus();
                // 将光标移到末尾
                const sel = window.getSelection();
                if (sel) {
                    sel.selectAllChildren(editable);
                    sel.collapseToEnd();
                }
            }
        });
        await _randomDelay(100, 200);
        await _typeTextInChunks(page, userPrompt);
    } else {
        // 预判哪些图片不会在提示词中内联匹配（如场景定位图）
        const inlineMatchedIndices = new Set(filtered.map(f => f.imageIndex));
        const prefixRefs = refLabels
            .map((label, i) => ({ label, index: i + 1 }))
            .filter(item => !inlineMatchedIndices.has(item.index));

        // 步骤4a: 先在开头 @引用未内联匹配的参考图（如场景定位图）
        if (prefixRefs.length > 0) {
            console.log(`[即梦] ${prefixRefs.length} 张参考图未在提示词中匹配，在开头引用`);
            for (const item of prefixRefs) {
                // 判断是否为布局定位图
                const isLayoutImg = item.label.includes('布局定位图') || item.label.includes('空间定位') || item.label.includes('定位图');
                const isPrevizImg = item.label.includes('3D预演') || item.label.includes('预演构图');
                if (isPrevizImg) {
                    // 3D预演构图参考：先输入"通过"，再@引用，再输入说明文字
                    await page.evaluate(() => {
                        document.execCommand('insertText', false, '通过');
                    });
                    await _randomDelay(100, 200);
                    const ok = await _clickAtButtonAndSelect(page, item.index, labelToDropdown[item.label]);
                    if (ok) {
                        referencedImages.add(item.index);
                    }
                    await page.evaluate(() => {
                        document.execCommand('insertText', false, '了解镜头构图和角色站位(3D预演线稿 仅参考构图和人物位置 不要模仿画风) ');
                    });
                } else if (isLayoutImg) {
                    // 布局定位图：先输入"通过"，再@引用，再输入说明文字（不换行，直接连续写）
                    // 从label中提取colorLegend（格式：定位图名||🔴红色(主角)=韩秀晶 🟢绿色(配角)=护士A ...）
                    let layoutLegendText = '红色人影=主角 绿色人影=配角 黑色人影=群演';
                    const legendSep = item.label.indexOf('||');
                    if (legendSep > 0) {
                        const rawLegend = item.label.substring(legendSep + 2).trim();
                        if (rawLegend) {
                            // 转换格式：🔴红色(主角)=韩秀晶 → 红色人影=韩秀晶
                            layoutLegendText = rawLegend
                                .replace(/🔴\s*/g, '').replace(/🟢\s*/g, '').replace(/⚫\s*/g, '')
                                .replace(/红色\(主角\)/g, '红色人影').replace(/绿色\(配角\)/g, '绿色人影').replace(/黑色\(群演\)/g, '黑色人影');
                            console.log(`[即梦] 定位图颜色图例: ${layoutLegendText}`);
                        }
                    }
                    await page.evaluate(() => {
                        document.execCommand('insertText', false, '通过');
                    });
                    await _randomDelay(100, 200);
                    const ok = await _clickAtButtonAndSelect(page, item.index, labelToDropdown[item.label]);
                    if (ok) {
                        referencedImages.add(item.index);
                    }
                    // 构建定位图描述，角色名用@图片N替换
                    const fullLayoutText = `了解场景内布局跟人物站位(${layoutLegendText}) 不要显示文字内容，`;
                    const layoutOccs = [];
                    for (const rl of refLabels) {
                        if (!rl || rl.includes('||')) continue;
                        const names = [rl, ...(labelAliases[rl] || [])];
                        for (const nm of names) {
                            if (!nm || nm.length < 2) continue;
                            let from = 0;
                            while (true) {
                                const p = fullLayoutText.indexOf(nm, from);
                                if (p === -1) break;
                                const covered = layoutOccs.some(o => p >= o.pos && p < o.pos + o.len);
                                if (!covered) layoutOccs.push({ pos: p, len: nm.length, label: rl });
                                from = p + nm.length;
                            }
                        }
                    }
                    layoutOccs.sort((a, b) => a.pos - b.pos);
                    // 去重重叠
                    const layoutDedup = [];
                    let lEnd = -1;
                    for (const o of layoutOccs) { if (o.pos >= lEnd) { layoutDedup.push(o); lEnd = o.pos + o.len; } }

                    if (layoutDedup.length > 0) {
                        console.log(`[即梦] 定位图描述中 ${layoutDedup.length} 处角色名将用@图片替换`);
                        let lCursor = 0;
                        for (const o of layoutDedup) {
                            if (o.pos > lCursor) {
                                await page.evaluate(t => { document.execCommand('insertText', false, t); }, fullLayoutText.substring(lCursor, o.pos));
                                await _randomDelay(50, 100);
                            }
                            const refOk = await _clickAtButtonAndSelect(page, labelToIndex[o.label], labelToDropdown[o.label]);
                            if (refOk) referencedImages.add(labelToIndex[o.label]);
                            lCursor = o.pos + o.len;
                            await _randomDelay(50, 100);
                        }
                        if (lCursor < fullLayoutText.length) {
                            await page.evaluate(t => { document.execCommand('insertText', false, t); }, fullLayoutText.substring(lCursor));
                        }
                    } else {
                        await page.evaluate(t => { document.execCommand('insertText', false, t); }, fullLayoutText);
                    }
                } else if (voiceLabels.has(item.label)) {
                    // 音色引用：角色名+参考音色@音频N，（只在开头引用一次，不污染正文）
                    const charName = item.label.replace('参考音色', '').trim();
                    await page.evaluate((t) => {
                        document.execCommand('insertText', false, t);
                    }, `${charName}参考音色`);
                    await _randomDelay(100, 200);
                    const ok = await _clickAtButtonAndSelect(page, item.index, labelToDropdown[item.label]);
                    if (ok) {
                        referencedImages.add(item.index);
                    }
                    await page.evaluate(() => {
                        document.execCommand('insertText', false, ' ');
                    });
                } else {
                    // 非定位图、非音色：保持原有逻辑
                    const ok = await _clickAtButtonAndSelect(page, item.index, labelToDropdown[item.label]);
                    if (ok) {
                        referencedImages.add(item.index);
                    }
                    await page.evaluate((t) => {
                        document.execCommand('insertText', false, t);
                    }, ` 这是${item.label}`);
                }
                await _randomDelay(200, 400);
            }
            // 前缀引用后直接继续输入，不插入换行（避免触发即梦编辑器的提交快捷键）
            // 确保编辑器重新获得焦点（@按钮操作可能导致失焦）
            await page.evaluate(() => {
                const editable = document.querySelector('[contenteditable="true"]');
                if (editable && editable.offsetParent) {
                    editable.focus();
                    const sel = window.getSelection();
                    if (sel) {
                        sel.selectAllChildren(editable);
                        sel.collapseToEnd();
                    }
                }
            });
            await _randomDelay(100, 200);
        }

        // 步骤4b: 按切片交替输入文本和内联 @引用
        let cursor = 0;
        for (const occ of filtered) {
            // 输入引用点之前的文本片段
            if (occ.pos > cursor) {
                const textBefore = userPrompt.substring(cursor, occ.pos);
                await _typeTextInChunks(page, textBefore);
                await _randomDelay(100, 200);
            }

            if (occ.isPicRef) {
                // 🖼图片N引用：只插入@图片引用，消费掉🖼图片N文本（不输出角色名）
                const ok = await _clickAtButtonAndSelect(page, occ.imageIndex, labelToDropdown[occ.label]);
                if (ok) referencedImages.add(occ.imageIndex);
                cursor = occ.pos + occ.consumeLength; // 跳过🖼图片N文本
            } else {
                const isVoiceRef = voiceLabels.has(occ.label);
                if (isVoiceRef) {
                    // 音色引用：先输入标签文本，再@引用（结果：韩秀晶参考音色@文件N）
                    await page.evaluate((t) => {
                        document.execCommand('insertText', false, t);
                    }, occ.label);
                    await _randomDelay(100, 200);
                    const ok = await _clickAtButtonAndSelect(page, occ.imageIndex, labelToDropdown[occ.label]);
                    if (ok) referencedImages.add(occ.imageIndex);
                } else {
                    // 角色/场景/道具名引用：@图片N替换掉名字（结果：@图片N）
                    const ok = await _clickAtButtonAndSelect(page, occ.imageIndex, labelToDropdown[occ.label]);
                    if (ok) referencedImages.add(occ.imageIndex);
                }
                cursor = occ.pos + occ.consumeLength;
            }
            await _randomDelay(100, 200);
        }

        // 输入剩余的文本
        if (cursor < userPrompt.length) {
            const remaining = userPrompt.substring(cursor);
            console.log(`[即梦] 输入剩余文本: 长度=${remaining.length}, 末尾50字="${remaining.substring(remaining.length - 50)}"`);
            await _typeTextInChunks(page, remaining);
        }
    }

    console.log(`[即梦] structured prompt complete (${refMode} mode)`);
}

/**
 * 点击 @ 按钮并从下拉菜单中选择指定图片
 * @param {Page} page
 * @param {number} imageNumber - 图片编号（1-based，对应"图片1""图片2"...）
 */
async function _clickAtButtonAndSelect(page, imageNumber, dropdownTargets) {
    // 点击 @ 按钮
    const atClicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
            const cls = btn.className || '';
            if (cls.includes('lv-btn-icon-only') && cls.includes('lv-btn-secondary') && cls.includes('lv-btn-shape-square')) {
                btn.click();
                return true;
            }
        }
        for (const btn of buttons) {
            const text = btn.textContent?.trim();
            if (text === '@' && btn.offsetParent) {
                btn.click();
                return true;
            }
        }
        return false;
    });

    if (!atClicked) {
        console.log(`[即梦] @ 按钮未找到, 跳过图片${imageNumber}引用`);
        return false;
    }

    console.log(`[即梦] @ button click for 图片${imageNumber}`);
    await _randomDelay(500, 800);

    // 从下拉菜单中选择引用项（优先使用传入的精确目标列表）
    const possibleLabels = dropdownTargets || [`图片${imageNumber}`, `音频${imageNumber}`, `文件${imageNumber}`];
    const selected = await page.evaluate((targets, num) => {
        const candidates = document.querySelectorAll(
            '[class*="select-dropdown"] *, [class*="popup"] *, [class*="overlay"] *, ' +
            '[class*="select-popup"] *, li, [role="option"]'
        );
        // 第一轮：精确匹配任一标签（图片N/音频N/文件N）
        for (const target of targets) {
            for (const el of candidates) {
                const text = (el.innerText || el.textContent || '').trim();
                if (text === target && el.offsetParent !== null && el.children.length === 0) {
                    el.click();
                    return text;
                }
            }
        }
        // 第二轮：精确匹配（允许有子元素）
        for (const target of targets) {
            for (const el of candidates) {
                const text = (el.innerText || el.textContent || '').trim();
                if (text === target && el.offsetParent !== null) {
                    el.click();
                    return text;
                }
            }
        }
        // 第三轮：startsWith 任一标签
        for (const target of targets) {
            for (const el of candidates) {
                const text = (el.innerText || el.textContent || '').trim();
                if (text.startsWith(target) && text.length < target.length + 5 && el.offsetParent !== null && el.children.length === 0) {
                    el.click();
                    return text;
                }
            }
        }
        // 第四轮：按序号匹配 — 找到第N个带数字的下拉项
        const numberPattern = new RegExp(`${num}$`);
        for (const el of candidates) {
            const text = (el.innerText || el.textContent || '').trim();
            if (numberPattern.test(text) && text.length <= 6 && el.offsetParent !== null && el.children.length === 0) {
                el.click();
                return text;
            }
        }
        return null;
    }, possibleLabels, imageNumber);

    if (selected) {
        console.log(`[即梦] @ select '${selected}'`);
        await _randomDelay(300, 500);
        return true;
    } else {
        console.log(`[即梦] @ dropdown item not found for [图片/音频/文件${imageNumber}], pressing Escape to close dropdown`);
        await page.keyboard.press('Escape');
        await _randomDelay(300, 500);
        return false;
    }
}

/**
 * 首尾帧模式: 上传首帧（必填）+ 尾帧（可选）
 * .pyd: _pw_upload_frames
 * 
 * 使用 set_input_files (Puppeteer 的 uploadFile) 直接注入到 file input
 */
async function _uploadFrames(page, firstFramePath, endFramePath) {
    console.log(`[即梦] 首尾帧模式: 首帧=${firstFramePath}, 尾帧=${endFramePath || '无'}`);

    if (!firstFramePath || !fs.existsSync(firstFramePath)) {
        throw new Error('首尾帧模式需要首帧图片 (first_frame_path is required)');
    }

    // 找到所有 file input
    const fileInputs = await page.$$('input[type="file"]');
    console.log(`[即梦] 找到 ${fileInputs.length} 个 file input`);

    if (fileInputs.length === 0) {
        throw new Error('未找到文件上传输入框');
    }

    // 上传首帧（第一个 file input）
    await fileInputs[0].uploadFile(firstFramePath);
    console.log('[即梦] 首帧 set_input_files OK');
    await _randomDelay(2000, 3000);

    // 上传尾帧（第二个 file input，如果存在且提供了尾帧）
    if (endFramePath && fs.existsSync(endFramePath)) {
        if (fileInputs.length >= 2) {
            await fileInputs[1].uploadFile(endFramePath);
            console.log('[即梦] 尾帧 set_input_files OK');
            await _randomDelay(2000, 3000);
        } else {
            console.log('[即梦] only 1 file input found; end frame upload skipped');
        }
    }
}

/**
 * 确保图片为本地文件路径（base64/URL → 临时文件）
 */
async function _ensureLocalImage(imageUrl) {
    if (!imageUrl) return null;

    // 服务器相对路径（如 /images/xxx.jpg, /output/xxx, /voices/xxx.mp3）→ 转成本地绝对路径
    if (imageUrl.startsWith('/images/') || imageUrl.startsWith('/output/') || imageUrl.startsWith('/voices/') || imageUrl.startsWith('/model-cards/')) {
        const localPath = path.join(DATA_DIR, imageUrl);
        console.log(`[即梦] _ensureLocalImage: 相对路径 ${imageUrl} → ${localPath}, exists=${fs.existsSync(localPath)}`);
        return fs.existsSync(localPath) ? localPath : null;
    }

    if (imageUrl.match(/^[A-Z]:\\/)) {
        return fs.existsSync(imageUrl) ? imageUrl : null;
    } else if (imageUrl.startsWith('/') && !imageUrl.startsWith('//')) {
        // macOS/Linux 绝对路径
        return fs.existsSync(imageUrl) ? imageUrl : null;
    } else if (imageUrl.startsWith('data:')) {
        return _base64ToTempFile(imageUrl);
    } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        return await _downloadToTempFile(imageUrl);
    }
    return null;
}

/**
 * 填写提示词
 * 
 * 从 .pyd 逆向发现:
 * - 首尾帧模式: 使用 textarea
 * - 全能参考模式: 使用 contenteditable 编辑器
 * - _pw_try_set_prompt / _pw_type_with_ne
 */
async function _fillPrompt(page, prompt) {
    const S = CONFIG.selectors;

    // 策略1: textarea（首尾帧模式 + 部分页面版本）
    const textareaSelectors = [
        S.promptTextarea,       // textarea[class*="prompt-textarea"]
        S.promptTextareaAlt,    // textarea[placeholder*="Seedance"]
        'textarea',
    ];

    // 换行符替换为中文标点，避免在textarea中按Enter触发生成
    const safePrompt = prompt.replace(/\n{2,}/g, '。').replace(/\n/g, '；').replace(/[。；]{2,}/g, '。').trim();

    for (const sel of textareaSelectors) {
        try {
            const el = await page.$(sel);
            if (el) {
                await el.click();
                await _randomDelay(200, 400);
                await el.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await _randomDelay(100, 200);
                await el.type(safePrompt, { delay: 15 });
                console.log(`[即梦] 提示词已填写（textarea: ${sel}）`);
                return;
            }
        } catch (e) {
            continue;
        }
    }

    // 策略2: contenteditable 编辑器（全能参考模式）
    // .pyd: 'const editables = document.querySelectorAll('[contenteditable="true"]')'
    try {
        const filled = await page.evaluate((text) => {
            const editables = document.querySelectorAll('[contenteditable="true"]');
            for (const el of editables) {
                if (!el.offsetParent) continue;
                // 清空并输入
                el.focus();
                el.innerHTML = '';
                // 使用 insertText 命令（更接近真人输入，触发正确事件）
                const safeText = text.replace(/\n{2,}/g, '\u3002').replace(/\n/g, '\uff1b').replace(/[\u3002\uff1b]{2,}/g, '\u3002').trim();
                document.execCommand('insertText', false, safeText);
                return { ok: true, type: 'contenteditable' };
            }
            return { ok: false, reason: 'no editable found' };
        }, prompt);

        if (filled.ok) {
            console.log(`[即梦] 提示词已填写（${filled.type}）`);
            return;
        }
    } catch (e) {
        console.error('[即梦] contenteditable 输入失败:', e.message);
    }

    throw new Error('未找到提示词输入框（textarea 和 contenteditable 均未找到）');
}

/**
 * 上传参考图
 * 
 * 核心原理：
 * 网页上的图片上传本质是一个 <input type="file"> 元素。
 * Puppeteer 的 element.uploadFile(本地路径) 可以直接将文件注入到该元素，
 * 触发 change 事件，等同于用户手动选择文件，不会弹出文件选择框。
 * 
 * 但前端传来的可能是 base64 / HTTP URL / 本地路径，
 * 所以需要统一转成本地临时文件再上传。
 */
async function _uploadReferenceImage(page, imageUrl) {
    try {
        // 第一步：把图片源统一转为本地临时文件路径
        let localPath = null;

        if (imageUrl.match(/^[A-Z]:\\/) || (imageUrl.startsWith('/') && !imageUrl.startsWith('//'))) {
            // 已经是本地文件路径
            if (fs.existsSync(imageUrl)) {
                localPath = imageUrl;
            }
        } else if (imageUrl.startsWith('data:')) {
            // base64 → 临时文件
            localPath = _base64ToTempFile(imageUrl);
        } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
            // URL → 下载为临时文件
            localPath = await _downloadToTempFile(imageUrl);
        }

        if (!localPath) {
            console.log('[即梦] 无法获取参考图本地文件，跳过上传');
            return;
        }

        console.log(`[即梦] 参考图临时文件: ${localPath}`);

        // 第二步：找到页面上的 <input type="file"> 并注入文件
        const S = CONFIG.selectors;
        const fileInputSelectors = [
            S.fileInput,        // [class*="reference-upload"] input[type="file"]
            S.fileInputAlt,     // input[class*="file-input"]
            'input[type="file"][accept*="image"]',
            'input[type="file"]',
        ];

        let uploaded = false;
        for (const sel of fileInputSelectors) {
            const inputs = await page.$$(sel);
            if (inputs.length > 0) {
                // uploadFile 直接把文件路径注入，不弹对话框
                await inputs[0].uploadFile(localPath);
                console.log(`[即梦] 参考图已通过 uploadFile 注入（选择器: ${sel}）`);
                uploaded = true;
                break;
            }
        }

        if (!uploaded) {
            // fallback：尝试点击上传区域触发 file input
            console.log('[即梦] 未找到 file input，尝试点击上传区域...');
            const uploadSelectors = [
                '[class*="upload"]',
                '[class*="image-upload"]',
                '[class*="drop-zone"]',
            ];

            for (const sel of uploadSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el) {
                        // 点击后会触发一个新的 file input 或对话框
                        // 我们需要监听 filechooser 事件
                        const [fileChooser] = await Promise.all([
                            page.waitForFileChooser({ timeout: 5000 }),
                            el.click(),
                        ]);
                        await fileChooser.accept([localPath]);
                        console.log(`[即梦] 参考图已通过 fileChooser 上传（选择器: ${sel}）`);
                        uploaded = true;
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        // 等待上传完成（等待预览图出现或上传进度消失）
        if (uploaded) {
            await _randomDelay(2000, 3000);
            console.log('[即梦] 参考图上传流程完成');
        } else {
            console.log('[即梦] 未找到上传区域，跳过参考图');
        }

        // 清理临时文件
        if (localPath !== imageUrl) {
            try { fs.unlinkSync(localPath); } catch (e) { /* ignore */ }
        }

    } catch (error) {
        console.error('[即梦] 参考图上传失败:', error.message);
    }
}

/**
 * 将 base64 data URL 写入临时文件
 */
function _base64ToTempFile(dataUrl) {
    const matches = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) return null;

    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    const tmpPath = path.join(os.tmpdir(), `jimeng_ref_${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, buffer);
    console.log(`[即梦] base64 已写入临时文件: ${tmpPath} (${buffer.length} bytes)`);
    return tmpPath;
}

/**
 * 下载 URL 图片到临时文件
 */
function _downloadToTempFile(url) {
    return new Promise((resolve, reject) => {
        const ext = (url.match(/\.(jpg|jpeg|png|webp|gif)/i) || [, 'jpg'])[1];
        const tmpPath = path.join(os.tmpdir(), `jimeng_ref_${Date.now()}.${ext}`);
        const file = fs.createWriteStream(tmpPath);
        const client = url.startsWith('https') ? https : http;

        client.get(url, (response) => {
            // 跟随重定向
            if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                try { fs.unlinkSync(tmpPath); } catch {}
                _downloadToTempFile(response.headers.location).then(resolve).catch(reject);
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                console.log(`[即梦] URL 图片已下载: ${tmpPath}`);
                resolve(tmpPath);
            });
        }).on('error', (err) => {
            fs.unlinkSync(tmpPath);
            reject(err);
        });
    });
}

/**
 * 设置宽高比
 * .pyd: _pw_set_aspect_ratio → 支持 21:9, 16:9, 4:3, 1:1, 3:4, 9:16
 *
 * 即梦底部栏有一个比例选择区域，可能是：
 * 1. 直接可见的按钮组（每个比例一个按钮）
 * 2. 需要先点击当前比例/自动按钮展开 popup，再选择
 *
 * .pyd 逻辑: 先尝试直接点击，失败则打开 popup 再选
 */
async function _setAspectRatio(page, ratio) {
    try {
        // .pyd: aspect_ratio_options = '21:9,16:9,4:3,1:1,3:4,9:16'
        // 构建匹配关键词（兼容全角冒号）
        const keywords = [ratio, ratio.replace(':', '：')];
        console.log(`[即梦] playwright: setting aspect ratio to ${ratio}`);

        // 方法1: 直接在页面上找到比例按钮并点击
        for (const kw of keywords) {
            const found = await page.evaluate((text) => {
                const els = document.querySelectorAll('span, div, button, label, [role="radio"], [role="option"]');
                for (const el of els) {
                    const t = (el.textContent || '').trim();
                    if (t === text && el.offsetParent !== null) {
                        el.click();
                        return { ok: true, method: 'direct', text: t };
                    }
                }
                return { ok: false };
            }, kw);

            if (found.ok) {
                console.log(`[即梦] playwright: aspect ratio set: ${JSON.stringify(found)}`);
                return;
            }
        }

        // 方法2: .pyd 的 popup 机制 — 先点击当前比例按钮/自动按钮展开选项
        const popupOpened = await page.evaluate(() => {
            // 查找当前比例显示区域（通常显示 "自动" 或当前比例值）
            const triggers = document.querySelectorAll('button, div, span');
            for (const el of triggers) {
                const t = (el.textContent || '').trim();
                // .pyd: 匹配 "自动" 或已有比例值（如 "16:9"）
                if ((t === '自动' || /^\d+[：:]\d+$/.test(t)) && el.offsetParent !== null) {
                    // 确保这个元素在底部栏区域（y > 页面高度的60%）
                    const r = el.getBoundingClientRect();
                    if (r.y > window.innerHeight * 0.5) {
                        el.click();
                        return { ok: true, trigger: t };
                    }
                }
            }
            return { ok: false };
        });

        if (popupOpened.ok) {
            console.log(`[即梦] playwright: ratio popup opened via '${popupOpened.trigger}'`);
            await _randomDelay(500, 800);

            // 在 popup 中选择目标比例
            for (const kw of keywords) {
                const selected = await page.evaluate((text) => {
                    // popup 通常是浮层，查找所有可见的比例选项
                    const els = document.querySelectorAll('span, div, li, [role="option"], [role="radio"], [role="menuitem"]');
                    for (const el of els) {
                        const t = (el.textContent || '').trim();
                        if (t === text && el.offsetParent !== null) {
                            el.click();
                            return true;
                        }
                    }
                    return false;
                }, kw);

                if (selected) {
                    console.log(`[即梦] playwright: aspect ratio set via popup: ${ratio}`);
                    await _randomDelay(300, 500);
                    return;
                }
            }

            // 关闭 popup（点击空白处）
            await page.evaluate(() => document.body.click());
            await _randomDelay(200, 400);
        }

        console.log(`[即梦] playwright: aspect ratio option '${ratio}' not found, using default`);
    } catch (error) {
        console.error('[即梦] 设置宽高比失败:', error.message);
    }
}

/**
 * 设置视频时长
 * .pyd: _pw_set_duration → 通过 lv-select 组件精确操作
 *
 * 即梦底部栏有一个 lv-select 下拉框显示当前时长（如 "5s"），
 * 点击后展开选项列表（4s, 5s, 6s, 8s, 10s），再点击目标时长。
 *
 * .pyd 逻辑:
 * 1. 查找所有 lv-select，找到 value 包含 "数字s" 的那个（时长选择器）
 * 2. 如果当前值已经是目标时长，跳过
 * 3. 点击 trigger 打开下拉
 * 4. 在下拉选项中点击目标时长
 * 5. 验证选择结果
 */
async function _setDuration(page, duration) {
    try {
        const durationStr = String(duration).replace(/s$/i, '');
        const targetTexts = [`${durationStr}s`, `${durationStr}秒`, durationStr];
        console.log(`[即梦] playwright: setting duration to ${durationStr}s`);

        // .pyd: 方法1 — 通过 lv-select 组件精确操作（首选）
        const selectResult = await page.evaluate((targets) => {
            // 查找时长 lv-select: value 包含 "数字s" 模式
            const selects = document.querySelectorAll('[role="combobox"].lv-select, .lv-select');
            for (const sel of selects) {
                const valEl = sel.querySelector('.lv-select-view-value');
                if (!valEl) continue;
                const currentVal = (valEl.innerText || valEl.textContent || '').trim();
                // .pyd: 判断是否为时长选择器 — 值匹配 "数字s" 或 "数字秒"
                if (/^\d+s$/i.test(currentVal) || /^\d+秒$/.test(currentVal) || /^\d+$/.test(currentVal)) {
                    // 检查当前值是否已经是目标
                    for (const t of targets) {
                        if (currentVal === t) return { ok: true, already: true, current: currentVal };
                    }
                    // 点击 trigger 打开下拉
                    const trigger = sel.querySelector('.lv-select-view-selector') || sel;
                    trigger.click();
                    return { ok: true, already: false, current: currentVal, opened: true };
                }
            }
            return { ok: false, reason: 'no duration lv-select found' };
        }, targetTexts);

        console.log(`[即梦] playwright: duration select result: ${JSON.stringify(selectResult)}`);

        if (selectResult.ok && selectResult.already) {
            console.log(`[即梦] playwright: duration already set to ${selectResult.current}`);
            return;
        }

        if (selectResult.ok && selectResult.opened) {
            await _randomDelay(400, 700);

            // 在下拉选项中选择目标时长
            for (const dt of targetTexts) {
                const selected = await page.evaluate((text) => {
                    const options = document.querySelectorAll('li, [role="option"], [role="menuitem"], [class*="option"]');
                    for (const opt of options) {
                        const t = (opt.textContent || '').trim();
                        if (t === text && opt.offsetParent !== null) {
                            opt.click();
                            return { ok: true, text: t };
                        }
                    }
                    return { ok: false };
                }, dt);

                if (selected.ok) {
                    console.log(`[即梦] playwright: duration set to ${selected.text} via lv-select`);
                    await _randomDelay(300, 500);
                    return;
                }
            }

            // 下拉打开了但没找到选项，关闭 popup
            await page.evaluate(() => document.body.click());
            await _randomDelay(200, 400);
        }

        // .pyd: 方法2 — 直接在页面上找时长按钮（fallback）
        for (const dt of targetTexts) {
            const found = await page.evaluate((text) => {
                const els = document.querySelectorAll('span, div, button, label');
                for (const el of els) {
                    if ((el.textContent || '').trim() === text && el.offsetParent !== null) {
                        el.click();
                        return true;
                    }
                }
                return false;
            }, dt);

            if (found) {
                console.log(`[即梦] playwright: duration set to ${dt} via direct click`);
                return;
            }
        }

        console.log(`[即梦] playwright: duration option '${durationStr}s' not found, using default`);
    } catch (error) {
        console.error('[即梦] 设置时长失败:', error.message);
    }
}

/**
 * 点击生成按钮
 * 
 * 原始插件使用 _pw_click_generate + scored/matches/looseMatches 评分策略：
 * 1. querySelectorAll 找所有可能的按钮/可点击元素
 * 2. 根据文字内容、class 名、位置等特征评分
 * 3. 取最高分的元素点击
 */
async function _clickGenerateButton(page) {
    const clicked = await page.evaluate(() => {
        // 方法1: 精确匹配 submit-button class
        const submitBtn = document.querySelector('button[class*="submit-button"]');
        if (submitBtn && submitBtn.offsetParent !== null) {
            submitBtn.click();
            return { ok: true, method: 'submit-button-class' };
        }
        // 方法2: lv-btn-primary + icon-only + circle 组合
        const iconBtns = document.querySelectorAll('button.lv-btn-primary.lv-btn-icon-only.lv-btn-shape-circle');
        for (const btn of iconBtns) {
            if (btn.offsetParent !== null) {
                btn.click();
                return { ok: true, method: 'primary-icon-circle' };
            }
        }
        // 方法3: 文字匹配 fallback
        const candidates = [];
        const allEls = document.querySelectorAll('div, span, button, a, [role="button"]');

        for (const el of allEls) {
            if (!el.offsetParent) continue; // 不可见的跳过
            const text = el.textContent?.trim();
            const elClasses = el.className || '';
            let score = 0;

            // 文字匹配评分
            if (text === '生成') score += 100;
            else if (text === '立即生成' || text === '开始生成') score += 90;
            else if (text && text.includes('生成') && text.length < 10) score += 50;
            else continue; // 不包含"生成"的直接跳过

            // class 特征加分
            if (elClasses.includes('lv-btn')) score += 30;
            if (elClasses.includes('content-')) score += 20;
            if (elClasses.includes('generate')) score += 20;
            if (elClasses.includes('submit')) score += 15;
            if (el.tagName === 'BUTTON') score += 10;
            if (el.getAttribute('role') === 'button') score += 10;

            // 父元素是按钮的加分
            const parent = el.parentElement;
            if (parent) {
                const pc = parent.className || '';
                if (pc.includes('lv-btn')) score += 25;
                if (pc.includes('content-')) score += 15;
            }

            candidates.push({ el, score, text });
        }

        if (candidates.length === 0) return false;

        // 按分数排序，点击最高分
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        // 找到可点击的目标（向上查找按钮容器）
        const clickTarget = best.el.closest('[role="button"], button, .lv-btn') || best.el.parentElement || best.el;
        clickTarget.click();
        return true;
    });

    if (clicked && clicked.ok !== false) {
        console.log(`[即梦] 已点击生成按钮: ${JSON.stringify(clicked)}`);
        return;
    }

    throw new Error('未找到可用的生成按钮，请检查页面状态');
}

/**
 * 等待视频生成完成（升级版：网络拦截 + DOM 双通道轮询）
 *
 * 从 .pyd 逆向的完整轮询策略:
 * 1. 通过 submit_id + data-id 属性精确定位 DOM 卡片（_asset_status_finish）
 * 2. 检测卡片内状态文本：生成中/造梦中/排队/生成完成/生成失败/审核未通过
 * 3. 网络拦截器同时监听 get_asset_list 响应获取 transcoded_video URL
 * 4. fallback-refresh: DOM 无信息时刷新页面通过 get_asset_list 获取结果
 * 5. 视频获取优先级: 网络拦截 > DOM卡片内video > 全局video扫描
 */
async function _waitForCompletion(taskId, page, interceptor) {
    const task = taskStore[taskId];
    const startTime = Date.now();
    let lastProgress = 0;
    let stuckCount = 0;
    let prevDomStatus = '';
    const MIN_ELAPSED_FOR_GLOBAL_SCAN = 30000; // 至少等30秒才允许全局video扫描

    // 记录提交前页面上已有的 video URL，避免误抓历史视频
    let preExistingVideoUrls = await page.evaluate(() => {
        const urls = new Set();
        document.querySelectorAll('video').forEach(v => {
            const src = v.currentSrc || v.src || '';
            if (src) urls.add(src);
        });
        return [...urls];
    }).catch(() => []);
    // 合并全局排除集（_processQueue reload后快照的视频）
    const baselineArr = Array.from(_pageReloadBaselineVideos);
    for (const url of baselineArr) {
        if (!preExistingVideoUrls.includes(url)) preExistingVideoUrls.push(url);
    }
    console.log(`[即梦] 记录页面已有video: ${preExistingVideoUrls.length}个 (含全局排除${baselineArr.length}个)`);

    const submitId = interceptor ? interceptor.getSubmitId() : null;
    console.log(`[即梦] playwright: polling on isolated page, submitId=${submitId || 'none'}`);

    while (Date.now() - startTime < CONFIG.taskTimeout) {
        await new Promise(r => setTimeout(r, CONFIG.pollInterval));

        try {
            // === 通道1: 检查网络拦截器是否已捕获视频 URL 或失败状态 ===
            if (interceptor) {
                const networkVideoUrl = interceptor.getVideoUrl();
                if (networkVideoUrl && _looksLikeVideoUrl(networkVideoUrl)) {
                    console.log(`[即梦] playwright: [network] got video after transition: ${_sanitizeUrlForLog(networkVideoUrl)}`);
                    await _handleVideoFound(task, taskId, page, networkVideoUrl);
                    return;
                }
                const assetFailure = interceptor.getAssetFailure();
                if (assetFailure) {
                    console.log(`[即梦] playwright: [network] 检测到 API 失败: ${assetFailure}`);
                    task.status = 'failed';
                    task.error = assetFailure;
                    task.message = assetFailure;
                    return;
                }
            }

            // === 通道2: DOM 轮询（使用 submit_id 精确定位卡片） ===
            // .pyd: _asset_status_finish + _asset_best_video_url
            const status = await page.evaluate((submitId, allowGlobalScan, preExisting, claimed) => {
                const info = {
                    status: 'processing',
                    progress: null,
                    queue_info: null,
                    eta: null,
                    video_url: null,
                    status_texts: [],
                    matched_card: false,
                    fail_detail: null,
                };

                // --- 精确到 submit_id 卡片（.pyd: 通过 data-id 属性精确定位） ---
                let scope = document;
                if (submitId) {
                    const card = document.querySelector('[data-id="' + submitId + '"]');
                    if (card) {
                        info.matched_card = true;
                        scope = card;
                    }
                }

                // --- 扫描卡片/页面内的状态文本 ---
                const els = scope.querySelectorAll('div, span, button');
                for (const el of els) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;

                    let ownText = '';
                    for (const node of el.childNodes) {
                        if (node.nodeType === 3) ownText += node.textContent;
                    }
                    const innerT = (el.innerText || '').trim();
                    const text = ownText.trim() || (innerT.length <= 60 ? innerT : '');
                    if (!text) continue;

                    // 检测完成
                    if (text.includes('生成完成') || text.includes('已完成')) {
                        info.status = 'completed';
                        info.progress = 100;
                        if (!info.status_texts.includes(text.substring(0, 60))) {
                            info.status_texts.push(text.substring(0, 60));
                        }
                    }

                    // 检测失败（包含平台规则违规、内容审核、积分不足等）
                    // 重要：只在匹配到 submit_id 卡片时检测失败，避免全页面扫描到旧任务的残留错误
                    if (info.matched_card) {
                        if (text.includes('生成失败') || text.includes('失败')
                            || text.includes('不符合平台规则') || text.includes('平台规则')
                            || text.includes('违规') || text.includes('审核未通过')
                            || text.includes('请稍后再试') || text.includes('内容不合规')
                            || text.includes('敏感') || text.includes('违反')
                            || text.includes('积分不足') || text.includes('余额不足')
                            || text.includes('次数不足') || text.includes('免费次数已用完')
                            || text.includes('额度不足')) {
                            info.status = 'failed';
                            info.fail_detail = text.substring(0, 100);
                            info.status_texts.push(text.substring(0, 100));
                        }

                        // 检测审核失败
                        if (text.includes('未通过审核') || text.includes('审核未通过')
                            || text.includes('不消耗积分') || text.includes('违规')) {
                            info.status = 'failed';
                            info.fail_detail = text.substring(0, 60);
                            info.status_texts.push(text.substring(0, 40));
                        }

                        // 检测 error-tips class
                        const elClasses = el.className || '';
                        if (typeof elClasses === 'string' && elClasses.includes('error-tips')) {
                            info.status = 'failed';
                            info.fail_detail = text.substring(0, 60);
                        }
                    }

                    // 检测进度百分比
                    const pctMatch = text.match(/(\d{1,3})\s*%/);
                    if (pctMatch && info.progress === null) {
                        const n = parseInt(pctMatch[1]);
                        if (n > 0 && n <= 100) info.progress = n;
                    }

                    // 检测排队信息
                    if (text.includes('排队') || (text.includes('加速') && text.length < 40)) {
                        const queueMatch = text.match(/排队[超约]*\s*(\d+)\s*位/);
                        const etaMatch = text.match(/预计[剩余还需约]*\s*(\d+)\s*分钟/);
                        if (queueMatch) { info.queue_info = '排队' + queueMatch[1] + '位'; }
                        if (etaMatch) { info.eta = etaMatch[1] + '分钟'; }
                        if (!info.queue_info) { info.queue_info = text.substring(0, 40); }
                    }

                    // 检测生成中
                    if (text.includes('生成中') || text.includes('造梦中') || text.includes('Generating')) {
                        if (!info.status_texts.includes(text.substring(0, 60))) {
                            info.status_texts.push(text.substring(0, 60));
                        }
                    }
                }

                // --- 精确到 submit_id 卡片时可以安全使用 video URL ---
                if (submitId && info.matched_card) {
                    const videos = scope.querySelectorAll('video');
                    for (const v of videos) {
                        const src = v.currentSrc || v.src || '';
                        const lower = src.toLowerCase();
                        if (lower.includes('vlabstatic.com') || lower.includes('/static/media/')) continue;
                        if (src && (src.startsWith('http') || src.startsWith('blob:'))) {
                            const w = v.videoWidth || 0;
                            const h = v.videoHeight || 0;
                            if (w > 0 && h > 0) {
                                info.video_url = src;
                                info.status = 'completed';
                                break;
                            }
                        }
                    }
                }

                // --- 全局 video 扫描（无 submit_id 时的 fallback） ---
                // 需要满足：1.没有submitId 2.已经过了最小等待时间 3.排除提交前已有的视频 + 已认领的视频
                if (!info.video_url && !submitId && allowGlobalScan) {
                    const videos = document.querySelectorAll('video');
                    const collected = [];
                    for (const v of videos) {
                        if (!v.offsetParent) continue;
                        const src = v.currentSrc || v.src || '';
                        const lower = src.toLowerCase();
                        if (lower.includes('vlabstatic.com') || lower.includes('/static/media/')) continue;
                        if (preExisting.includes(src)) continue; // 排除提交前已有的视频
                        if (claimed.includes(src)) continue; // 排除已被其他任务认领的视频
                        if (src && (src.startsWith('http') || src.startsWith('blob:'))) {
                            collected.push({
                                src,
                                duration: v.duration || 0,
                                w: v.videoWidth || 0,
                                h: v.videoHeight || 0,
                            });
                        }
                    }
                    if (collected.length > 0) {
                        collected.sort((a, b) => (b.w * b.h) - (a.w * a.h) || b.duration - a.duration);
                        info.video_url = collected[0].src;
                        info.status = 'completed';
                    }
                }

                return info;
            }, submitId, Date.now() - startTime > MIN_ELAPSED_FOR_GLOBAL_SCAN, preExistingVideoUrls, Array.from(_claimedVideoUrls));

            // === 处理轮询结果 ===
            const domStatus = `${status.status}|${status.progress}|${status.video_url || ''}`;
            if (domStatus !== prevDomStatus) {
                console.log(`[即梦] playwright: [DOM] card[matched=${status.matched_card}] status=${status.status} progress=${status.progress} queue=${status.queue_info || ''} eta=${status.eta || ''} texts=${JSON.stringify(status.status_texts)}`);
                prevDomStatus = domStatus;
            }

            // 完成 → 下载视频
            if (status.status === 'completed' && status.video_url) {
                // 诊断日志：区分精确匹配 vs 全局扫描
                if (!submitId || !status.matched_card) {
                    _traceLog(`[即梦] ⚠ [全局扫描命中] taskId=${taskId}, submitId=${submitId || 'none'}, matched_card=${status.matched_card}, video=${_sanitizeUrlForLog(status.video_url)}`);
                }
                await _handleVideoFound(task, taskId, page, status.video_url);
                return;
            }

            // 失败
            if (status.status === 'failed') {
                const detail = status.fail_detail || status.status_texts.join('; ') || '生成失败';
                console.log(`[即梦] playwright: [DOM] detected failure: ${detail}`);
                task.status = 'failed';
                task.error = detail;
                task.message = detail;
                return;
            }

            // 更新进度
            const currentProgress = status.progress || lastProgress;
            task.progress = Math.max(45, Math.min(95, 45 + currentProgress * 0.5));
            if (status.queue_info) {
                task.message = `${status.queue_info}${status.eta ? '，预计' + status.eta : ''}`;
            } else if (currentProgress > 0) {
                task.message = `生成中... ${currentProgress}%`;
            } else {
                task.message = status.status_texts[0] || '生成中...';
            }

            // === API 探测机制（不刷新页面，通过 API 主动检查状态） ===
            if (currentProgress === lastProgress) {
                stuckCount++;
                // 每~30秒触发一次 API 探测，主动调用 get_asset_list 检查视频/失败状态
                if (stuckCount >= 6 && stuckCount % 6 === 0) {
                    const probe = interceptor ? interceptor.getApiProbe() : null;
                    if (probe) {
                        try {
                            await page.evaluate(async (probeUrl, probeMethod, probeBody) => {
                                await fetch(probeUrl, {
                                    method: probeMethod || 'POST',
                                    headers: probeBody ? { 'Content-Type': 'application/json' } : {},
                                    body: probeBody || undefined,
                                });
                            }, probe.url, probe.method, probe.postData);
                            console.log(`[即梦] playwright: [api-probe] fired (stuck=${stuckCount})`);
                        } catch (_) { /* fetch 失败不影响轮询 */ }
                    }
                    // 检查 API 响应中的失败状态
                    if (interceptor) {
                        const assetFailure = interceptor.getAssetFailure();
                        if (assetFailure) {
                            console.log(`[即梦] playwright: [api-probe] 检测到失败: ${assetFailure}`);
                            task.status = 'failed';
                            task.error = assetFailure;
                            task.message = assetFailure;
                            return;
                        }
                    }
                }
            } else {
                stuckCount = 0;
                lastProgress = currentProgress;
            }

        } catch (error) {
            // 检测浏览器断开连接（页面被关闭、CDP断开等致命错误）
            const msg = error.message || '';
            if (msg.includes('Protocol error') || msg.includes('Target closed') || msg.includes('Session closed')
                || msg.includes('disconnected') || msg.includes('disposed') || msg.includes('detached')) {
                console.error(`[即梦] 轮询检测到浏览器断开: ${msg}`);
                task.status = 'failed';
                task.error = '浏览器连接中断';
                task.message = '浏览器被关闭或连接中断';
                return;
            }
            console.error('[即梦] 轮询状态出错:', error.message);
        }
    }

    // 超时
    task.status = 'failed';
    task.error = '任务超时（8小时）';
    task.message = '视频生成超时';
}

/**
 * 处理找到视频 URL 后的下载逻辑（复用代码）
 */
async function _handleVideoFound(task, taskId, page, videoUrl) {
    _traceLog(`[即梦] 任务完成: ${taskId}, URL: ${_sanitizeUrlForLog(videoUrl)}`);
    _claimedVideoUrls.add(videoUrl); // 标记已认领，防止其他任务全局扫描误抓
    task.message = '正在下载视频到本地...';
    task.progress = 96;

    try {
        const localPath = await _downloadVideoToLocal(page, videoUrl, taskId);
        task.localVideoPath = localPath;
        // 直接使用绝对路径，这样右键可以正确定位到项目视频文件夹
        task.videoUrl = localPath;
        console.log(`[即梦] 视频已下载: ${localPath}`);
    } catch (dlErr) {
        console.error(`[即梦] 视频下载失败，使用远程URL:`, dlErr.message);
        task.videoUrl = videoUrl;
    }

    task.status = 'completed';
    task.message = '视频生成完成！';
    task.progress = 100;
    await saveCookies();
}

/**
 * 查询任务状态
 */
function getTaskStatus(taskId) {
    const task = taskStore[taskId];
    if (!task) {
        return { status: 'unknown', error: '任务不存在' };
    }

    // 自动清理已终结且超过2小时的任务（基于创建时间，视频生成最长8小时，所以用 createdAt + 10h）
    if ((task.status === 'completed' || task.status === 'failed') &&
        Date.now() - task.createdAt > 10 * 3600000) {
        delete taskStore[taskId];
    }

    return {
        status: task.status,
        progress: task.progress,
        message: task.message,
        videoUrl: task.videoUrl,
        imageUrl: task.imageUrl,
        imageUrls: task.imageUrls || null,
        error: task.error,
    };
}

/** 取消任务：标记为失败并从队列中移除 */
function cancelTask(taskId) {
    const task = taskStore[taskId];
    if (!task) return { ok: false, error: '任务不存在' };
    if (task.status === 'completed' || task.status === 'failed') return { ok: true, message: '任务已结束' };
    // 从图片/视频排队队列中移除
    const qIdx = taskQueue.findIndex(q => q.taskId === taskId);
    if (qIdx >= 0) taskQueue.splice(qIdx, 1);
    const videoIdx = videoTaskQueue.findIndex(q => q.taskId === taskId);
    if (videoIdx >= 0) videoTaskQueue.splice(videoIdx, 1);
    // 标记为失败
    task.status = 'failed';
    task.error = '已取消';
    task.message = '已取消';
    const entry = activeVideoTaskPages.get(taskId);
    if (entry) {
        _closeVideoTaskPage(taskId, entry.page).catch(() => {});
    }
    _refreshVideoTaskQueueMessages();
    console.log(`[即梦] 任务${taskId}已取消`);
    return { ok: true };
}

/**
 * 断开浏览器连接
 * @param {string} accountId - 账号ID，不传则断开所有
 */
async function closeBrowser(accountId) {
    if (accountId) {
        const acct = _getAccount(accountId);
        if (acct.browser) {
            try { await saveCookies(acct.id); } catch (e) { /* ignore */ }
            acct.browser.disconnect();
            acct.browser = null;
            acct.mainPage = null;
            console.log(`[即梦] CDP连接已断开(${acct.name})（Chrome保持运行）`);
        }
    } else {
        for (const acct of _accounts.values()) {
            if (acct.browser) {
                try { await saveCookies(acct.id); } catch (e) { /* ignore */ }
                acct.browser.disconnect();
                acct.browser = null;
                acct.mainPage = null;
            }
        }
        console.log('[即梦] 所有CDP连接已断开');
    }
}

/**
 * 完全关闭Chrome
 * @param {string} accountId - 账号ID，不传则关闭所有
 */
async function killChrome(accountId) {
    if (accountId) {
        const acct = _getAccount(accountId);
        await closeBrowser(acct.id);
        if (acct.chromeProcess) {
            try { acct.chromeProcess.kill(); } catch (e) { /* ignore */ }
            acct.chromeProcess = null;
        }
        console.log(`[即梦] Chrome已关闭(${acct.name})`);
    } else {
        await closeBrowser();
        for (const acct of _accounts.values()) {
            if (acct.chromeProcess) {
                try { acct.chromeProcess.kill(); } catch (e) { /* ignore */ }
                acct.chromeProcess = null;
            }
        }
        console.log('[即梦] 所有Chrome已关闭');
    }
}

/**
 * 查找系统中的 ffmpeg 可执行文件
 * .pyd: _find_ffmpeg
 */
function _findFfmpeg() {
    const candidates = [
        'ffmpeg',
        '/opt/homebrew/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        'C:\\ffmpeg\\bin\\ffmpeg.exe',
        path.join(os.homedir(), 'ffmpeg', 'bin', 'ffmpeg.exe'),
        path.join(__dirname, '..', 'ffmpeg', 'ffmpeg.exe'),
        path.join(__dirname, '..', 'ffmpeg.exe'),
    ];
    for (const p of candidates) {
        try {
            require('child_process').execSync(`"${p}" -version`, { timeout: 5000, stdio: 'pipe' });
            console.log(`[即梦] ffmpeg found: ${p}`);
            return p;
        } catch (_) { /* not found */ }
    }
    console.log('[即梦] ffmpeg not found');
    return null;
}

/**
 * 将 m3u8 流 remux 为 mp4
 * .pyd: _remux_m3u8_to_mp4 — ffmpeg -i input.m3u8 -c copy output.mp4
 */
async function _remuxM3u8ToMp4(m3u8Url, outputPath) {
    const ffmpegPath = _findFfmpeg();
    if (!ffmpegPath) return null;

    console.log(`[即梦] Remuxing m3u8 with ffmpeg: ${_sanitizeUrlForLog(m3u8Url)}`);
    return new Promise((resolve) => {
        const args = ['-i', m3u8Url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', '-y', outputPath];
        const proc = spawn(ffmpegPath, args, { timeout: 120000, stdio: 'pipe' });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
                const size = fs.statSync(outputPath).size;
                console.log(`[即梦] download: saved mp4=${outputPath} (${(size / 1024 / 1024).toFixed(1)}MB)`);
                resolve(outputPath);
            } else {
                console.error(`[即梦] ffmpeg remux failed; code=${code}, stderr=${stderr.substring(0, 200)}`);
                try { fs.unlinkSync(outputPath); } catch (_) { }
                resolve(null);
            }
        });
        proc.on('error', (err) => {
            console.error(`[即梦] ffmpeg spawn error: ${err.message}`);
            resolve(null);
        });
    });
}

/**
 * 下载视频到本地（升级版：支持 m3u8 + mp4 + blob）
 *
 * .pyd 逆向的完整下载链路:
 * 1. 检测 URL 类型: m3u8 → ffmpeg remux; mp4 → 直接下载; blob → 页面提取
 * 2. _download_and_save_video: 保存到本地
 * 3. _remux_m3u8_to_mp4: m3u8 → mp4 转换
 * 4. fallback: ffmpeg 不存在时保存 m3u8 URL
 */
async function _downloadVideoToLocal(page, videoUrl, taskId) {
    const task = taskStore[taskId];
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const pName = task && task.projectName ? task.projectName : '';
    const pPath = task && task.projectPath ? task.projectPath : '';
    const sIdx = task && task.shotIndex >= 0 ? task.shotIndex : -1;

    // 优先保存到项目的 05_generation/videos/，否则回退到 images/
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

    const isM3u8 = videoUrl.toLowerCase().includes('.m3u8');

    console.log(`[即梦] Downloading video (${isM3u8 ? 'm3u8' : 'direct'}): ${_sanitizeUrlForLog(videoUrl)}`);

    // === m3u8 流 → ffmpeg remux ===
    if (isM3u8) {
        const mp4Path = await _remuxM3u8ToMp4(videoUrl, outputPath);
        if (mp4Path) return mp4Path;
        // fallback: 保存 m3u8 URL（.pyd: Saved m3u8 (no mp4)）
        const m3u8File = path.join(outputDir, `video_${taskId}_${Date.now()}.m3u8.txt`);
        fs.writeFileSync(m3u8File, videoUrl, 'utf-8');
        console.log(`[即梦] download: saved m3u8=${m3u8File} (ffmpeg remux failed; returning m3u8 instead)`);
        return m3u8File;
    }

    // === blob: URL → 在浏览器里 fetch 转 base64 回传 ===
    if (videoUrl.startsWith('blob:')) {
        console.log('[即梦] 检测到 blob: URL，在页面中提取...');
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
            } catch (e) { return null; }
        }, videoUrl);

        if (!base64Data) throw new Error('无法从 blob URL 提取视频数据');
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(outputPath, buffer);
        console.log(`[即梦] blob视频已保存: ${outputPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
        return outputPath;
    }

    // === HTTP/HTTPS URL → 直接下载 ===
    if (videoUrl.startsWith('http')) {
        const resolvedPath = await new Promise((resolve, reject) => {
            const client = videoUrl.startsWith('https') ? https : http;
            const file = fs.createWriteStream(outputPath);
            client.get(videoUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://jimeng.jianying.com/',
                },
            }, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    file.close();
                    try { fs.unlinkSync(outputPath); } catch (_) { }
                    response.resume();
                    _downloadVideoToLocal(page, response.headers.location, taskId).then(resolve).catch(reject);
                    return;
                }
                if (response.statusCode !== 200) { file.close(); response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    const size = fs.statSync(outputPath).size;
                    console.log(`[即梦] 视频已下载: ${outputPath} (${(size / 1024 / 1024).toFixed(1)}MB)`);
                    resolve(outputPath);
                });
            }).on('error', (err) => {
                try { fs.unlinkSync(outputPath); } catch (_) { }
                reject(err);
            });
        });
        return resolvedPath;
    }

    throw new Error(`不支持的视频URL格式: ${videoUrl.substring(0, 30)}`);
}

// ==================== 工具函数 ====================

function _randomDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(r => setTimeout(r, delay));
}

// ==================== 图片生成 ====================

/**
 * 确保当前在图片生成模式
 * 页面已导航到 type=image URL，只需点一次 tab 切换即可，无需检测循环
 * （_detectBarMode 会被页面残留的 Seedance 文字误判为 video_mode）
 */
async function _ensureImageMode(page) {
    const clickResult = await page.evaluate(() => {
        const all = document.querySelectorAll('div, span, button, li, a');
        for (const el of all) {
            const t = (el.innerText || el.textContent || '').trim();
            if (t === '图片生成' && el.offsetParent !== null) { el.click(); return { ok: true, text: t }; }
        }
        for (const el of all) {
            const t = (el.innerText || el.textContent || '').trim();
            if (t.includes('图片生成') && t.length < 20 && el.offsetParent !== null) { el.click(); return { ok: true, text: t }; }
        }
        return { ok: false };
    });
    console.log(`[即梦图片] '图片生成' click result: ${JSON.stringify(clickResult)}`);
    if (clickResult.ok) {
        await _randomDelay(2000, 3000);
        console.log('[即梦图片] 已切换到图片模式');
    } else {
        console.log('[即梦图片] 未找到图片生成 tab，可能已在图片模式');
    }
}

/**
 * 选择图片模型（在底部栏下拉中选择）
 */
async function _selectImageModel(page, targetModel) {
    console.log(`[即梦图片] 选择模型: ${targetModel}`);
    // 检查当前模型
    const currentModel = await page.evaluate(() => {
        const vals = document.querySelectorAll('.lv-select-view-value');
        for (const v of vals) {
            const t = (v.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.includes('图片') || t.includes('5.0') || t.includes('3.0') || t.includes('2.1')) return t;
        }
        return null;
    });
    console.log(`[即梦图片] 当前模型: [${currentModel}]`);
    if (currentModel && currentModel.includes(targetModel)) {
        console.log(`[即梦图片] 模型已是 ${targetModel}，无需切换`);
        return;
    }
    // 点击 lv-select 打开下拉
    const selectorClicked = await page.evaluate(() => {
        const selects = document.querySelectorAll('[role="combobox"].lv-select, .lv-select');
        for (const sel of selects) {
            const valSpan = sel.querySelector('.lv-select-view-value');
            if (!valSpan) continue;
            const text = (valSpan.innerText || '').trim();
            if (text.includes('图片') || text.includes('5.0') || text.includes('3.0') || text.includes('2.1')) {
                const trigger = sel.querySelector('.lv-select-view-selector') || sel;
                trigger.click();
                return { ok: true, text };
            }
        }
        // fallback: 点击 lv-select-view-value
        const vals = document.querySelectorAll('.lv-select-view-value');
        for (const v of vals) {
            const t = (v.innerText || '').trim();
            if (t.includes('图片') || t.includes('5.0') || t.includes('3.0')) { v.click(); return { ok: true, text: t }; }
        }
        return { ok: false };
    });
    console.log(`[即梦图片] model selector click: ${JSON.stringify(selectorClicked)}`);
    if (!selectorClicked.ok) return;
    await _randomDelay(500, 800);
    // 在下拉中选择目标模型
    const selected = await page.evaluate((target) => {
        const candidates = document.querySelectorAll('li.lv-select-option, [role="option"], [class*="option"], li');
        for (const el of candidates) {
            const t = (el.innerText || '').trim().split('\n')[0].trim();
            if (t.includes(target) && el.offsetParent !== null) { el.click(); return { ok: true, text: t }; }
        }
        return { ok: false };
    }, targetModel);
    console.log(`[即梦图片] model selection: ${JSON.stringify(selected)}`);
    await _randomDelay(800, 1200);
}

/**
 * 选择图片质量/分辨率（通过弹窗 popover 中的 radio 按钮）
 * qualityValue: '2k' | '4k'（对应 radio input 的 value）
 * 兼容旧调用方式：'高清2K' → '2k', '超清4K'/'高清 2K'/'超清 4K' 自动映射
 */
async function _selectImageQuality(page, qualityText) {
    // 统一映射到 radio value
    const valueMap = { '高清2K': '2k', '高清 2K': '2k', '2k': '2k', '超清4K': '4k', '超清 4K': '4k', '4k': '4k' };
    const radioValue = valueMap[qualityText] || '2k';
    console.log(`[即梦图片] 选择画质: ${qualityText} → radio value=${radioValue}`);

    // 1. 点击 "智能比例 / 高清 2K" 按钮打开设置弹窗
    const btnPos = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const el of btns) {
            const t = (el.innerText || '').trim();
            if ((t.includes('\u9AD8\u6E05') || t.includes('\u8D85\u6E05')) && el.offsetParent !== null) {
                const r = el.getBoundingClientRect();
                if (r.width > 50) return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: t };
            }
        }
        return null;
    });
    if (!btnPos) {
        console.log('[即梦图片] 未找到画质设置按钮');
        return;
    }
    await page.mouse.click(btnPos.x, btnPos.y);
    console.log(`[即梦图片] 点击画质按钮: "${btnPos.text}" at (${btnPos.x}, ${btnPos.y})`);
    await _randomDelay(800, 1200);

    // 2. 在弹窗中选择分辨率 radio
    const qualityResult = await page.evaluate((targetValue) => {
        // 查找 popover 中的 radio input
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const radio of radios) {
            if (radio.value === targetValue) {
                // 点击对应的 label（radio 的父元素）
                const label = radio.closest('label');
                if (label) { label.click(); return { ok: true, method: 'label', value: targetValue }; }
                radio.click();
                return { ok: true, method: 'input', value: targetValue };
            }
        }
        // fallback: 按文字查找
        const textMap = { '2k': '\u9AD8\u6E05 2K', '4k': '\u8D85\u6E05 4K' };
        const targetText = textMap[targetValue];
        if (targetText) {
            const all = document.querySelectorAll('label.lv-radio, div[class*="radio"]');
            for (const el of all) {
                const t = (el.innerText || '').trim();
                if (t === targetText && el.offsetParent !== null) { el.click(); return { ok: true, method: 'text', value: targetValue }; }
            }
        }
        return { ok: false };
    }, radioValue);
    console.log(`[即梦图片] 分辨率选择: ${JSON.stringify(qualityResult)}`);
    await _randomDelay(300, 500);

    // 3. 选择 "智能" 比例（popover 中 radio value=""，文字为"智能"）
    const ratioResult = await page.evaluate(() => {
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const radio of radios) {
            if (radio.value === '' && !radio.checked) {
                const label = radio.closest('label');
                const labelText = label ? (label.innerText || '').trim() : '';
                if (labelText === '\u667A\u80FD') { label.click(); return { ok: true }; }
            }
        }
        return { ok: false };
    });
    if (ratioResult.ok) {
        console.log('[即梦图片] 已选择智能比例');
        await _randomDelay(300, 500);
    }

    // 4. 关闭弹窗：再次点击按钮（toggle）
    await page.mouse.click(btnPos.x, btnPos.y);
    await _randomDelay(300, 500);
    console.log('[即梦图片] 画质设置完成，弹窗已关闭');
}

/**
 * 提交图片生成任务
 * @param {Object} params
 * @param {string} params.prompt - 图片提示词
 * @param {string} [params.referenceImageUrl] - 参考图URL（模卡照片等）
 * @param {string} [params.model] - 模型名，默认 '图片5.0lite'
 * @param {string} [params.quality] - 画质，默认 '高清2K'
 * @returns {Object} { taskId, status }
 */
async function submitImageTask(params) {
    const { prompt, referenceImageUrl, shotNumber } = params;
    const taskId = `jimeng_img_${Date.now()}_${shotNumber || 0}`;

    taskStore[taskId] = {
        status: 'pending',
        progress: 0,
        message: '排队中...',
        imageUrl: null,
        error: null,
        shotNumber,
        createdAt: Date.now(),
    };

    // 加入队列
    taskQueue.push({ taskId, params: { ...params, _isImageTask: true } });
    const queuePos = taskQueue.length;
    if (queuePos > 1) {
        taskStore[taskId].message = `排队中（第${queuePos}个）...`;
    }
    console.log(`[即梦图片] 任务${taskId}加入队列，位置=${queuePos}`);

    _processQueue();
    return { taskId, status: 'pending' };
}

/**
 * 提交阶段（图片）
 */
async function _executeImageSubmitPhase(taskId, params) {
    console.log(`[即梦图片] _executeImageSubmitPhase`);
    const { prompt, referenceImageUrl } = params;
    const targetModel = params.model || CONFIG.imageDefaultModel;
    const targetQuality = params.quality || CONFIG.imageDefaultQuality;
    const task = taskStore[taskId];

    try {
        const page = await getPage();

        // 1. 检查登录
        task.message = '检查登录状态...';
        task.progress = 5;
        const loginStatus = await checkLoginStatus();
        if (!loginStatus.loggedIn) {
            task.status = 'failed';
            task.error = '未登录，请先在浏览器中登录即梦';
            task.message = '未登录，请先登录';
            return null;
        }

        // 2. 打开图片创作页面
        task.message = '正在打开图片创作页面...';
        task.progress = 10;
        await page.goto(CONFIG.createImageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await _randomDelay(2500, 3500);

        // 3. 确认进入图片生成模式
        task.message = '确认图片生成模式...';
        task.progress = 15;
        await _ensureImageMode(page);
        await _randomDelay(500, 1000);

        // 4. 等待页面加载
        task.message = '等待页面加载...';
        task.progress = 18;
        await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 15000 });
        await _randomDelay(500, 1000);

        // 5. 选择模型
        task.message = `选择模型: ${targetModel}...`;
        task.progress = 20;
        await _selectImageModel(page, targetModel);
        await _randomDelay(500, 1000);

        // 6. 上传参考图（如果有）
        if (referenceImageUrl) {
            task.message = '上传参考图...';
            task.progress = 25;
            const localPath = await _ensureLocalImage(referenceImageUrl);
            if (localPath) {
                // 尝试用 file input 上传
                const fileInput = await page.$('input[type="file"][accept*="image"]') || await page.$('input[type="file"]');
                if (fileInput) {
                    await fileInput.uploadFile(localPath);
                    console.log(`[即梦图片] 参考图已上传: ${localPath}`);
                    await _randomDelay(2000, 3000);
                } else {
                    console.log('[即梦图片] 未找到文件上传输入框');
                }
            }
        }

        // 7. 填写提示词
        task.message = '填写提示词...';
        task.progress = 30;
        await _fillPrompt(page, prompt);
        await _randomDelay(500, 1000);

        // 8. 选择画质
        task.message = `设置画质: ${targetQuality}...`;
        task.progress = 35;
        await _selectImageQuality(page, targetQuality);
        await _randomDelay(500, 1000);

        // 9. 安装网络拦截器
        task.message = '安装网络拦截器...';
        task.progress = 38;
        const interceptor = _setupNetworkInterceptor(page);

        // 10. 点击生成按钮
        task.message = '提交生成任务...';
        task.progress = 40;
        await _clickGenerateButton(page);

        // 等待 submit_id
        task.message = '等待捕获 submit_id...';
        for (let i = 0; i < 20; i++) {
            if (interceptor.getSubmitId()) break;
            await new Promise(r => setTimeout(r, 500));
        }
        const submitId = interceptor.getSubmitId();
        interceptor.lockSubmitId();
        if (submitId) {
            console.log(`[即梦图片] submit_id=${submitId}`);
            task.submitId = submitId;
        } else {
            console.log('[即梦图片] 警告: 未捕获到 submit_id');
        }

        task.status = 'processing';
        task.message = '图片生成中...';
        task.progress = 45;

        return { page, interceptor, hasSubmitId: !!submitId };

    } catch (error) {
        console.error(`[即梦图片] 提交阶段失败:`, error.message);
        task.status = 'failed';
        task.error = error.message;
        task.message = '图片提交失败: ' + error.message;
        return null;
    }
}

/**
 * 轮询阶段（图片）—— 等待图片生成完成
 */
async function _waitForImageCompletion(taskId, page, interceptor) {
    const task = taskStore[taskId];
    const submitId = task.submitId;
    const startTime = Date.now();
    const timeout = CONFIG.imageTaskTimeout;

    console.log(`[即梦图片] 开始轮询: ${taskId}, submitId=${submitId || '无'}`);

    while (Date.now() - startTime < timeout) {
        await new Promise(r => setTimeout(r, CONFIG.pollInterval));

        try {
            // 方法1: 从网络拦截器的 get_asset_list 响应中找图片
            const assetData = interceptor.getAssetData();
            if (assetData && submitId) {
                const imageUrl = _scanImageFromResponse(assetData, submitId);
                if (imageUrl) {
                    await _handleImageFound(task, taskId, imageUrl);
                    return;
                }
            }

            // 方法2: DOM 扫描 — card 内出现 aigc_resize 图片才算完成
            const domResult = await page.evaluate((sid) => {
                const info = { status: null, thumbUrl: null, cardFound: false, statusText: '' };

                const card = sid ? document.querySelector('[data-id="' + sid + '"]') : null;
                if (!card) {
                    info.statusText = '等待card出现';
                    return info;
                }
                info.cardFound = true;
                const cardText = card.innerText || '';

                // 先查成功的图片（aigc_resize）— 有图就算成功，部分失败也OK
                const imgs = card.querySelectorAll('img');
                const allPositions = [];
                for (const img of imgs) {
                    const src = img.src || '';
                    if (src.startsWith('http') && src.includes('aigc_resize')) {
                        const r = img.getBoundingClientRect();
                        if (r.width > 30) {
                            allPositions.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
                        }
                    }
                }
                if (allPositions.length > 0) {
                    info.status = 'completed';
                    info.thumbUrl = 'found';
                    info.imgPositions = allPositions;
                    return info;
                }

                // 没有成功的图 → 检查是否全部失败
                if (cardText.includes('生成失败') || cardText.includes('不符合平台规则') || cardText.includes('违规') || cardText.includes('审核未通过')) {
                    // 确认不是还在生成中（部分失败+部分生成中）
                    if (!cardText.includes('造梦中') && !cardText.includes('生成中') && !cardText.includes('智能创意') && !cardText.includes('会员加速')) {
                        info.status = 'failed';
                        info.statusText = '全部图片生成失败';
                        return info;
                    }
                }

                // 进度文本
                if (cardText.includes('造梦中') || cardText.includes('生成中') || cardText.includes('智能创意') || cardText.includes('会员加速')) {
                    info.statusText = '生成中...';
                } else {
                    info.statusText = '等待生成结果...';
                }
                return info;
            }, submitId);

            if (domResult.status === 'failed') {
                task.status = 'failed';
                task.error = domResult.statusText;
                task.message = domResult.statusText;
                return;
            }

            if (domResult.status === 'completed' && domResult.imgPositions && domResult.imgPositions.length > 0) {
                console.log(`[即梦图片] 生成完成！共${domResult.imgPositions.length}张图`);
                const downloadedUrls = await _extractAllImagesByDownload(page, submitId, domResult.imgPositions);
                if (downloadedUrls.length > 0) {
                    task.imageUrl = downloadedUrls[0];
                    task.imageUrls = downloadedUrls;
                    task.status = 'completed';
                    task.message = `图片生成完成！共${downloadedUrls.length}张`;
                    task.progress = 100;
                    console.log(`[即梦图片] 全部下载完成: ${downloadedUrls.join(', ')}`);
                    await saveCookies();
                    return;
                }
                console.log(`[即梦图片] 下载失败`);
                task.status = 'failed';
                task.error = '图片下载失败';
                task.message = '图片下载失败';
                return;
            }

            // 更新进度
            if (domResult.cardFound) {
                task.progress = Math.max(50, task.progress);
                task.message = domResult.statusText || '图片生成中...';
            } else {
                task.message = domResult.statusText || '等待生成...';
            }

        } catch (error) {
            const msg = error.message || '';
            if (msg.includes('Protocol error') || msg.includes('Target closed') || msg.includes('Session closed')
                || msg.includes('disconnected') || msg.includes('disposed') || msg.includes('detached')) {
                console.error(`[即梦图片] 轮询检测到浏览器断开: ${msg}`);
                task.status = 'failed';
                task.error = '浏览器连接中断';
                task.message = '浏览器被关闭或连接中断';
                return;
            }
            console.error('[即梦图片] 轮询出错:', error.message);
        }
    }

    task.status = 'failed';
    task.error = '图片生成超时';
    task.message = '图片生成超时';
}

/**
 * 逐个hover缩略图→点击下载按钮→CDP拦截下载，下载全部生成图片
 * @param {Page} page
 * @param {string} submitId
 * @param {Array<{x:number,y:number}>} imgPositions - 每张图片的中心坐标
 * @returns {string[]} 下载后的本地URL数组 (如 /images/xxx.png)
 */
async function _extractAllImagesByDownload(page, submitId, imgPositions) {
    const imagesDir = path.join(DATA_DIR, 'images');
    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
    const results = [];
    const downloadedIndices = new Set(); // 跟踪哪些索引成功下载

    try {
        // ── 0. 预处理：scroll card 到视口中央，dismiss 可能存在的浮层 ──
        if (submitId) {
            await page.evaluate((sid) => {
                const card = document.querySelector('[data-id="' + sid + '"]');
                if (card) card.scrollIntoView({ block: 'center', behavior: 'instant' });
            }, submitId);
            await _randomDelay(500, 800);
        }
        // 点击页面空白区（左上角安全位置）dismiss 浮层
        await page.mouse.click(10, 10);
        await _randomDelay(300, 500);

        // ── 0b. 重新获取最新的图片坐标（scroll 后位置可能变化）──
        const freshPositions = await page.evaluate((sid) => {
            const card = sid ? document.querySelector('[data-id="' + sid + '"]') : null;
            if (!card) return null;
            const imgs = card.querySelectorAll('img');
            const positions = [];
            for (const img of imgs) {
                const src = img.src || '';
                if (src.startsWith('http') && src.includes('aigc_resize')) {
                    const r = img.getBoundingClientRect();
                    if (r.width > 30) {
                        positions.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, src });
                    }
                }
            }
            return positions.length > 0 ? positions : null;
        }, submitId);

        const positionsToUse = freshPositions || imgPositions;
        if (freshPositions) {
            console.log(`[即梦图片] 刷新坐标: ${freshPositions.map(p => `(${Math.round(p.x)},${Math.round(p.y)})`).join(', ')}`);
        }

        const cdpSession = await page.target().createCDPSession();
        await cdpSession.send('Browser.setDownloadBehavior', {
            behavior: 'allowAndName',
            downloadPath: imagesDir,
            eventsEnabled: true,
        });

        for (let i = 0; i < positionsToUse.length; i++) {
            const pos = positionsToUse[i];
            console.log(`[即梦图片] 下载第${i + 1}/${positionsToUse.length}张 hover(${Math.round(pos.x)},${Math.round(pos.y)})`);

            // 1. hover 该缩略图 + 找下载按钮（带重试）
            let dlBtnPos = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt > 0) {
                    // 重试：先移开鼠标再回来
                    console.log(`[即梦图片] 第${i + 1}张重试hover (attempt ${attempt + 1})`);
                    await page.mouse.move(10, 10);
                    await _randomDelay(500, 800);
                }
                await page.mouse.move(pos.x, pos.y);
                await _randomDelay(1200, 1800);

                dlBtnPos = await page.evaluate((px, py) => {
                    const groups = document.querySelectorAll('[class*="button-group"]');
                    let best = null, bestDist = Infinity;
                    for (const g of groups) {
                        const cls = (g.className || '').toString();
                        if (!cls.includes('top')) continue;
                        const r = g.getBoundingClientRect();
                        if (r.width === 0) continue;
                        const dist = Math.abs(r.x + r.width / 2 - px) + Math.abs(r.y - py);
                        if (dist < bestDist) {
                            bestDist = dist;
                            const firstBtn = g.querySelector('[class*="action-button"], [class*="operation-button"]');
                            if (firstBtn) {
                                const br = firstBtn.getBoundingClientRect();
                                if (br.width > 0) best = { x: br.x + br.width / 2, y: br.y + br.height / 2 };
                            }
                        }
                    }
                    return best;
                }, pos.x, pos.y);

                if (dlBtnPos) break;
            }

            if (!dlBtnPos) {
                console.log(`[即梦图片] 第${i + 1}张3次hover均未找到下载按钮，跳过`);
                continue;
            }

            // 2. 设置单张下载监听
            const downloadPromise = new Promise((resolve) => {
                const timeout = setTimeout(() => resolve(null), 15000);
                const handler = (event) => {
                    if (event.state === 'completed') {
                        clearTimeout(timeout);
                        cdpSession.off('Browser.downloadProgress', handler);
                        resolve(path.join(imagesDir, event.guid));
                    } else if (event.state === 'canceled') {
                        clearTimeout(timeout);
                        cdpSession.off('Browser.downloadProgress', handler);
                        resolve(null);
                    }
                };
                cdpSession.on('Browser.downloadProgress', handler);
            });

            // 3. 点击下载按钮
            console.log(`[即梦图片] 点击下载按钮 (${Math.round(dlBtnPos.x)},${Math.round(dlBtnPos.y)})`);
            await page.mouse.click(dlBtnPos.x, dlBtnPos.y);

            // 4. 等待下载完成
            const downloaded = await downloadPromise;
            if (downloaded && fs.existsSync(downloaded)) {
                const finalName = `jimeng_img_${Date.now()}_${i + 1}.png`;
                const finalPath = path.join(imagesDir, finalName);
                fs.renameSync(downloaded, finalPath);
                const size = fs.statSync(finalPath).size;
                console.log(`[即梦图片] 第${i + 1}张下载完成: ${finalName} (${(size / 1024).toFixed(1)}KB)`);
                results.push(`/images/${finalName}`);
                downloadedIndices.add(i);
            } else {
                console.log(`[即梦图片] 第${i + 1}张下载超时`);
            }

            if (i < positionsToUse.length - 1) await _randomDelay(800, 1200);
        }

        await cdpSession.detach().catch(() => {});

        // ── Fallback: 对未成功下载的图片，直接用 img src URL 下载 ──
        if (results.length < positionsToUse.length && freshPositions && freshPositions.some(p => p.src)) {
            console.log(`[即梦图片] ${positionsToUse.length}张中只成功下载${results.length}张，对剩余图片尝试URL fallback...`);
            for (let i = 0; i < freshPositions.length; i++) {
                if (downloadedIndices.has(i)) continue; // 已成功下载，跳过
                const srcUrl = freshPositions[i].src;
                if (!srcUrl) continue;
                // 去掉 aigc_resize 参数，尝试获取更高清版本
                const cleanUrl = srcUrl.replace(/~tplv-[^.]+\.image/, '~tplv-tt-shrink:2000:2000.image');
                try {
                    console.log(`[即梦图片] fallback下载第${i + 1}张: ${cleanUrl.substring(0, 80)}...`);
                    const response = await page.evaluate(async (url) => {
                        const resp = await fetch(url);
                        if (!resp.ok) return null;
                        const blob = await resp.blob();
                        const reader = new FileReader();
                        return new Promise(resolve => {
                            reader.onload = () => resolve(reader.result);
                            reader.readAsDataURL(blob);
                        });
                    }, cleanUrl);
                    if (response) {
                        const base64Data = response.replace(/^data:[^;]+;base64,/, '');
                        const finalName = `jimeng_img_${Date.now()}_${i + 1}.png`;
                        const finalPath = path.join(imagesDir, finalName);
                        fs.writeFileSync(finalPath, Buffer.from(base64Data, 'base64'));
                        const size = fs.statSync(finalPath).size;
                        console.log(`[即梦图片] fallback第${i + 1}张下载完成: ${finalName} (${(size / 1024).toFixed(1)}KB)`);
                        results.push(`/images/${finalName}`);
                    }
                } catch (e) {
                    console.error(`[即梦图片] fallback第${i + 1}张下载失败:`, e.message);
                }
            }
        }
    } catch (err) {
        console.error('[即梦图片] _extractAllImagesByDownload error:', err.message);
    }

    return results;
}

/**
 * 从 get_asset_list 响应中扫描图片 URL
 */
function _scanImageFromResponse(json, submitId) {
    if (!json) return null;
    try {
        const assetList = json.asset_list || json.data?.asset_list || json.data?.data?.asset_list || [];
        const arr = Array.isArray(assetList) ? assetList : [];
        for (const asset of arr) {
            if (submitId && (!asset.submit_id || asset.submit_id !== submitId)) continue;
            // 查找图片 URL（各种可能的字段名）
            const url = asset.cover_url || asset.image_url || asset.url || asset.origin_url;
            if (url && typeof url === 'string' && url.startsWith('http')) {
                console.log(`[即梦图片] 从 get_asset_list 找到图片: ${url.substring(0, 80)}`);
                return url;
            }
            // 递归查找
            const deepUrl = _deepFindImageUrl(asset);
            if (deepUrl) return deepUrl;
        }
    } catch (e) {
        console.error('[即梦图片] _scanImageFromResponse error:', e.message);
    }
    return null;
}

function _deepFindImageUrl(obj) {
    if (!obj || typeof obj !== 'object') return null;
    for (const key of ['cover_url', 'image_url', 'origin_url', 'url']) {
        if (obj[key] && typeof obj[key] === 'string' && obj[key].startsWith('http') &&
            !obj[key].includes('vlabstatic.com') && !obj[key].includes('/static/')) {
            return obj[key];
        }
    }
    for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'object') {
            const found = _deepFindImageUrl(obj[key]);
            if (found) return found;
        }
    }
    return null;
}

/**
 * 处理找到图片 URL
 */
async function _handleImageFound(task, taskId, imageUrl) {
    console.log(`[即梦图片] 任务完成: ${taskId}, URL: ${imageUrl.substring(0, 80)}`);
    task.message = '正在下载图片到本地...';
    task.progress = 96;

    try {
        const imagesDir = path.join(DATA_DIR, 'images');
        if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

        // CDP下载的本地文件（file://开头）
        if (imageUrl.startsWith('file://')) {
            const localPath = imageUrl.replace('file://', '');
            if (fs.existsSync(localPath)) {
                const size = fs.statSync(localPath).size;
                const filename = path.basename(localPath);
                console.log(`[即梦图片] 本地文件: ${localPath} (${(size / 1024).toFixed(1)}KB)`);
                task.imageUrl = `/images/${filename}`;
                task.status = 'completed';
                task.message = '图片生成完成！';
                task.progress = 100;
                await saveCookies();
                return;
            }
        }

        const filename = `jimeng_img_${Date.now()}.jpg`;
        const outputPath = path.join(imagesDir, filename);

        // 下载图片
        await new Promise((resolve, reject) => {
            const client = imageUrl.startsWith('https') ? https : http;
            const file = fs.createWriteStream(outputPath);
            client.get(imageUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': 'https://jimeng.jianying.com/',
                },
            }, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    file.close();
                    response.resume();
                    const redirectUrl = response.headers.location;
                    const client2 = redirectUrl.startsWith('https') ? https : http;
                    const file2 = fs.createWriteStream(outputPath);
                    client2.get(redirectUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp2) => {
                        if (resp2.statusCode !== 200) { file2.close(); resp2.resume(); reject(new Error(`HTTP ${resp2.statusCode}`)); return; }
                        resp2.pipe(file2);
                        file2.on('finish', () => { file2.close(); resolve(); });
                    }).on('error', reject);
                    return;
                }
                if (response.statusCode !== 200) { file.close(); response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
                response.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
            }).on('error', reject);
        });

        const size = fs.statSync(outputPath).size;
        console.log(`[即梦图片] 图片已下载: ${outputPath} (${(size / 1024).toFixed(1)}KB)`);
        task.imageUrl = `/images/${filename}`;
    } catch (dlErr) {
        console.error(`[即梦图片] 图片下载失败，使用远程URL:`, dlErr.message);
        task.imageUrl = imageUrl;
    }

    task.status = 'completed';
    task.message = '图片生成完成！';
    task.progress = 100;
    await saveCookies();
}

// ==================== 导出 ====================

/**
 * 添加新的即梦账号
 * @param {string} accountId - 账号标识（如 'account2'）
 * @param {string} name - 显示名称（如 '账号2'）
 */
function addAccount(accountId, name) {
    if (_accounts.has(accountId)) {
        return { ok: false, error: '账号ID已存在' };
    }
    // 分配 CDP 端口：默认9222，之后递增
    const usedPorts = new Set([..._accounts.values()].map(a => a.cdpPort));
    let port = CONFIG.cdpPort + 1;
    while (usedPorts.has(port)) port++;

    _accounts.set(accountId, _createAccountState(accountId, port, name));
    _saveAccountsToConfig();
    console.log(`[即梦] 已添加账号: ${name} (端口${port})`);
    return { ok: true, accountId, cdpPort: port };
}

/**
 * 删除即梦账号
 */
async function removeAccount(accountId) {
    if (accountId === 'default') {
        return { ok: false, error: '不能删除默认账号' };
    }
    const acct = _accounts.get(accountId);
    if (!acct) {
        return { ok: false, error: '账号不存在' };
    }
    // 关闭该账号的浏览器
    await killChrome(accountId);
    _accounts.delete(accountId);
    _saveAccountsToConfig();
    console.log(`[即梦] 已删除账号: ${acct.name}`);
    return { ok: true };
}

/**
 * 获取所有账号列表（含状态）
 */
function getAccountList() {
    const list = [];
    for (const acct of _accounts.values()) {
        list.push({
            id: acct.id,
            name: acct.name,
            cdpPort: acct.cdpPort,
            connected: !!(acct.browser && acct.browser.isConnected()),
            activeTasks: acct.activeTaskCount,
        });
    }
    return list;
}

/**
 * 初始化所有已注册账号的浏览器
 */
async function initAllBrowsers() {
    const results = [];
    for (const acct of _accounts.values()) {
        try {
            await initBrowser(acct.id);
            results.push({ id: acct.id, name: acct.name, ok: true });
        } catch (err) {
            results.push({ id: acct.id, name: acct.name, ok: false, error: err.message });
        }
    }
    return results;
}

/**
 * 将账号列表保存到 config.json
 */
function _saveAccountsToConfig() {
    try {
        const cfgPath = path.join(
            process.env.APPDATA || path.join(os.homedir(), '.config'),
            'video-workflow', 'config.json'
        );
        let cfg = {};
        if (fs.existsSync(cfgPath)) {
            cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        }
        cfg.jimengAccounts = [];
        for (const acct of _accounts.values()) {
            if (acct.id !== 'default') {
                cfg.jimengAccounts.push({ id: acct.id, name: acct.name, cdpPort: acct.cdpPort });
            }
        }
        const dir = path.dirname(cfgPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
    } catch (e) {
        console.error('[即梦] 保存账号配置失败:', e.message);
    }
}

module.exports = {
    initBrowser,
    checkLoginStatus,
    openLoginPage,
    submitVideoTask,
    submitImageTask,
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
