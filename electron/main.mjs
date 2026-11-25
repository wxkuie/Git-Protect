import { app, BrowserWindow, dialog, Tray, Menu, nativeImage, Notification } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPanel } from '../工具/git-guard/panel.mjs';
import { watchAutoCommits } from './notify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const iconPath = path.join(here, '..', '图标-多尺寸.ico');

let win = null;
let panel = null;
let tray = null;
let quitting = false;
let notifier = null;
// Windows 上没有这个标识，系统通知会被静默丢弃（不报错，只是不显示）
// 取 Electron 给这个应用算出来的默认值，避免和注册表/快捷方式里的标识对不上
app.setAppUserModelId('electron.app.GitQuietHelper');
let toldAboutTray = false;
// 开机自启动时带 --autostart：只留托盘，不把窗口甩到用户脸上
const startedByLogin = process.argv.includes('--autostart');

// 写 HKCU\...\Run。用 Electron 自带接口而不是 reg.exe：它会处理好引号和路径
function applyAutoStart(enabled) {
  const args = app.isPackaged ? ['--autostart'] : [path.resolve(here, '..'), '--autostart'];
  app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath, args: args });
  const now = app.getLoginItemSettings({ path: process.execPath, args: args });
  return { openAtLogin: !!now.openAtLogin };
}
// 排查窗口自己消失这类问题时，用 GIT_GUARD_DEBUG_MAIN=1 启动可以看到事件顺序
const log = process.env.GIT_GUARD_DEBUG_MAIN === '1' ? function () { console.log('[gqh]', ...arguments); } : function () {};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async function () {
    try {
      // 端口 0：由系统分配，避免和用户已开的浏览器面板抢 7331
      // 数据放用户目录，安装目录可能只读；打开窗口即自动开始监视
      panel = await startPanel({
        port: 0,
        dataDir: app.getPath('userData'),
        autoStartMonitor: true,
        setAutoStart: applyAutoStart,
        // 让面板能弹原生选目录对话框，省掉让用户手打路径
        pickFolder: async function () {
          const target = win && !win.isDestroyed() ? win : undefined;
          const result = await dialog.showOpenDialog(target, {
            title: '选择要监视的文件夹',
            buttonLabel: '扫描这个文件夹',
            properties: ['openDirectory']
          });
          if (result.canceled || !result.filePaths || !result.filePaths.length) return null;
          return result.filePaths[0];
        }
      });
    } catch (e) {
      dialog.showErrorBox('启动失败', '内置服务起不来：' + e.message);
      app.quit();
      return;
    }

    win = new BrowserWindow({
      // 按内容尺寸定窗口：否则边框吃掉十几个像素，页面拿到的宽度比配置的小，右边会顶出去
      useContentSize: true,
      width: 700,
      height: 760,
      minWidth: 620,
      minHeight: 560,
      maximizable: false,
      autoHideMenuBar: true,
      backgroundColor: '#e9ecf0',
      title: 'Git 静默提交助手',
      icon: iconPath,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    win.removeMenu();

    win.once('ready-to-show', function () {
      log('ready-to-show');
      // 自启动时静默驻留；但托盘没建起来就没有任何入口，这时还是把窗口显示出来
      if (!startedByLogin || !tray) win.show();
    });
    // 关闭窗口只是收进托盘：监视还要继续跑，否则「关掉窗口自动提交就停了」会让人意外
    win.on('close', function (e) {
      log('close event, quitting=' + quitting + ' tray=' + !!tray);
      if (quitting || !tray) return;
      e.preventDefault();
      win.hide();
      if (!toldAboutTray) {
        toldAboutTray = true;
        try { tray.displayBalloon({ title: '仍在监视', content: '窗口已收进托盘，自动提交继续运行。要退出请用托盘菜单。', icon: iconPath }); } catch (err) {}
      }
    });
    win.on('closed', function () { log('closed'); win = null; });
    win.on('hide', function () { log('hidden'); });
    win.on('show', function () { log('shown'); });
    win.on('blur', function () { log('blur'); });
    win.on('minimize', function () { log('minimize'); });
    win.webContents.on('render-process-gone', function (e, d) { log('render-process-gone ' + JSON.stringify(d)); });
    win.webContents.on('did-fail-load', function (e, code, desc) { log('did-fail-load ' + code + ' ' + desc); });

    createTray();
    startCommitNotifier();
    win.webContents.setWindowOpenHandler(function () { return { action: 'deny' }; });

    try {
      await win.loadURL(panel.url);
    } catch (e) {
      dialog.showErrorBox('加载失败', e.message);
    }
  });

  // 「自动提交并通知」模式下的提交提示：主进程盯着提交记录文件，跟窗口开没开无关
  function startCommitNotifier() {
    if (!Notification.isSupported()) { log('系统不支持通知'); return; }
    notifier = watchAutoCommits({
      file: path.join(app.getPath('userData'), 'state', 'auto-commits.jsonl'),
      onCommit: function (entry) {
        const name = String(entry.repo || '').split(/[\\/]/).filter(Boolean).pop() || '';
        const parts = [];
        if (name) parts.push(name);
        if (entry.count) parts.push(entry.count + ' 个文件');
        if (entry.commit) parts.push(String(entry.commit).slice(0, 7));
        try {
          const note = new Notification({
            title: '已自动提交',
            body: parts.join(' · '),
            icon: iconPath
          });
          // show 由系统确认已展示；failed 是系统拒绝。两者都记下来，排查「通知不弹」时不用猜
          note.on('show', function () { log('通知已显示：' + parts.join(' · ')); });
          note.on('failed', function (ev, err) { log('通知被系统拒绝：' + err); });
          note.on('click', showWindow);
          note.show();
          log('通知已发出：' + parts.join(' · '));
        } catch (e) { log('通知失败：' + e.message); }
      }
    });
  }

  function createTray() {
    try {
      const image = nativeImage.createFromPath(iconPath);
      tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
      tray.setToolTip('Git 静默提交助手');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '显示窗口', click: showWindow },
        { type: 'separator' },
        { label: '退出', click: function () { quitting = true; app.quit(); } }
      ]));
      tray.on('click', showWindow);
    } catch (e) {
      // 托盘建不起来就退回「关窗口即退出」，不留一个只能从任务管理器关掉的进程
      tray = null;
      console.error('托盘创建失败：' + e.message);
    }
  }

  function showWindow() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  app.on('window-all-closed', function () { if (!tray) app.quit(); });

  app.on('before-quit', function () {
    quitting = true;
    if (notifier) { try { notifier.stop(); } catch (e) {} notifier = null; }
    if (tray) { try { tray.destroy(); } catch (e) {} tray = null; }
    if (!panel) return;
    try { panel.stop(); } catch (e) {}
    panel = null;
  });
}
