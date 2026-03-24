/**
 * Electron 主进程
 */
import { app, BrowserWindow, ipcMain, dialog, shell, Menu, globalShortcut } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Windows 高 DPI 支持
app.commandLine.appendSwitch('high-dpi-support', '1');
// 强制 125% 渲染比例 — Chromium 在渲染层面以更高 DPI 绘制，文字图片都清晰
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('force-device-scale-factor', '1.25');
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: '视频创作工作流',
    backgroundColor: '#FFF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: 1.0,
    },
  });

  // 开发模式打开DevTools
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // 捕获渲染进程控制台错误并写日志
  const errLogPath = path.join(app.getPath('userData'), 'renderer-errors.log');
  fs.writeFileSync(errLogPath, `=== App started: ${new Date().toISOString()} ===\n`);
  mainWindow.webContents.on('console-message', (e, level, msg, line, source) => {
    if (level >= 2) { // error/warning
      fs.appendFileSync(errLogPath, `[L${level}] ${source}:${line} → ${msg}\n`);
    }
  });
  mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
    fs.appendFileSync(errLogPath, `did-fail-load: code=${code} desc=${desc}\n`);
  });

  // 右键菜单
  mainWindow.webContents.on('context-menu', (e, params) => {
    const menuItems = [];

    // URL → 本地文件路径
    const resolveFilePath = (url) => {
      // /images/xxx → userData/images/xxx
      const m = url.match(/\/images\/(.+)$/);
      if (m) {
        const fp = path.join(app.getPath('userData'), 'images', decodeURIComponent(m[1]));
        if (fs.existsSync(fp)) return fp;
      }
      // /api/local-file?path=xxx → 提取绝对路径
      const lf = url.match(/\/api\/local-file\?path=(.+)$/);
      if (lf) {
        const fp = decodeURIComponent(lf[1]);
        if (fs.existsSync(fp)) return fp;
      }
      // Windows 绝对路径 (C:\...)
      if (/^[A-Z]:\\/i.test(url)) {
        if (fs.existsSync(url)) return url;
      }
      // file:// 协议
      if (url.startsWith('file:///')) {
        const fp = decodeURIComponent(url.replace('file:///', ''));
        if (fs.existsSync(fp)) return fp;
      }
      return '';
    };

    if (params.mediaType === 'image') {
      menuItems.push({
        label: '查看大图',
        click: () => mainWindow.webContents.executeJavaScript(`showLargeImage(${JSON.stringify(params.srcURL)}, '')`),
      });
      menuItems.push({
        label: '打开图片文件夹',
        click: () => {
          const fp = resolveFilePath(params.srcURL);
          if (fp) shell.showItemInFolder(fp);
          else shell.openPath(path.join(app.getPath('userData'), 'images'));
        },
      });
      menuItems.push({ type: 'separator' });
    }
    if (params.mediaType === 'video') {
      menuItems.push({
        label: '打开视频所在位置',
        click: () => {
          const fp = resolveFilePath(params.srcURL);
          if (fp) shell.showItemInFolder(fp);
          else shell.openPath(path.join(app.getPath('userData'), 'images'));
        },
      });
      menuItems.push({ type: 'separator' });
    }
    if (params.isEditable) {
      menuItems.push({ role: 'cut', label: '剪切' });
      menuItems.push({ role: 'paste', label: '粘贴' });
    }
    if (params.selectionText) {
      menuItems.push({ role: 'copy', label: '复制' });
    }
    menuItems.push({ role: 'selectAll', label: '全选' });
    if (menuItems.length) {
      Menu.buildFromTemplate(menuItems).popup();
    }
  });

  // 缩放快捷键 Ctrl+/Ctrl-/Ctrl+0 + F12开发者工具
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.key === 'F12') {
      e.preventDefault();
      mainWindow.webContents.toggleDevTools();
      return;
    }
    if (!input.control) return;
    const wc = mainWindow.webContents;
    if (input.key === '=' || input.key === '+') {
      e.preventDefault();
      wc.setZoomLevel(wc.getZoomLevel() + 0.5);
    } else if (input.key === '-') {
      e.preventDefault();
      wc.setZoomLevel(wc.getZoomLevel() - 0.5);
    } else if (input.key === '0') {
      e.preventDefault();
      wc.setZoomLevel(0);
    }
  });
}

// IPC: 选择文件夹
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// IPC: 选择文件
ipcMain.handle('select-file', async (_, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: '文本文件', extensions: ['txt', 'md'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

// IPC: 打开外部链接
ipcMain.handle('open-external', (_, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    return shell.openExternal(url);
  }
});

// IPC: 在文件管理器中显示文件
ipcMain.handle('show-in-folder', (_, filePath) => {
  if (typeof filePath === 'string' && filePath.length > 0) {
    shell.showItemInFolder(filePath);
  }
});

// IPC: 选择视频文件
ipcMain.handle('select-video', async (event, defaultPath) => {
  const opts = {
    properties: ['openFile'],
    filters: [{ name: '视频文件', extensions: ['mp4', 'webm', 'mov', 'avi', 'mkv'] }],
  };
  if (defaultPath && fs.existsSync(defaultPath)) opts.defaultPath = defaultPath;
  const result = await dialog.showOpenDialog(mainWindow, opts);
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(async () => {
  // 设置应用数据目录环境变量（供 server.mjs 和 jimeng-service.cjs 使用）
  // 必须在 import server.mjs 之前设置，因为 server.mjs 模块加载时会读取此变量
  process.env.APP_USER_DATA = app.getPath('userData');

  // 动态导入服务器模块（确保 APP_USER_DATA 已设置）
  const { startServer } = await import('./server.mjs');

  // 启动内嵌服务器
  const port = await startServer();
  console.log(`内嵌服务器已启动: http://localhost:${port}`);

  createWindow();

  // 从Express提供前端页面（避免file://协议CORS问题）
  mainWindow.loadURL(`http://127.0.0.1:${port}/app`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
