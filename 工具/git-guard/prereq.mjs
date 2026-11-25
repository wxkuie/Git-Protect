// 环境自查：装完就能用吗？缺什么、怎么补。
// 这些判断都做成纯函数，测试里可以注入假的执行器，不需要真的缺 git 再跑一遍。
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const isWin = process.platform === 'win32';

// 跑一条命令看看结果；找不到可执行文件时返回 ok=false 而不是抛异常
export function runCommand(file, args, opts) {
  const options = opts || {};
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 15000,
    env: options.env || process.env
  });
  if (r.error) return { ok: false, out: '', error: r.error.code === 'ENOENT' ? '找不到这个命令' : r.error.message };
  const out = String(r.stdout || '').trim();
  return { ok: r.status === 0, out: out, error: r.status === 0 ? '' : String(r.stderr || out).trim() };
}

function firstLine(text) { return String(text || '').split(/\r?\n/).filter(Boolean)[0] || ''; }

// 检查 git：这个工具所有的提交动作都靠它
export function checkGit(exec) {
  const r = exec('git', ['--version']);
  if (!r.ok) return { id: 'git', ok: false, title: 'Git', detail: '没找到 git，这个工具靠 git 提交，装好它才能用。', fix: 'download' };
  return { id: 'git', ok: true, title: 'Git', detail: firstLine(r.out), fix: null };
}

// 检查 PowerShell 7：只有「弹窗提醒」模式需要它；缺了会静默不弹窗，所以要在入口拦住
export function checkPwsh(exec) {
  const r = exec('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
  if (!r.ok) return { id: 'pwsh', ok: false, title: 'PowerShell 7', detail: '没找到 pwsh。确认提交的窗口需要它，缺了会什么都不发生。', fix: 'download' };
  const major = Number(firstLine(r.out));
  if (!Number.isFinite(major) || major < 7) {
    return { id: 'pwsh', ok: false, title: 'PowerShell 7', detail: '当前的 PowerShell 版本是 ' + firstLine(r.out) + '，需要 7 或更高。', fix: 'download' };
  }
  return { id: 'pwsh', ok: true, title: 'PowerShell 7', detail: '版本 ' + firstLine(r.out), fix: null };
}

// 检查提交身份：缺了 git commit 必然失败，提前拦住比事后报错好
export function checkIdentity(exec) {
  const name = exec('git', ['config', '--get', 'user.name']);
  const mail = exec('git', ['config', '--get', 'user.email']);
  const hasName = name.ok && !!name.out;
  const hasMail = mail.ok && !!mail.out;
  if (hasName && hasMail) return { id: 'identity', ok: true, title: '提交身份', detail: name.out + ' <' + mail.out + '>', fix: null };
  const missing = [!hasName ? 'user.name' : '', !hasMail ? 'user.email' : ''].filter(Boolean).join(' 和 ');
  return {
    id: 'identity',
    ok: false,
    title: '提交身份',
    detail: '还没配置 ' + missing + '，提交会失败。',
    fix: 'config',
    commands: [
      'git config --global user.name "你的名字"',
      'git config --global user.email "你的邮箱"'
    ]
  };
}

// 汇总：ok 为真表示三项都齐了，可以正常使用
export function inspectPrereqs(opts) {
  const options = opts || {};
  const exec = options.exec || runCommand;
  const only = Array.isArray(options.only) && options.only.length ? new Set(options.only) : null;
  const items = [];
  if (!only || only.has('git')) items.push(checkGit(exec));
  if (!only || only.has('pwsh')) items.push(checkPwsh(exec));
  // 连 git 都没有的时候，「提交身份」这项没有意义（git 都跑不起来），先不报免得吓人
  const gitItem = items.find(function (x) { return x.id === 'git'; });
  if ((!only || only.has('identity')) && (!gitItem || gitItem.ok)) items.push(checkIdentity(exec));
  // 仅测试用：GIT_GUARD_PREREQ_FAKE=pwsh 可以把某项强制标成缺失，
  // 免得为了测「缺依赖」去真的卸载软件。生产环境下这个变量没人设。
  const fake = String((options.env || process.env).GIT_GUARD_PREREQ_FAKE || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (fake.length) {
    for (const item of items) {
      if (fake.indexOf(item.id) >= 0) {
        item.ok = false;
        item.fix = item.fix || 'download';
        item.detail = '[测试] 模拟缺失：' + item.detail;
      }
    }
  }
  const missing = items.filter(function (x) { return !x.ok; });
  return { ok: missing.length === 0, items: items, missing: missing.map(function (x) { return x.id; }) };

}

// ---- 安装包地址：从 GitHub 的发布信息里挑，别把版本号写死 ----

// Git for Windows：release 里挑 64 位安装器
export function pickGitAsset(release) {
  const assets = (release && release.assets) || [];
  const hit = assets.find(function (a) { return /^Git-.*-64-bit\.exe$/i.test(a.name); });
  return hit ? { name: hit.name, url: hit.browser_download_url, size: hit.size } : null;
}

// PowerShell：最新版常常只发 zip（没 MSI），所以按时间从新到旧找第一个带 x64 MSI 的稳定版
export function pickPowerShellMsi(releases) {
  const list = Array.isArray(releases) ? releases : [];
  for (const rel of list) {
    if (!rel || rel.draft || rel.prerelease) continue;
    const hit = (rel.assets || []).find(function (a) { return /^PowerShell-.*-win-x64\.msi$/i.test(a.name); });
    if (hit) return { name: hit.name, url: hit.browser_download_url, size: hit.size, version: rel.tag_name };
  }
  return null;
}

// 国内网络下 GitHub 经常连不上，Git 有现成镜像可退：镜像返回的是版本目录列表
export function pickMirrorGitTag(listing) {
  const list = Array.isArray(listing) ? listing : [];
  const tags = list
    .map(function (x) { return String((x && x.name) || ''); })
    .map(function (n) { return n.replace(/\/$/, ''); })
    .filter(function (n) { return /^v\d+\.\d+\.\d+\.windows\.\d+$/.test(n); });
  if (!tags.length) return null;
  // 镜像按版本递增排列，取最后一个就是最新
  return tags[tags.length - 1];
}

// 国内网络下 GitHub 经常连不上，Git 有现成镜像可退
export function mirrorGitAsset(version) {
  if (!version) return null;
  const name = 'Git-' + String(version).replace(/^v/, '').replace(/\.windows\.\d+$/, '') + '-64-bit.exe';
  const tag = String(version).startsWith('v') ? version : 'v' + version;
  return {
    name: name,
    url: 'https://registry.npmmirror.com/-/binary/git-for-windows/' + tag + '/' + name,
    size: 0,
    mirror: true
  };
}

// 下载目标目录：放用户自己的下载文件夹里，别塞进安装目录
export function downloadDir(home) {
  const base = home || (isWin ? process.env.USERPROFILE : process.env.HOME) || '.';
  return path.join(base, 'Downloads', 'GitQuietHelper-依赖');
}

export const GIT_RELEASES_API = 'https://api.github.com/repos/git-for-windows/git/releases/latest';
export const PS_RELEASES_API = 'https://api.github.com/repos/PowerShell/PowerShell/releases?per_page=8';
export const GIT_MIRROR_LISTING = 'https://registry.npmmirror.com/-/binary/git-for-windows/';