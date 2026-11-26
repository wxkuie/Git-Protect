#!/usr/bin/env node
// 项目3 配置面板：零依赖本地 HTTP 服务。
// 只做配置、状态查看与监视进程的启停；提交仍由 guard.mjs 内核执行，不另造提交引擎。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { scan, recoveryReport, clearRecovery, useStateDir } from './guard.mjs';
// 状态行与分支列表在工作线程里算：同步 git 会卡住整个 HTTP 服务（实测单次重算 5 秒）
import { projectRows, branchList as branchListSync, currentBranchOf } from './panel-facts.mjs';
import { inspectPrereqs, pickGitAsset, pickPowerShellMsi, pickMirrorGitTag, mirrorGitAsset, downloadDir, GIT_RELEASES_API, PS_RELEASES_API, GIT_MIRROR_LISTING } from './prereq.mjs';
import https from 'node:https';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiPath = path.join(here, 'panel', 'ui.html');
// 打包后安装目录可能只读，配置与状态必须能落到用户目录；默认仍是仓库内（已忽略入库）。
let configPath = path.join(here, 'config.json');
// 与 guard.mjs 的默认值保持一致：环境里显式给了状态目录就跟着走，
// 否则独立跑浏览器面板时两边会各读各的 .state。
let stateDir = path.resolve(process.env.GIT_GUARD_STATE || path.join(here, '.state'));
let logPath = path.join(stateDir, 'panel-monitor.log');

// 配置面只留三样全局项（模式、停手时长、提交说明）加项目列表：
// 逐项目设模式/说明/停手只会让人反复点，习惯本来也是全局的。
// 轮询与冷却保留默认值，不再暴露到界面。
const DEFAULTS = { mode: 'remind', idleSeconds: 600, pollSeconds: 30, cooldownSeconds: 7200, autoStart: false, projects: [] };
const LIMITS = { idleSeconds: [5, 86400], pollSeconds: [5, 3600], cooldownSeconds: [60, 604800] };
const MODES = ['remind', 'notify', 'silent'];

function fail(message, status) { const e = new Error(message); e.status = status || 400; return e; }

function normalizePath(value) { return typeof value === 'string' ? value.trim().replace(/\\/g, '/') : ''; }

// 项目只剩三件事：路径、是否启用、锁定分支。模式/说明/停手都由全局决定。
function normalizeProject(input) {
  const out = { path: '', enabled: true, branch: '' };
  if (input && typeof input === 'object') {
    out.path = normalizePath(input.path);
    if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
    if (typeof input.branch === 'string') out.branch = input.branch.trim();
  }
  return out;
}

function normalize(input) {
  const out = Object.assign({}, DEFAULTS);
  out.projects = [];
  if (input && typeof input === 'object') {
    for (const key of ['idleSeconds', 'pollSeconds', 'cooldownSeconds']) {
      const value = Number(input[key]);
      if (Number.isFinite(value)) out[key] = Math.round(value);
    }
    if (typeof input.mode === 'string' && MODES.indexOf(input.mode) >= 0) out.mode = input.mode;
    if (typeof input.autoStart === 'boolean') out.autoStart = input.autoStart;
    out.projects = Array.isArray(input.projects) ? input.projects.map(normalizeProject) : [];
  }
  return out;
}

function readConfig() {
  try {
    return normalize(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (e) {
    if (e.code === 'ENOENT') return normalize({});
    throw fail('配置文件无法解析：' + e.message, 500);
  }
}

function branchProblem(branch, label) {
  if (!branch) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) return label + '名不合法';
  return null;
}

function validate(input) {
  const config = normalize(input);
  const problems = [];
  // 轮询与冷却不再暴露到界面，但仍来自配置，越界照样拦
  for (const key of Object.keys(LIMITS)) {
    const pair = LIMITS[key], value = config[key];
    if (!(value >= pair[0] && value <= pair[1])) problems.push(key + ' 需在 ' + pair[0] + ' 到 ' + pair[1] + ' 之间');
  }
  if (MODES.indexOf(config.mode) < 0) problems.push('未知提交模式：' + config.mode);

  const seen = new Set();
  for (const project of config.projects) {
    const label = project.path || '(未填路径)';
    if (!project.path) { problems.push('有项目没有填路径'); continue; }
    if (!fs.existsSync(project.path)) problems.push('项目路径不存在：' + label);
    else if (!fs.statSync(project.path).isDirectory()) problems.push('项目路径不是文件夹：' + label);
    else {
      const problem = repoProblem(project.path);
      if (problem) problems.push(problem + '（' + label + '）');
    }
    const key = project.path.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) problems.push('项目重复添加：' + label);
    seen.add(key);
    const bp = branchProblem(project.branch, '项目分支');
    if (bp) problems.push(bp + '（' + label + '）');
  }
  if (problems.length) throw fail(problems.join('；'), 400);
  return config;
}

function writeConfig(config) {
  const temp = configPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, configPath);
}

let child = null;
let startedAt = null;
let lastExit = null;

function monitorRunning() { return !!child && child.exitCode === null && !child.killed; }

function monitorStatus() {
  const running = monitorRunning();
  return { running: running, pid: running ? child.pid : null, startedAt: running ? startedAt : null, lastExit: lastExit, logPath: logPath };
}

function startMonitor() {
  if (monitorRunning()) throw fail('监视已经在运行', 409);
  const config = validate(readConfig());
  writeConfig(config);
  fs.mkdirSync(stateDir, { recursive: true });
  const out = fs.openSync(logPath, 'a');
  let proc;
  try {
    const childEnv = Object.assign({}, process.env);
    // 在 Electron 里 process.execPath 是 electron.exe，需让它按纯 Node 运行子进程
    if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = '1';
    childEnv.GIT_GUARD_STATE = stateDir;
    proc = spawn(process.execPath, [path.join(here, 'guard.mjs'), 'monitor', '--config', configPath], {
      cwd: here, windowsHide: true, stdio: ['ignore', out, out], env: childEnv
    });
  } finally {
    fs.closeSync(out);
  }
  fs.appendFileSync(logPath, '\n=== 启动监视 ' + new Date().toISOString() + '，' + (config.projects || []).length + ' 个项目 ===\n', 'utf8');
  child = proc;
  startedAt = new Date().toISOString();
  lastExit = null;
  proc.on('exit', function (code, signal) {
    lastExit = { code: code, signal: signal, at: new Date().toISOString() };
    if (child === proc) { child = null; startedAt = null; }
  });
  proc.on('error', function (err) {
    lastExit = { code: null, signal: null, at: new Date().toISOString(), error: err.message };
    if (child === proc) { child = null; startedAt = null; }
  });
  return monitorStatus();
}

// 正在跑的监视用的是它启动那一刻的配置，保存后不重启的话，新设置要等用户手动停了再开才生效。
async function restartMonitor() {
  const old = child;
  if (old) {
    child = null; startedAt = null;
    try { old.kill(); } catch (e) {}
    await new Promise(function (resolve) {
      const timer = setTimeout(resolve, 3000);
      old.once('exit', function () { clearTimeout(timer); resolve(); });
    });
  }
  return startMonitor();
}

function stopMonitor() {
  if (!monitorRunning()) throw fail('监视没有在运行', 409);
  child.kill();
  return monitorStatus();
}

function gitOut(repo, args) {
  const out = spawnSync('git', ['-C', repo].concat(args), { encoding: 'utf8', windowsHide: true });
  return out.status === 0 ? String(out.stdout || '') : '';
}

function gitAvailable() {
  const out = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  return !out.error && out.status === 0;
}

// 把「这个路径为什么不能当项目」说清楚，而不是只丢一句「不是 Git 工作树根」。
function repoProblem(dir) {
  if (!gitAvailable()) return '找不到 git 命令，请先安装 Git 并加入 PATH';
  const top = gitOut(dir, ['rev-parse', '--show-toplevel']).trim();
  const normalize = function (v) { return String(v).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); };
  if (!top) return '不是 Git 仓库：先在这个目录执行 git init，或改填已有的仓库根目录';
  if (normalize(top) !== normalize(dir)) return '这是仓库 ' + top + ' 的子目录，请改填该仓库根目录';
  return null;
}


// 自动提交是「先做后报」，界面要能把这些记录捞出来给用户看。
function recentAutoCommits(limit) {
  try {
    const file = path.join(stateDir, 'auto-commits.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const take = lines.slice(-(limit || 20)).reverse();
    const items = [];
    for (const line of take) {
      try { items.push(JSON.parse(line)); } catch (e) {}
    }
    return items;
  } catch (e) { return []; }
}

// 添加项目前先体检：路径能不能用、为什么不能用、分支有哪些、身份是否就绪。
function checkPath(target) {
  const dir = normalizePath(target);
  if (!dir) return { ok: false, problem: '路径为空' };
  if (!fs.existsSync(dir)) return { ok: false, problem: '路径不存在：' + dir };
  if (!fs.statSync(dir).isDirectory()) return { ok: false, problem: '这个路径不是文件夹：' + dir };
  const problem = repoProblem(dir);
  if (problem) return { ok: false, problem: problem };
  const current = currentBranchOf(dir);
  const branches = gitOut(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
    .split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  return {
    ok: true, path: dir, current: current, branches: branches,
    identityOk: !!gitOut(dir, ['var', 'GIT_AUTHOR_IDENT']).trim()
  };
}


// 状态行与分支列表都在工作线程里算，主线程只读缓存。
// 之前是同步算的：一次重算约 1.2 秒起，界面轮询叠加时单个请求要等 5 秒，整个窗口像死了一样。
let factsWorker = null;
let factsSeq = 0;
const factsPending = new Map();

function ensureFactsWorker() {
  if (factsWorker) return factsWorker;
  factsWorker = new Worker(new URL('./panel-facts.worker.mjs', import.meta.url));
  factsWorker.on('message', function (msg) {
    const done = factsPending.get(msg.id);
    if (!done) return;
    factsPending.delete(msg.id);
    if (msg.error) done.reject(new Error(msg.error)); else done.resolve(msg.data);
  });
  factsWorker.on('error', function () {
    // 线程挂了就让它下次重建，并把等待中的请求放掉，界面退回同步计算而不是一直等
    for (const done of factsPending.values()) done.reject(new Error('状态线程异常'));
    factsPending.clear();
    factsWorker = null;
  });
  factsWorker.unref();
  return factsWorker;
}

// 线程起不来（很少见）就退回同步算：慢，但至少给得出结果
function facts(kind, config) {
  return new Promise(function (resolve, reject) {
    let worker;
    try { worker = ensureFactsWorker(); } catch (e) {
      try { resolve(kind === 'branches' ? branchListSync(config) : projectRows(config)); } catch (err) { reject(err); }
      return;
    }
    const id = ++factsSeq;
    factsPending.set(id, { resolve: resolve, reject: reject });
    // 状态线程是独立模块实例：把当前状态目录随任务带上，避免线程里还停在旧目录。
    try { worker.postMessage({ id: id, kind: kind, config: config, stateDir: stateDir }); }
    catch (e) { factsPending.delete(id); reject(e); }
  });
}

let rowsCache = { at: 0, ttl: 4000, stamp: '', rows: [], fallback: false };
let rowsRefresh = null;

function refreshRows(config, stamp) {
  if (rowsRefresh) return rowsRefresh;
  const started = Date.now();
  rowsRefresh = facts('rows', config).then(function (rows) {
    // 计算比缓存期长时按耗时定缓存期，避免刚算完就判过期、每请求都重算
    rowsCache = { at: Date.now(), ttl: Math.max(4000, (Date.now() - started) * 2), stamp: stamp, rows: rows, fallback: config.projects.length === 0 };
    return rows;
  }).finally(function () { rowsRefresh = null; });
  return rowsRefresh;
}

// 项目集合的指纹：变了就必须重算，只是过期则可以先用旧值顶着
function rowsStamp(config) {
  return JSON.stringify(config.projects.map(function (p) { return [p.path, p.enabled, p.branch, p.idleSeconds]; }));
}

async function projectStatus() {
  const config = readConfig();
  const stamp = rowsStamp(config);
  const sameSet = rowsCache.stamp === stamp;
  const fresh = sameSet && Date.now() - rowsCache.at <= rowsCache.ttl;
  if (!fresh) {
    const pending = refreshRows(config, stamp);
    // 项目集合变了就得等新结果，否则界面会短暂显示已经删掉的项目；只是过期则先给旧值
    if (!sameSet) { try { await pending; } catch (e) {} }
  }
  return {
    projects: rowsCache.rows, fallback: rowsCache.fallback,
    cachedAt: new Date(rowsCache.at).toISOString(),
    refreshing: !!rowsRefresh
  };
}

let branchCache = { at: 0, ttl: 30000, stamp: '', items: [] };
let branchRefresh = null;

async function branchList() {
  const config = readConfig();
  const stamp = JSON.stringify(config.projects.map(function (p) { return [p.path, p.enabled]; }));
  const fresh = branchCache.stamp === stamp && Date.now() - branchCache.at <= branchCache.ttl;
  if (!fresh && !branchRefresh) {
    const started = Date.now();
    branchRefresh = facts('branches', config).then(function (data) {
      branchCache = { at: Date.now(), ttl: Math.max(30000, (Date.now() - started) * 2), stamp: stamp, items: data.items };
      return data;
    }).finally(function () { branchRefresh = null; });
  }
  if (!branchCache.items.length) { try { await branchRefresh; } catch (e) {} }
  return { items: branchCache.items, cachedAt: new Date(branchCache.at).toISOString() };
}

// 扫描指定目录（或配置里的根目录）：慢，只在「添加项目」里按需调用。
function discovery(target) {
  const config = readConfig();
  const configured = new Set(config.projects.map(function (p) { return p.path.toLowerCase().replace(/\/+$/, ''); }));
  // 只扫调用方指定的目录：不再有「扫描根目录」这个配置项
  let discovered = [], errors = [], status = '未发现仓库', root = target || '';
  if (!root) return { root: '', status: '还没选文件夹', discovered: [], errors: [] };
  if (!fs.existsSync(root)) return { root: root, status: '文件夹不存在：' + root, discovered: [], errors: [] };
  const found = scan(root);
  root = found.root;
  status = found.status;
  errors = found.errors;
  discovered = found.repos.map(function (r) {
    return {
      repo: r.repo, branch: r.branch, changes: r.changes.length,
      configured: configured.has(r.repo.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())
    };
  });
  return { root: root, status: status, discovered: discovered, errors: errors };
}

function tailLog(limit) {
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - limit)).join('\n');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

// 自启动的实机动作由宿主提供（Electron 写 HKCU 的 Run 项）。
// 浏览器模式没有这个能力，返回 supported:false 让界面如实禁用，而不是假装成功。
async function applyAutoStart(enabled) {
  if (!autoStartHook) return { supported: false, note: '浏览器模式改不了开机自启动，请用桌面版' };
  try {
    const result = await autoStartHook(!!enabled);
    return Object.assign({ supported: true }, result || {});
  } catch (e) {
    return { supported: true, error: e.message };
  }
}

function send(res, status, body, type) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > 1048576) { reject(fail('请求体过大', 413)); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(fail('请求体不是合法 JSON', 400)); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    // 面板只服务本机：校验 Host 防 DNS rebinding；校验 Origin 与 JSON Content-Type
    // 防任意网页用不触发预检的简单请求改配置、启动/停止监视。缺一个都等于把写接口敞开。
    const address = server.address();
    const boundPort = address && typeof address !== 'string' ? address.port : 0;
    const host = String(req.headers.host || '').toLowerCase();
    if (!boundPort || (host !== '127.0.0.1:' + boundPort && host !== 'localhost:' + boundPort)) {
      send(res, 403, { error: '只接受本机面板地址的请求' });
      return;
    }
    const origin = String(req.headers.origin || '').toLowerCase();
    if (origin && origin !== 'http://127.0.0.1:' + boundPort && origin !== 'http://localhost:' + boundPort) {
      send(res, 403, { error: '拒绝跨源请求' });
      return;
    }
    if (req.method === 'POST') {
      const type = String(req.headers['content-type'] || '').toLowerCase();
      if (type.indexOf('application/json') !== 0) { send(res, 415, { error: 'Content-Type 必须是 application/json' }); return; }
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      send(res, 200, fs.readFileSync(uiPath, 'utf8'), 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      send(res, 200, {
        config: readConfig(),
        configExists: fs.existsSync(configPath),
        configPath: configPath,
        defaults: DEFAULTS,
        embedded: !!process.versions.electron,
        autoStartSupported: !!autoStartHook,
        monitor: monitorStatus(),
        autoCommits: recentAutoCommits(20)
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') { send(res, 200, await projectStatus()); return; }
    if (req.method === 'GET' && url.pathname === '/api/branches') { send(res, 200, await branchList()); return; }
    if (req.method === 'GET' && url.pathname === '/api/check') { send(res, 200, checkPath(url.searchParams.get('path'))); return; }
    if (req.method === 'GET' && url.pathname === '/api/repos') { send(res, 200, discovery(url.searchParams.get('root'))); return; }
    if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
      if (!pickFolderHook) { send(res, 200, { supported: false }); return; }
      const picked = await pickFolderHook();
      send(res, 200, picked ? { path: picked } : { canceled: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/log') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('lines')) || 120, 10), 2000);
      send(res, 200, { text: tailLog(limit) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const config = validate(body.config || body);
      writeConfig(config);
      const wasRunning = monitorRunning();
      const monitor = wasRunning ? await restartMonitor() : monitorStatus();
      send(res, 200, { ok: true, config: config, restarted: wasRunning, monitor: monitor });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/recover') {
      const body = await readBody(req);
      const target = normalizePath(body.path);
      if (!target) throw fail('缺少项目路径', 400);
      const result = body.clear ? clearRecovery(target) : recoveryReport(target);
      rowsCache.stamp = '';
      send(res, 200, result);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/autostart') {
      const body = await readBody(req);
      if (typeof body.enabled !== 'boolean') throw fail('enabled 必须是 true 或 false', 400);
      const config = readConfig();
      config.autoStart = body.enabled;
      writeConfig(config);
      const applied = await applyAutoStart(body.enabled);
      send(res, 200, Object.assign({ ok: true, autoStart: body.enabled }, applied));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/monitor') {
      const body = await readBody(req);
      if (body.action === 'start') {
        // 环境没配齐时不让启动：缺 pwsh 会静默不弹窗，用户只会觉得工具没反应
        const blocked = prereqBlocked();
        if (blocked) { send(res, 409, { error: '环境还没配齐，先按提示补完再启动', prereq: blocked }); return; }
        send(res, 200, { ok: true, monitor: startMonitor() });
      }
      else if (body.action === 'stop') send(res, 200, { ok: true, monitor: stopMonitor() });
      else throw fail('action 必须是 start 或 stop', 400);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/prereq') {
      const report = inspectPrereqs();
      send(res, 200, Object.assign({}, report, { downloads: listDownloads() }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/prereq/download') {
      const body = await readBody(req);
      if (body.what !== 'git' && body.what !== 'pwsh') throw fail('what 只能是 git 或 pwsh', 400);
      send(res, 200, { id: startDownload(body.what) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/prereq/download') {
      const job = downloads.get(url.searchParams.get('id'));
      if (!job) throw fail('没有这个下载任务', 404);
      send(res, 200, publicJob(job));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/prereq/reveal') {
      const body = await readBody(req);
      const file = String(body.path || '');
      // 只允许打开我们自己下到下载目录里的文件，别变成「随便打开一个路径」的接口
      const dir = path.resolve(downloadDir(os.homedir()));
      const target = path.resolve(file);
      if (!target.startsWith(dir + path.sep) || !fs.existsSync(target)) throw fail('只能打开已下载的安装包', 400);
      spawn('explorer.exe', ['/select,', target], { windowsHide: false, detached: true, stdio: 'ignore' }).unref();
      send(res, 200, { ok: true });
      return;
    }

    send(res, 404, { error: '未知路径：' + url.pathname });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});


// ---- 缺依赖时的下载：只负责把安装包下到用户的下载文件夹，安装仍由用户自己点 ----
const downloads = new Map();

function publicJob(job) {
  return {
    id: job.id, what: job.what, state: job.state, file: job.file, name: job.name,
    received: job.received, total: job.total, error: job.error, mirror: !!job.mirror
  };
}

function listDownloads() {
  const out = [];
  for (const job of downloads.values()) out.push(publicJob(job));
  return out;
}

function fetchJson(url, depth) {
  const level = depth || 0;
  return new Promise(function (resolve, reject) {
    const req = https.get(url, { headers: { 'User-Agent': 'GitQuietHelper', Accept: 'application/vnd.github+json' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && level < 5) {
        res.resume();
        resolve(fetchJson(new URL(res.headers.location, url).href, level + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('查询发布信息失败：HTTP ' + res.statusCode)); return; }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { text += c; });
      res.on('end', function () { try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('发布信息不是合法 JSON')); } });
    });
    req.on('error', function (e) { reject(new Error('联网失败：' + e.message)); });
    req.setTimeout(20000, function () { req.destroy(new Error('查询超时')); });
  });
}

function downloadFile(url, dest, job, depth) {
  const level = depth || 0;
  return new Promise(function (resolve, reject) {
    const req = https.get(url, { headers: { 'User-Agent': 'GitQuietHelper' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && level < 5) {
        res.resume();
        resolve(downloadFile(new URL(res.headers.location, url).href, dest, job, level + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('下载失败：HTTP ' + res.statusCode)); return; }
      job.total = Number(res.headers['content-length'] || 0);
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', function (chunk) { job.received += chunk.length; });
      res.pipe(out);
      out.on('finish', function () {
        out.close(function () {
          try { fs.renameSync(tmp, dest); resolve(dest); } catch (e) { reject(e); }
        });
      });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', function (e) { reject(new Error('下载失败：' + e.message)); });
    req.setTimeout(60000, function () { req.destroy(new Error('下载超时')); });
  });
}

// 解析要下的安装包：Git 走仓库发布信息（失败时退国内镜像），PowerShell 取最新带 MSI 的稳定版
async function resolveInstaller(what) {
  if (what === 'git') {
    try {
      const rel = await fetchJson(GIT_RELEASES_API);
      const asset = pickGitAsset(rel);
      if (asset && asset.url) return asset;
      throw new Error('发布信息里没有 64 位安装器');
    } catch (e) {
      // GitHub 连不上是常态（尤其国内）：退到 npmmirror 的版本目录，按最新版本拼地址
      try {
        const tag = pickMirrorGitTag(await fetchJson(GIT_MIRROR_LISTING));
        const mirrored = tag ? mirrorGitAsset(tag) : null;
        if (mirrored && mirrored.url) return mirrored;
      } catch (e2) { /* 镜像也不行就按下面的报错走 */ }
      throw new Error(e.message + '（可以手动到 https://git-scm.com/download/win 下载）');
    }
  }
  const rels = await fetchJson(PS_RELEASES_API);
  const asset = pickPowerShellMsi(rels);
  if (!asset) throw new Error('没有找到带 MSI 的 PowerShell 稳定版，可以手动到 https://aka.ms/powershell 下载');
  return asset;
}

function startDownload(what) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const job = { id: id, what: what, state: 'resolving', received: 0, total: 0, file: '', name: '', error: '', startedAt: Date.now() };
  downloads.set(id, job);
  (async function () {
    try {
      const asset = await resolveInstaller(what);
      job.name = asset.name;
      job.size = asset.size;
      const dir = downloadDir(os.homedir());
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, asset.name);
      job.state = 'downloading';
      job.file = dest;
      await downloadFile(asset.url, dest, job);
      job.state = 'done';
    } catch (e) {
      job.state = 'error';
      job.error = e.message;
    }
  })();
  return id;
}

export function prereqBlocked() {
  const report = inspectPrereqs();
  return report.ok ? null : report;
}

function openBrowser(url) {
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    console.log('无法自动打开浏览器，请手动访问：' + url);
  }
}

function listenOn(port) {
  return new Promise(function (resolve, reject) {
    function onError(err) { server.removeListener('error', onError); reject(err); }
    server.once('error', onError);
    server.listen(port, '127.0.0.1', function () { server.removeListener('error', onError); resolve(server.address().port); });
  });
}

function stopMonitorChild() {
  if (monitorRunning()) { try { child.kill(); } catch (e) {} }
}

// 供 Electron 等宿主内嵌启动；返回实际端口与停止方法。
let pickFolderHook = null;
// 开机自启动是系统级动作，由宿主实现；浏览器模式下没有这个能力，界面要如实说
let autoStartHook = null;

export async function startPanel(options) {
  const opts = options || {};
  // 宿主（Electron 主进程）可以注入一个原生选目录对话框；浏览器里没有，界面就退回手填路径
  pickFolderHook = typeof opts.pickFolder === 'function' ? opts.pickFolder : null;
  autoStartHook = typeof opts.setAutoStart === 'function' ? opts.setAutoStart : null;
  if (opts.dataDir) {
    const dataDir = path.resolve(opts.dataDir);
    fs.mkdirSync(dataDir, { recursive: true });
    configPath = path.join(dataDir, 'config.json');
    stateDir = path.join(dataDir, 'state');
    logPath = path.join(stateDir, 'panel-monitor.log');
  }
  // 面板自己调 guard 的那些函数（恢复诊断、状态行）必须和监视器用同一个状态目录，
  // 否则打包版面板读的是安装目录 .state，监视器写的是 %APPDATA%，界面上看不到也清不掉门禁。
  useStateDir(stateDir);
  const basePort = Number.isFinite(opts.port) ? opts.port : 7331;
  if (!Number.isFinite(basePort) || basePort < 0 || basePort > 65000) throw new Error('无效端口');
  let port = null;
  for (let i = 0; i < 20 && port === null; i++) {
    try { port = await listenOn(basePort + i); }
    catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  if (port === null) throw new Error('从 ' + basePort + ' 起没有可用端口');
  if (opts.autoStartMonitor && !monitorRunning()) {
    try {
      // 环境没配齐就不启动：缺 git 完全干不了活，缺 pwsh 会静默不弹窗
      const blocked = prereqBlocked();
      if (blocked) {
        console.error('环境还没配齐，暂不启动监视：' + blocked.missing.join(','));
      } else {
        // 只在已有启用项目时自启：否则会回退为扫描整个根目录，首次运行会乱弹窗
        const enabled = (readConfig().projects || []).filter(function (p) { return p && p.enabled !== false; });
        if (enabled.length) startMonitor();
      }
    } catch (e) { console.error('自动启动监视失败：' + e.message); }
  }
  // 先把状态算一遍并写进缓存：否则界面打开后第一次请求要等线程算完（约 1 秒）
  try {
    const warm = readConfig();
    if ((warm.projects || []).length && !prereqBlocked()) {
      refreshRows(warm, rowsStamp(warm)).catch(function () {});
      branchList().catch(function () {});
    }
  } catch (e) {}
  // 启动即对齐系统里的自启动项与配置：用户在系统设置里删掉了，这里会补回来
  if (autoStartHook) {
    try { await autoStartHook(readConfig().autoStart); }
    catch (e) { console.error('对齐开机自启动失败：' + e.message); }
  }
  return {
    url: 'http://127.0.0.1:' + port + '/',
    port: port,
    configPath: configPath,
    stop: function () { stopMonitorChild(); server.close(); }
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const portFlag = argv.indexOf('--port');
  const panel = await startPanel({ port: portFlag >= 0 ? Number(argv[portFlag + 1]) : 7331 });
  console.log('配置面板已启动：' + panel.url);
  console.log('配置文件：' + configPath);
  if (argv.indexOf('--no-open') < 0) openBrowser(panel.url);
}

function shutdown() {
  stopMonitorChild();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 只在被当作脚本直接运行时启动；被 Electron 等宿主 import 时不自启。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(function (e) {
    console.error(e.message);
    process.exitCode = 1;
  });
}
