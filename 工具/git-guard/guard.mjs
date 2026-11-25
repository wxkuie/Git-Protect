import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = path.dirname(fileURLToPath(import.meta.url));
const state = path.resolve(process.env.GIT_GUARD_STATE || path.join(home, '.state'));
const ignoreDirs = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'out', '.next', '.tmp', '.state', 'coverage', '.cache', 'backup', 'backups', '备份']);
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' };
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const key = s => sha(Buffer.from(s));
function identityPath(value) {
  const p = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? p.toLowerCase().replace(/^[a-z]:/, drive => drive.toUpperCase()) : p;
}
function canonical(repo) { return identityPath(fs.realpathSync.native(path.resolve(repo))); }
function repoKey(repo) { return key(canonical(repo)); }
const gitExe = arg('--git-exe', process.env.GIT_GUARD_GIT || 'git');
const pwshExe = arg('--pwsh-exe', process.env.GIT_GUARD_PWSH || 'pwsh');
env.GIT_GUARD_GIT = gitExe;
env.GIT_GUARD_PWSH = pwshExe;
function git(repo, args, options = {}) {
  const p = spawnSync(gitExe, args, { cwd: repo, env: { ...env, ...options.env }, input: options.input, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 45000 });
  if (p.error || p.status !== 0) throw new Error((p.stderr || '').toString().trim() || p.error?.message || `git ${args[0]} failed (${p.status})`);
  return options.buffer ? p.stdout : p.stdout.toString('utf8').trim();
}
function selectedIndexRecords(repo, index, paths) {
  const wanted = new Set(paths), records = [];
  const bytes = git(repo, ['ls-files', '--stage', '-z'], { env: { GIT_INDEX_FILE: index }, buffer: true });
  for (let start = 0, end; (end = bytes.indexOf(0, start)) >= 0; start = end + 1) {
    const tab = bytes.indexOf(9, start);
    if (tab >= start && tab < end && wanted.has(bytes.subarray(tab + 1, end).toString('utf8'))) records.push(bytes.subarray(start, end + 1));
  }
  return Buffer.concat(records);
}
function isUntrackedWorktree(repo, name, trackedPaths) {
  if (!name.endsWith('/')) return false;
  const relative = name.slice(0, -1), dir = path.join(repo, relative);
  if (trackedPaths.some(p => p === relative || p.startsWith(relative + '/'))) return false;
  try {
    const entry = fs.lstatSync(dir), marker = fs.lstatSync(path.join(dir, '.git'));
    if (!entry.isDirectory() || entry.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) return false;
    return canonical(git(dir, ['rev-parse', '--show-toplevel'])) === canonical(dir);
  } catch { return false; }
}
function output(value) { console.log(JSON.stringify(value, null, 2)); }
function save(name, value) { fs.mkdirSync(state, { recursive: true }); const tmp = path.join(state, `${name}.${crypto.randomUUID()}.tmp`); fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, path.join(state, name)); }
function load(name, fallback = null) { try { return JSON.parse(fs.readFileSync(path.join(state, name), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
function hooks(repo) {
  let dir;
  try { dir = git(repo, ['config', '--path', '--get', 'core.hooksPath']); } catch { dir = git(repo, ['rev-parse', '--git-path', 'hooks']); }
  dir = path.resolve(repo, dir);
  const names = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction', 'post-rewrite'];
  return names.filter(n => { try { const s = fs.statSync(path.join(dir, n)); return s.isFile() && (process.platform === 'win32' || !!(s.mode & 0o111)); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } });
}
function excluded(repo, name) {
  const absolute = identityPath(path.resolve(repo, name)), statePath = identityPath(state), segments = name.replaceAll('\\', '/').split('/');
  return absolute === statePath || absolute.startsWith(statePath + path.sep) || segments.some(s => ignoreDirs.has(s.toLowerCase()) || /^backup[-_]|[-_]backup$|^备份/.test(s));
}
function fileHash(repo, name) {
  const p = path.join(repo, name);
  try { const s = fs.lstatSync(p); if (!s.isFile() || s.isSymbolicLink()) return 'unsupported'; return sha(fs.readFileSync(p)); }
  catch (e) { if (e.code === 'ENOENT') return 'deleted'; throw e; }
}
// 仓库骨架（仓库根、git 目录、索引路径、拆分索引）在一个进程内不会变。
// 本机每次 git 调用固定开销约 170 毫秒，次数才是主要成本，这里省下 3 次并整体缓存。
const skeletonCache = new Map();
function repoSkeleton(repo) {
  const hit = skeletonCache.get(repo);
  if (hit) return hit;
  const raw = git(repo, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'index', '--shared-index-path']);
  let value = null;
  try {
    const lines = raw.split('\n');
    // rev-parse 的输出顺序由 git 内部决定，不保证等于参数顺序：逐项核对特征，对不上就退回逐项查询
    if (lines.length >= 3 && lines[0] && lines[1] && lines[2]) {
      const top = canonical(lines[0]), gitDir = canonical(lines[1]), index = path.resolve(repo, lines[2]);
      if (top === repo && fs.existsSync(gitDir) && (fs.existsSync(index) || !fs.existsSync(path.join(gitDir, 'index')))) {
        value = { top, gitDir, index, shared: lines.slice(3).join('\n') };
      }
    }
  } catch (e) { value = null; }
  if (!value) {
    value = {
      top: canonical(git(repo, ['rev-parse', '--show-toplevel'])),
      gitDir: canonical(git(repo, ['rev-parse', '--absolute-git-dir'])),
      index: path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'index'])),
      shared: git(repo, ['rev-parse', '--shared-index-path'])
    };
  }
  skeletonCache.set(repo, value);
  return value;
}

export function snapshot(repo, selected) {
  repo = canonical(repo);
  const skel = repoSkeleton(repo);
  if (skel.top !== repo) throw new Error('路径不是 Git 工作树根');
  let head = null; let branch = '';
  const DETACHED = '分离 HEAD 或分支检查失败：当前未在任何分支上，提交会丢失。请先 git switch 回到一个分支，已阻断';
  // 一次 status 顺带取回分支头行，省掉 symbolic-ref 与 show-ref 两次进程
  // 头行形如：## main、## main...origin/main、## No commits yet on main、## HEAD (no branch)
  const raw = git(repo, ['status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all'], { buffer: true });
  const entries = raw.toString('utf8').split('\0');
  const header = entries.length && entries[0].startsWith('## ') ? entries.shift() : '';
  let unborn = false;
  if (header) {
    const rest = header.slice(3);
    // 游离 HEAD 下提交不会落在任何分支上，这里直接阻断，并说明用户该做什么
    if (rest === 'HEAD (no branch)') throw new Error(DETACHED);
    if (rest.startsWith('No commits yet on ')) { unborn = true; branch = rest.slice('No commits yet on '.length).trim(); }
    else { const dots = rest.indexOf('...'); branch = (dots >= 0 ? rest.slice(0, dots) : rest).trim(); }
    // 引用名里不允许空白，出现空白说明头行不是我们能认的形式，交给回退路径
    if (!branch || /\s/.test(branch)) branch = '';
  }
  if (process.env.GIT_GUARD_NO_BRANCH_HEADER) branch = '';   // 供测试强制走回退路径
  if (!branch) {
    // 回退：头行不可解析时逐项查询（多两次进程，只在异常格式下发生）
    let ref;
    try { ref = git(repo, ['symbolic-ref', '-q', 'HEAD']); } catch { throw new Error(DETACHED); }
    branch = ref.replace(/^refs\/heads\//, '');
    const refProbe = spawnSync(gitExe, ['show-ref', '--verify', '--quiet', ref], { cwd: repo, env, windowsHide: true, timeout: 45000 });
    if (refProbe.status === 0) head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
    else if (refProbe.status !== 1) throw new Error('HEAD 检查失败，不能当作未首提交');
  } else if (!unborn) {
    head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  }
  // 一次 ls-files 同时拿到阶段信息与 skip-worktree 标记：每项形如 "H 100644 <sha> <stage>\t<path>"
  const listed = git(repo, ['ls-files', '--stage', '-v', '-z'], { buffer: true }).toString('utf8').split('\0').filter(Boolean);
  const stageEntries = listed.map(x => x.slice(2));
  const trackedPaths = stageEntries.map(x => x.slice(x.indexOf('\t') + 1));
  const changes = []; const reasons = [], nestedWorktrees = [];
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i]; if (!item) continue;
    const code = item.slice(0, 2), name = item.slice(3);
    if (/[RC]/.test(code)) { const from = entries[++i]; if (!excluded(repo, name) || !excluded(repo, from)) { reasons.push('重命名或复制状态暂不支持'); changes.push({ code, path: name, from, hash: fileHash(repo, name) }); } continue; }
    if (excluded(repo, name)) continue;
    if (code === '??' && isUntrackedWorktree(repo, name, trackedPaths)) { nestedWorktrees.push(name.slice(0, -1)); continue; }
    const hash = fileHash(repo, name); if (hash === 'unsupported') reasons.push(`不支持的文件类型：${name}`);
    changes.push({ code, path: name, hash });
  }
  const paths = selected || changes.map(x => x.path);
  if (!Array.isArray(paths)) throw new Error('提交范围必须是文件路径数组');
  const selectedPaths = new Set(paths), changedPaths = new Set(changes.map(x => x.path));
  if ((selected && paths.length === 0) || selectedPaths.size !== paths.length || paths.some(p => typeof p !== 'string' || !changedPaths.has(p))) reasons.push('提交范围为空、重复或包含未展示改动');
  for (const c of changes.filter(x => selectedPaths.has(x.path))) {
    if (c.code !== '??' && c.code[0] !== ' ' && c.code[1] !== ' ') reasons.push(`部分暂存或冲突：${c.path}`);
    if (/[U]/.test(c.code)) reasons.push(`冲突状态：${c.path}`);
  }
  const foundHooks = hooks(repo); if (foundHooks.length) reasons.push(`存在提交相关 hook：${foundHooks.join(', ')}`);
  if (listed.some(x => x[0] === 'S' || x[0] === x[0].toLowerCase())) reasons.push('存在 skip-worktree 或 assume-unchanged，已阻断');
  if (skel.shared) reasons.push('拆分索引暂不支持');
  if (stageEntries.some(x => x.startsWith('160000 '))) reasons.push('含子模块的仓库暂不支持');
  const gitDir = skel.gitDir;
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) if (fs.existsSync(path.join(gitDir, marker))) reasons.push(`Git 操作进行中：${marker}`);
  const index = skel.index;
  let indexHash = 'missing'; try { indexHash = sha(fs.readFileSync(index)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const view = { repo, gitDir, head, branch, indexHash, changes, paths, reasons, hooks: foundHooks, nestedWorktrees };
  return { ...view, version: sha(Buffer.from(JSON.stringify(view))) };
}
export function scan(root) {
  const repos = [], errors = [];
  function walk(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { errors.push({ path: dir, error: e.message }); return; }
    if (entries.some(x => x.name === '.git' && (x.isDirectory() || x.isFile()))) {
      try { const s = snapshot(dir); repos.push({ repo: s.repo, branch: s.branch, head: s.head, changes: s.changes.length, reasons: s.reasons, nestedWorktrees: s.nestedWorktrees }); } catch (e) { errors.push({ path: dir, error: e.message }); }
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !ignoreDirs.has(entry.name)) walk(path.join(dir, entry.name));
  }
  walk(path.resolve(root)); return { root: path.resolve(root), repos, errors, status: errors.length ? '检查失败' : repos.length ? '发现仓库' : '未发现仓库' };
}
function runName(repo) { return `run-${repoKey(repo)}.json`; }

// 提交做完但收尾没做完就断电/被强杀时，会留下事务门禁，之后这个仓库的提交全部被挡住。
// 清除属安全关键操作：只读诊断先证明「那笔提交确实落在 HEAD 历史里」，才允许清理。
export function recoveryReport(repo) {
  repo = canonical(repo);
  const transactionFile = path.join(state, transactionName(repo));
  const recoveryFile = path.join(state, `recovery-${repoKey(repo)}.json`);
  const runLockFile = path.join(state, runName(repo) + '.lock');
  const transaction = load(transactionName(repo)), recovery = load(`recovery-${repoKey(repo)}.json`);
  const report = {
    repo, stateDir: state, transactionFile, transaction, recoveryFile, recovery,
    runLock: fs.existsSync(runLockFile), runMarkers: Object.keys(runState(repo)).length,
    canClear: false, reason: ''
  };
  if (recovery) { report.reason = '存在提交恢复记录：说明该笔提交的树或父提交与授权不一致，必须人工核对，工具不自动处理'; return report; }
  // 没有事务就到此为止：界面每次轮询都会查一次，这条路必须不拉 git 进程
  if (!transaction) {
    report.canClear = report.runLock;
    report.reason = report.runLock ? '没有未收尾的事务，只剩一个空的运行锁，可以清理' : '没有未收尾的事务，无需处理';
    return report;
  }
  const indexLock = path.join(repo, '.git', 'index.lock');
  if (fs.existsSync(indexLock)) { report.reason = '检测到 index.lock，说明此刻有提交正在进行；请先停止监视并确认没有 git 操作再试'; return report; }
  let head = '';
  try { head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']); } catch (e) { head = ''; }
  if (transaction.commit) {
    try { git(repo, ['cat-file', '-e', transaction.commit + '^{commit}']); }
    catch (e) { report.reason = '事务记录里的提交对象已不存在，需人工核对'; return report; }
    let reachable = false;
    try { git(repo, ['merge-base', '--is-ancestor', transaction.commit, 'HEAD']); reachable = true; } catch (e) { reachable = false; }
    if (!reachable) { report.reason = `提交 ${String(transaction.commit).slice(0, 7)} 不在当前 HEAD 的历史里，无法证明它已生效，需人工核对`; return report; }
    report.canClear = true;
    report.reason = `提交 ${String(transaction.commit).slice(0, 7)} 已在当前分支历史里，可以清理残留并修正索引`;
    return report;
  }
  if (head && head === transaction.previousHead) {
    report.canClear = true;
    report.reason = '事务还没产生提交且 HEAD 未变化，可以清理残留';
    return report;
  }
  report.reason = '事务没有记录提交，但 HEAD 已经变化，无法判断，需人工核对';
  return report;
}

export function clearRecovery(repo, options = {}) {
  const report = recoveryReport(repo);
  if (!report.canClear) throw new Error(report.reason);
  const target = canonical(repo);
  const removed = [];
  // 只在该笔提交确实落地、而索引可能还停在提交前时，才把索引对齐到 HEAD。
  // 只动索引、不动工作区，且只碰这笔事务记录里的路径。
  if (report.transaction && report.transaction.commit && Array.isArray(report.transaction.paths) && report.transaction.paths.length) {
    try { git(target, ['reset', '-q', 'HEAD', '--'].concat(report.transaction.paths)); report.indexRepaired = true; }
    catch (e) { report.indexRepaired = false; report.indexError = e.message; }
  }
  const candidates = [report.transactionFile, path.join(state, runName(target) + '.lock')];
  if (report.transaction && report.transaction.attemptFile) candidates.push(report.transaction.attemptFile);
  for (const file of candidates) {
    if (!file) continue;
    if (!path.resolve(file).startsWith(path.resolve(state) + path.sep)) continue;
    try { if (fs.existsSync(file)) { fs.unlinkSync(file); removed.push(path.basename(file)); } } catch (e) {}
  }
  return { ...report, cleared: true, removed: removed };
}
function transactionName(repo) { return `transaction-${repoKey(repo)}.json`; }
function runState(repo) { return load(runName(repo), {}); }
export function busy(repo) { return fs.existsSync(path.join(state, transactionName(repo))) || fs.existsSync(path.join(state, runName(repo) + '.lock')) || Object.keys(runState(repo)).length > 0; }
export function marker(repo, action, token) {
  if (!token) throw new Error('必须指定运行标记 token');
  fs.mkdirSync(state, { recursive: true });
  repo = canonical(repo);
  const name = runName(repo), lock = path.join(state, name + '.lock');
  fs.closeSync(fs.openSync(lock, 'wx'));
  try {
    const all = load(name, {});
    if (action === 'begin') all[token] = { started: new Date().toISOString() }; else if (action === 'end') { if (!all[token]) throw new Error('运行标记不存在'); delete all[token]; } else throw new Error('未知标记操作');
    save(name, all); return { repo, busy: Object.keys(all).length > 0 };
  } finally { fs.unlinkSync(lock); }
}
export function createApproval(repo, paths, message = '保存本地修改') {
  if (!Array.isArray(paths) || !paths.length) throw new Error('必须明确指定非空文件范围');
  if (typeof message !== 'string' || !message.trim() || /[\r\n]/.test(message)) throw new Error('提交说明不能为空且须为单行');
  return { ...snapshot(repo, paths), message, id: crypto.randomUUID() };
}
// 提交身份是纯前置条件：缺了它 git commit 必然失败。提前拦下，避免白白写下事务门禁把后续提交全部卡死。
export function ensureIdentity(repo) {
  try { git(canonical(repo), ['var', 'GIT_AUTHOR_IDENT']); }
  catch (e) { throw new Error('Git 还没有配置提交身份，无法提交。先执行：git config --global user.name "你的名字"，再执行 git config --global user.email "你的邮箱"'); }
}


// 版本号里含 .git/index 的哈希，而 git 只要刷新一次 stat 缓存就会改它（这是常态，不是用户改动）。
// 所以版本变化时还要看内容到底变没变：文件状态码、路径、内容哈希、HEAD、分支都没变，就不该作废确认。
export function sameContent(a, b) {
  if (!a || !b) return false;
  if (a.repo !== b.repo || a.head !== b.head || a.branch !== b.branch) return false;
  const key = x => x.code + '\0' + x.path + '\0' + x.hash;
  const left = (a.changes || []).map(key).sort().join('\n');
  const right = (b.changes || []).map(key).sort().join('\n');
  return left === right;
}

export function validate(approval) {
  if (!Array.isArray(approval.paths) || !approval.paths.length) throw new Error('必须明确指定非空文件范围');
  ensureIdentity(approval.repo);
  if (approval.id && fs.existsSync(path.join(state, `invalid-${approval.id}.json`))) throw new Error('弹窗后观察到修改，旧确认失效');
  if (fs.existsSync(path.join(state, transactionName(approval.repo)))) throw new Error(`前次提交事务尚未完成，门禁保持：${path.join(state, transactionName(approval.repo))}`);
  if (load(`recovery-${repoKey(approval.repo)}.json`)) throw new Error('前次提交需要人工检查索引恢复记录');
  const s = snapshot(approval.repo, approval.paths);
  if (s.version !== approval.version && !sameContent(approval, s)) throw new Error('版本已变化，旧确认失效');
  if (s.reasons.length) throw new Error(s.reasons.join('；'));
  if (busy(s.repo)) throw new Error('运行标记尚未结束或协调锁未释放');
  return s;
}
function preflightIndex(index) {
  const parent = path.dirname(index), probes = [];
  try {
    fs.accessSync(parent, fs.constants.W_OK);
    try {
      const stat = fs.lstatSync(index);
      if (!stat.isFile() || !(stat.mode & 0o222)) throw new Error('索引不是普通可写文件或处于只读状态');
      fs.accessSync(index, fs.constants.W_OK);
      const fd = fs.openSync(index, 'r+'); fs.closeSync(fd);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const prefix = path.join(parent, `git-guard-publish-probe-${crypto.randomUUID()}`);
    for (const suffix of ['.a', '.b']) { const name = prefix + suffix; fs.closeSync(fs.openSync(name, 'wx')); probes.push(name); }
    fs.renameSync(probes[0], probes[1]);
    fs.unlinkSync(probes[1]); probes.length = 0;
  } catch (e) { throw new Error(`索引只读或不可发布，未创建提交：${e.message}`); }
  finally { for (const name of probes) try { fs.unlinkSync(name); } catch {} }
}
export function commit(approval) {
  validate(approval);
  const repo = canonical(approval.repo), before = snapshot(repo, approval.paths);
  if (before.version !== approval.version) throw new Error('版本已变化，旧确认失效');
  if (before.reasons.length) throw new Error(before.reasons.join('；'));
  if (busy(repo)) throw new Error('运行标记尚未结束');
  if (!approval.message || /[\r\n]/.test(approval.message)) throw new Error('提交说明不能为空且须为单行');
  const index = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'index']));
  const lock = index + '.lock'; let locked = false, runLocked = false, committed = null, preserve = false, commitCreated = false, indexPublished = false;
  fs.mkdirSync(state, { recursive: true });
  const id = crypto.randomUUID(), workIndex = path.join(state, `work-${id}.index`), nextIndex = path.join(state, `next-${id}.index`);
  const runLock = path.join(state, runName(repo) + '.lock');
  const attempt = `attempt-${key(`${repo}:${approval.id || approval.version}:${approval.message}`)}.json`;
  const transaction = transactionName(repo), transactionFile = path.join(state, transaction);
  const transactionRecord = { status: 'prepared', repo, previousHead: before.head, branch: before.branch, approvalId: approval.id, paths: approval.paths, message: approval.message, nextIndex, workIndex, attemptFile: path.join(state, attempt), time: new Date().toISOString() };
  let transactionOwned = false, transactionReady = false;
  try {
    fs.closeSync(fs.openSync(runLock, 'wx')); runLocked = true;
    if (Object.keys(runState(repo)).length) throw new Error('运行标记尚未结束');
    fs.closeSync(fs.openSync(lock, 'wx')); locked = true;
    preflightIndex(index);
    if (snapshot(repo, approval.paths).version !== approval.version) throw new Error('锁定后版本已变化');
    fs.writeFileSync(path.join(state, attempt), JSON.stringify({ status: 'started', repo, previousHead: before.head, paths: approval.paths, nextIndex }), { flag: 'wx' });
    if (before.head) git(repo, ['read-tree', before.head], { env: { GIT_INDEX_FILE: workIndex } }); else git(repo, ['read-tree', '--empty'], { env: { GIT_INDEX_FILE: workIndex } });
    const pathInput = Buffer.from(approval.paths.join('\0') + '\0');
    git(repo, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: { GIT_INDEX_FILE: workIndex }, input: pathInput });
    if (fs.existsSync(index)) fs.copyFileSync(index, nextIndex); else git(repo, ['read-tree', '--empty'], { env: { GIT_INDEX_FILE: nextIndex } });
    git(repo, ['update-index', '--force-remove', '-z', '--stdin'], { env: { GIT_INDEX_FILE: nextIndex }, input: pathInput });
    const records = selectedIndexRecords(repo, workIndex, approval.paths);
    if (records.length) git(repo, ['update-index', '-z', '--index-info'], { env: { GIT_INDEX_FILE: nextIndex }, input: records });
    const expectedTree = git(repo, ['write-tree'], { env: { GIT_INDEX_FILE: workIndex } });
    fs.copyFileSync(nextIndex, lock);
    const prepared = fs.openSync(lock, 'r+'); try { fs.fsyncSync(prepared); } finally { fs.closeSync(prepared); }
    preflightIndex(index);
    const current = snapshot(repo, approval.paths);
    if ((current.version !== approval.version && !sameContent(approval, current)) || (approval.id && fs.existsSync(path.join(state, `invalid-${approval.id}.json`)))) throw new Error('准备提交期间版本已变化');
    const gate = fs.openSync(transactionFile, 'wx'); transactionOwned = true;
    try { fs.writeFileSync(gate, JSON.stringify(transactionRecord)); fs.fsyncSync(gate); } finally { fs.closeSync(gate); }
    transactionReady = true; preserve = true;
    git(repo, ['commit', '-m', approval.message], { env: { GIT_INDEX_FILE: workIndex } });
    commitCreated = true;
    const id = git(repo, ['rev-parse', 'HEAD']); committed = id;
    save(transaction, { ...transactionRecord, status: 'committed', commit: id });
    const actualTree = git(repo, ['rev-parse', 'HEAD^{tree}']);
    const parents = git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ').slice(1);
    if (actualTree !== expectedTree || JSON.stringify(parents) !== JSON.stringify(before.head ? [before.head] : [])) throw new Error(`提交 ${id} 的树或父提交与授权不一致，需人工检查`);
    try { fs.renameSync(lock, index); locked = false; indexPublished = true; }
    catch (e) { throw new Error(`提交 ${id} 已创建，但索引更新失败：${e.message}；未自动回退`); }
    const result = { repo, commit: id, paths: approval.paths, time: new Date().toISOString() }; save(attempt, { status: 'completed', ...result }); save(`result-${repoKey(repo)}.json`, result);
    fs.unlinkSync(transactionFile); transactionOwned = false; preserve = false; return result;
  } catch (e) {
    if (commitCreated) {
      preserve = true;
      const name = `recovery-${repoKey(repo)}.json`;
      const record = { status: indexPublished ? 'committed-result-pending' : 'committed-index-pending', repo, commit: committed, previousHead: before.head, nextIndex, indexPublished, error: e.message, time: new Date().toISOString() };
      try { save(transaction, { ...transactionRecord, ...record }); } catch {}
      let recoveryWritten = true;
      try { save(name, record); } catch (writeError) { recoveryWritten = false; record.recoveryWriteError = writeError.message; }
      const message = indexPublished ? '提交已生成，结果记录待核对' : '提交已生成，索引待恢复';
      throw Object.assign(new Error(`${message}；提交号 ${committed || '未知，请核对 HEAD'}；恢复候选 ${nextIndex}`), { code: 'COMMIT_RECOVERY_REQUIRED', ...record, recoveryFile: path.join(state, name), recoveryWritten, transactionFile });
    }
    if (transactionReady) throw new Error(`${e.message}；未完成事务门禁保持，请先核对：${transactionFile}`);
    throw e;
  } finally {
    if (locked) try { fs.unlinkSync(lock); } catch {}
    if (runLocked) try { fs.unlinkSync(runLock); } catch {}
    if (transactionOwned && !transactionReady) try { fs.unlinkSync(transactionFile); } catch {}
    if (!preserve) for (const p of [workIndex, nextIndex, workIndex + '.lock', nextIndex + '.lock']) try { fs.unlinkSync(p); } catch {}
  }
}
// 停手时间按「改动文件最后一次被写的时刻」算，而不是监视器启动那一刻。
// 否则每次重启（升级、开机、崩溃后重开）都会把已经停手几小时的仓库重新计时，
// 用户看到的就是「明明早该提醒了，却一直不提醒」。
export function lastTouched(repo, changes, now = Date.now()) {
  let newest = 0;
  for (const item of changes || []) {
    if (!item || typeof item.path !== 'string') continue;
    try {
      const st = fs.statSync(path.join(repo, item.path));
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch (e) { /* 文件刚被删掉或没有权限：跳过，不影响其它文件 */ }
  }
  if (!newest) return now;
  return Math.min(newest, now);   // 时钟偏移到未来时不能让人立刻被弹窗
}

export class Tracker {
  constructor(idleMs = 600000, cooldownMs = 7200000) { this.idleMs = idleMs; this.cooldownMs = cooldownMs; this.items = new Map(); }
  observe(repo, version, now = Date.now()) {
    repo = canonical(repo); const old = this.items.get(repo);
    if (!old || old.version !== version) this.items.set(repo, {
      version, since: now,
      rejected: old?.rejected || {}, skipped: old?.skipped || {}, snoozeUntil: old?.snoozeUntil || 0
    });
    return this.items.get(repo);
  }
  changed(repo, now = Date.now()) { const s = this.items.get(canonical(repo)); if (s) s.since = now; }
  reject(repo, version, now = Date.now()) { const s = this.items.get(canonical(repo)); if (s) s.rejected[version] = now; }
  // 「本次不提交」：这个版本就问这一次，文件一变（版本变）自然会重新问
  skip(repo, version) { const s = this.items.get(canonical(repo)); if (s) s.skipped[version] = true; }
  // 「一段时间不打扰」：到点前该仓库完全不处理，而不是只跳过当前版本
  snooze(repo, until) { const s = this.items.get(canonical(repo)); if (s) s.snoozeUntil = Math.max(s.snoozeUntil || 0, until); }
  ready(repo, isBusy, now = Date.now(), idleMs = this.idleMs) {
    const s = this.items.get(canonical(repo));
    if (!s || isBusy || now - s.since < idleMs) return false;
    if (s.snoozeUntil && now < s.snoozeUntil) return false;
    if (s.skipped[s.version]) return false;
    return s.rejected[s.version] === undefined || now - s.rejected[s.version] >= this.cooldownMs;
  }
}
// 提交说明默认带时间：回头看历史时，一眼能分清「我手写的」和「工具自动收的」。
// 再带上文件数——扫 git log 时能直接看出这次吞了多少，不用点进去数。
export function defaultMessage(date = new Date(), count = 0) {
  const pad = (n) => String(n).padStart(2, '0');
  const body = `${date.getMonth() + 1}月${date.getDate()}日${pad(date.getHours())}:${pad(date.getMinutes())}：自动提交`;
  return count > 0 ? `${body}（${count} 个文件）` : body;
}
// 弹窗上的「稍后再说」按钮要写清楚是多久，时长来配置而不是写死，免得按钮上的字和实际行为对不上。
function snoozeLabel(seconds) {
  if (seconds >= 3600) { const h = seconds / 3600; return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时内不打扰`; }
  return `${Math.max(1, Math.round(seconds / 60))} 分钟内不打扰`;
}
// 自动提交没有人先看清单，所以一次性改动过大时降级为弹窗，避免「回来发现几百个文件被一个提交吞了」。
const AUTO_MAX_FILES = 500;

function recordAutoCommit(entry) {
  try {
    const file = path.join(state, 'auto-commits.jsonl');
    fs.mkdirSync(state, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
    if (fs.statSync(file).size > 262144) {
      const kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-200);
      fs.writeFileSync(file, kept.join('\n') + '\n');
    }
  } catch (e) {}
}

export function startMonitor(config = {}, notify) {
  for (const name of ['idleSeconds', 'cooldownSeconds', 'pollSeconds']) if (config[name] !== undefined && (!Number.isFinite(config[name]) || config[name] <= 0)) throw new Error(`无效参数：${name}`);
  if (config.mode !== undefined && ['remind', 'notify', 'silent'].indexOf(config.mode) < 0) throw new Error(`未知模式：${config.mode}`);
  if (config.projects !== undefined && config.projects !== null) {
    if (!Array.isArray(config.projects)) throw new Error('无效参数：projects');
    for (const p of config.projects) {
      if (!p || typeof p.path !== 'string' || !p.path.trim()) throw new Error('项目缺少路径');
      if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new Error(`项目启用状态无效：${p.path}`);
      if (p.branch !== undefined && p.branch !== null && (typeof p.branch !== 'string' || (p.branch !== '' && !/^[A-Za-z0-9._/-]+$/.test(p.branch)))) throw new Error(`项目分支无效：${p.path}`);
      // 模式、说明、停手时长都是全局的。老配置里可能还留着项目级的同名字段，
      // 这里有意不校验也不使用，避免旧文件因为残留字段而启动失败。
    }
  }
  fs.mkdirSync(state, { recursive: true });
  const cooldownSeconds = config.cooldownSeconds ?? 7200;
  const tracker = new Tracker((config.idleSeconds ?? 600) * 1000, cooldownSeconds * 1000), watchers = new Map(), open = new Map();
  const warned = new Set(), lastError = new Map();
  let timer, wake, stopped = false;
  function requestCheck() { if (!stopped && !wake) wake = setTimeout(() => { wake = null; round(); }, 100); }
  // 应用重启（升级、崩溃重开）时，屏幕上可能还挂着上次的窗口——那些窗口是独立进程，不随应用退出。
  // 这里把仍然有效的审批接手过来当成「已有一个窗口在等」，否则重启一次就再叠一个，
  // 挂机一晚上会攒出一堆窗口压在同一片区域。
  let adopted = false;
  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }   // 存在但没权限，也算活着
  }
  function adoptOpenApprovals(entries) {
    adopted = true;
    const repos = new Set(entries.map(e => e.repo));
    let names = [];
    try { names = fs.readdirSync(state); } catch (e) { return; }
    for (const name of names) {
      if (!/^approval-.*\.json$/.test(name)) continue;
      let a;
      try { a = load(name); } catch (e) { continue; }
      if (!a || !a.id) continue;
      // 只有窗口进程还活着才算「有人正在看」。文件残留但窗口早关了（应用退出、崩溃、
      // 用户直接关窗）不能占着名额，否则那个仓库会永远等一个不存在的窗口，再也不提醒。
      const pidFile = `window-${a.id}.json`;
      const live = load(pidFile);
      if (!live || !pidAlive(live.pid)) {
        // 窗口已经不在：清掉残留的审批与记录，让这个版本按正常流程重新提醒
        try { fs.unlinkSync(path.join(state, name)); } catch (e) {}
        try { fs.unlinkSync(path.join(state, pidFile)); } catch (e) {}
        continue;
      }
      if (!a.repo || !repos.has(a.repo) || open.has(a.repo)) continue;
      // 窗口还开着，但内容可能已经变了：变了就不接手，让它自己提示失效
      try { validate(a); open.set(a.repo, a); } catch (e) {}
    }
  }
  function invalidate(repo) { tracker.changed(repo); const a = open.get(repo); if (a) save(`invalid-${a.id}.json`, { reason: '弹窗期间观察到修改', time: new Date().toISOString() }); }
  function propose(repo, s, message) {
    const a = { ...s, message, snoozeText: snoozeLabel(cooldownSeconds), id: crypto.randomUUID() }, f = `approval-${a.id}.json`;
    save(f, a); open.set(repo, a);
    // 退出码是窗口把「哪种拒绝」传回来的唯一通道：3 = 本次不提交，4 = 一段时间不打扰。
    // 其它情况（提交成功、提交失败、直接关窗）沿用旧行为：这个版本先记一次冷却，避免立刻又弹。
    const finish = (code) => {
      open.delete(repo);
      try { fs.unlinkSync(path.join(state, `window-${a.id}.json`)); } catch (e) {}
      const item = tracker.items.get(repo);
      if (code === 3) {
        tracker.skip(repo, s.version);
        save(`skip-${repoKey(repo)}.json`, item?.skipped || { [s.version]: true });
        return;
      }
      if (code === 4) {
        const until = Date.now() + cooldownSeconds * 1000;
        tracker.snooze(repo, until);
        save(`snooze-${repoKey(repo)}.json`, { until });
        return;
      }
      tracker.reject(repo, s.version);
      save(`cooldown-${repoKey(repo)}.json`, item?.rejected || { [s.version]: Date.now() });
    };
    if (notify) { notify(a, finish); return; }
    const args = ['-NoProfile', '-STA', '-File', path.join(home, 'window.ps1'), '-Approval', path.join(state, f), '-NodeExe', process.execPath];
    // 仅测试用：让弹窗自己按下指定按钮并退出，全程隐藏，避免验证时在屏幕上闪窗
    const selftest = process.env.GIT_GUARD_SELFTEST;
    if (selftest) args.push('-SelfTest', selftest, '-SelfTestExit');
    const child = spawn(pwshExe, args, { windowsHide: true, stdio: 'ignore', env });
    // 记下窗口进程，重启时据此判断「屏幕上是否真的还有一个窗口在等」
    if (child.pid) save(`window-${a.id}.json`, { pid: child.pid, repo: repo, time: new Date().toISOString() });
    child.on('error', () => { open.delete(repo); tracker.items.delete(repo); });
    child.on('exit', (code) => finish(code));
  }
  function round() {
    if (stopped) return;
    const explicit = Array.isArray(config.projects) ? config.projects.filter(p => p && p.enabled !== false) : [];
    let entries, errors;
    if (explicit.length) {
      entries = []; errors = [];
      for (const p of explicit) {
        try { entries.push({ repo: canonical(p.path), settings: p }); }
        catch (e) { errors.push({ path: p.path, error: e.message }); }
      }
    } else {
      // 只监视显式添加的项目。以前这里会回退去扫一个「扫描根目录」，
      // 结果是第一次运行就可能对整台机器上的仓库弹窗；现在没项目就什么都不做。
      entries = []; errors = [];
    }
    if (!adopted) adoptOpenApprovals(entries);
    const seen = new Set(entries.map(x => x.repo));
    for (const [repo, watcher] of watchers) if (!seen.has(repo) || (errors.length > 0 && !explicit.length)) { invalidate(repo); watcher.close(); watchers.delete(repo); tracker.items.delete(repo); }
    for (const entry of entries) {
      const repo = entry.repo, settings = entry.settings;
      try {
        const s = snapshot(repo);
        // 版本没变就不必重新统计文件时间；变了才按「最新改动时刻」重新计时
        const prior = tracker.items.get(repo);
        const observed = (!prior || prior.version !== s.version)
          ? tracker.observe(repo, s.version, lastTouched(repo, s.changes))
          : tracker.observe(repo, s.version);
        lastError.delete(repo);
        Object.assign(observed.rejected, load(`cooldown-${repoKey(repo)}.json`, {}));
        Object.assign(observed.skipped, load(`skip-${repoKey(repo)}.json`, {}));
        const snoozed = load(`snooze-${repoKey(repo)}.json`, null);
        if (snoozed && Number.isFinite(snoozed.until)) observed.snoozeUntil = Math.max(observed.snoozeUntil || 0, snoozed.until);
        // 内容没变、只是 git 刷新了索引（版本号变但内容相同）时，作废弹窗只会让人白点一次
        if (open.has(repo) && !sameContent(open.get(repo), s)) invalidate(repo);
        if (!watchers.has(repo)) {
          try {
            const w = fs.watch(repo, { recursive: true }, (event, name) => {
              const n = String(name || '').replaceAll('\\', '/');
              // .git 内部一律忽略：监视器自己每轮都跑 git status，它会创建并删除 .git/index.lock，
              // 以前这条判断是「命中 .git 就失效」，于是每轮轮询都被自己的动作清零——
              // 停手计时永远到不了，有未提交改动的仓库永远不提醒，已弹出的确认也会被判失效。
              // 真实的提交/切分支由 30 秒轮询比对版本号发现，不依赖这个目录。
              if (!n) invalidate(repo);
              else if (/(^|\/)\.git(\/|$)/.test(n)) { /* .git 内部改动不算工作区改动 */ }
              else if (!excluded(repo, n)) invalidate(repo);
            });
            w.on('error', () => { invalidate(repo); w.close(); watchers.delete(repo); tracker.items.delete(repo); }); watchers.set(repo, w);
          } catch { tracker.items.delete(repo); continue; }
        }
        // 分支只认项目自己的设置（留空即跟随当前分支），没有全局默认分支这回事
        // 「一段时间不打扰」是真的一条都不处理：连自动模式也不动它，否则用户点的是「别烦我」，
        // 结果后台照样提交，等于没停
        if (observed.snoozeUntil && Date.now() < observed.snoozeUntil) continue;
        const required = (settings && settings.branch) || '';
        if (required && s.branch !== required) continue;
        const idleMs = ((settings && Number(settings.idleSeconds)) || config.idleSeconds || 600) * 1000;
        if (s.changes.length && tracker.ready(repo, busy(repo), Date.now(), idleMs) && !open.has(repo)) {
          // 没配身份就弹窗只会让人白点一次并留下门禁，这里直接跳过并提示一次
          try { ensureIdentity(repo); }
          catch (e) {
            if (!warned.has(repo)) { warned.add(repo); console.error(`${repo}: ${e.message}`); }
            tracker.changed(repo);
            continue;
          }
          // 说明与模式都是全局的：一个项目设一次只会增加点击量
          const message = defaultMessage(new Date(), s.changes.length);
          const mode = config.mode || 'remind';
          const tooBig = s.changes.length > AUTO_MAX_FILES;
          if (mode === 'remind' || tooBig) {
            if (tooBig && !warned.has(repo + ':cap')) {
              warned.add(repo + ':cap');
              console.error(`${repo}: 本次有 ${s.changes.length} 个文件改动，超过自动提交上限 ${AUTO_MAX_FILES}，已改为弹窗确认`);
              recordAutoCommit({ mode, repo, skipped: true, count: s.changes.length, note: `超过自动提交上限 ${AUTO_MAX_FILES}，改为弹窗` });
            }
            propose(repo, s, message);
          } else {
            // 自动模式没有人先看清单，于是完全依赖引擎自身的门禁：validate 不通过就不提交
            const a = { ...s, message, id: crypto.randomUUID() };
            try {
              validate(a);
              const result = commit(a);
              recordAutoCommit({ mode, repo, commit: result.commit, count: s.changes.length, message });
            } catch (e) {
              if (!warned.has(repo + ':auto-fail')) { warned.add(repo + ':auto-fail'); console.error(`${repo}: 自动提交失败：${e.message}`); }
              recordAutoCommit({ mode, repo, error: e.message, count: s.changes.length });
              tracker.reject(repo, s.version);
            }
          }
        }
      } catch (e) {
        invalidate(repo); tracker.items.delete(repo);
        // 同一个仓库的老问题反复刷屏没有意义，只在说法变化时记一次
        if (lastError.get(repo) !== e.message) { lastError.set(repo, e.message); console.error(`${repo}: ${e.message}`); }
      }
    }
    if (errors.length) console.error(JSON.stringify(errors));
  }
  const stateWatcher = fs.watch(state, (event, name) => { if (/^run-.*\.json$/.test(String(name))) requestCheck(); });
  stateWatcher.on('error', () => { for (const repo of tracker.items.keys()) invalidate(repo); tracker.items.clear(); });
  round(); timer = setInterval(round, (config.pollSeconds ?? 30) * 1000);
  return { tracker, check: round, close() { stopped = true; clearInterval(timer); clearTimeout(wake); stateWatcher.close(); for (const w of watchers.values()) w.close(); } };
}
function arg(name, fallback) { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; }
async function main() {
  const command = process.argv[2];
  // 默认扫当前目录：写死别人的盘符路径，换台机器就指到不存在的地方
  if (command === 'scan' || command === 'once') output(scan(arg('--root', process.cwd())));
  else if (command === 'snapshot') output(snapshot(arg('--repo'), arg('--paths') ? JSON.parse(fs.readFileSync(arg('--paths'), 'utf8')) : undefined));
  else if (command === 'begin' || command === 'end') output(marker(arg('--repo'), command, arg('--token')));
  else if (command === 'recover') { const repo = arg('--repo'); output(process.argv.includes('--clear') ? clearRecovery(repo) : recoveryReport(repo)); }
  else if (command === 'recovery') { const repo = arg('--repo'), name = `recovery-${repoKey(repo)}.json`, transaction = transactionName(repo); output({ recoveryFile: path.join(state, name), record: load(name), transactionFile: path.join(state, transaction), transaction: load(transaction) }); }
  else if (command === 'prepare') {
    if (!arg('--paths')) throw new Error('必须通过 --paths 提供精确文件数组 JSON');
    const a = createApproval(arg('--repo'), JSON.parse(fs.readFileSync(arg('--paths'), 'utf8')), arg('--message', '保存本地修改'));
    const name = `approval-${a.id}.json`; save(name, a); output({ approvalFile: path.join(state, name), ...a });
  }
  else if (command === 'commit' || command === 'validate') {
    const bytes = fs.readFileSync(arg('--approval'));
    if (arg('--expected-sha') && sha(bytes) !== arg('--expected-sha')) throw new Error('展示的授权文件已变化');
    const a = JSON.parse(bytes.toString('utf8'));
    output(command === 'commit' ? commit(a) : { valid: true, version: validate(a).version });
  }
  else if (command === 'monitor') startMonitor(arg('--config') ? JSON.parse(fs.readFileSync(arg('--config'), 'utf8')) : {});
  else throw new Error('命令：scan、once、snapshot、begin、end、prepare、validate、commit、recovery、monitor');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => {
  if (e.code === 'COMMIT_RECOVERY_REQUIRED') { output({ status: e.status, message: e.message, commit: e.commit, repo: e.repo, indexPublished: e.indexPublished, indexCandidate: e.nextIndex, recoveryFile: e.recoveryFile, recoveryWritten: e.recoveryWritten, transactionFile: e.transactionFile }); process.exitCode = 2; }
  else { console.error(e.message); process.exitCode = 1; }
});
