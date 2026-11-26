import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const folder = path.dirname(fileURLToPath(import.meta.url));
const base = fs.mkdtempSync(path.resolve('.tmp/git-guard-tests-'));
process.env.GIT_GUARD_STATE = path.join(base, 'state');
process.env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const { snapshot, commit, scan, marker, busy, Tracker, createApproval, validate, startMonitor, defaultMessage, sameContent, contentDiff } = await import('./guard.mjs');
const { inspectPrereqs, pickGitAsset, pickPowerShellMsi, pickMirrorGitTag, mirrorGitAsset } = await import('./prereq.mjs');
let number = 0;
function run(cwd, cmd, args, extra = {}) { const p = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...extra }, windowsHide: true, timeout: 45000 }); if (p.status !== 0) throw new Error(`${cmd}: ${p.error?.message || p.stderr || p.stdout}`); return p.stdout.trim(); }
function git(repo, ...args) { return run(repo, 'git', args); }
// 有些调用故意返回非零退出码（拒绝意图就靠它传），不能走会抛错的 run
function spawnRaw(cwd, cmd, args) { return spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env }, windowsHide: true, timeout: 45000 }); }
function fixture(initial = true) {
  const repo = path.join(base, `repo ${++number} 中文`); fs.mkdirSync(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  if (initial) { fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n'); fs.writeFileSync(path.join(repo, 'b.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base'); }
  return repo;
}
function write(repo, name, text) { fs.writeFileSync(path.join(repo, name), text); }
function approve(repo, paths) { return { ...snapshot(repo, paths), message: 'fixture commit' }; }
const evidence = {};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function record(name, value) { evidence[name] = value; fs.writeFileSync(path.join(base, 'rework-evidence.json'), JSON.stringify(evidence, null, 2)); }
test('新增、删除、中文空格及保留其他暂存', () => {
  const r = fixture(); write(r, 'b.txt', 'staged\n'); git(r, 'add', '--', 'b.txt'); fs.unlinkSync(path.join(r, 'a.txt')); write(r, '新 文件.txt', 'new\n');
  write(r, 'b.txt', 'unselected work\n');
  const a = approve(r, ['a.txt', '新 文件.txt']); const before = git(r, 'show', ':b.txt'); const result = commit(a);
  assert.equal(fs.existsSync(path.join(process.env.GIT_GUARD_STATE, 'transaction-' + digest(a.repo) + '.json')), false);
  assert.match(result.commit, /^[0-9a-f]{40,64}$/); assert.equal(git(r, 'show', 'HEAD:新 文件.txt'), 'new'); assert.equal(git(r, 'show', ':b.txt'), before); assert.equal(git(r, 'show', 'HEAD:b.txt'), 'base');
  assert.throws(() => git(r, 'show', 'HEAD:a.txt'));
  assert.equal(fs.readFileSync(path.join(r, 'b.txt'), 'utf8'), 'unselected work\n');
  assert.throws(() => commit(a), /版本已变化/);
});
test('首提交', () => { const r = fixture(false); write(r, '首 次.txt', 'first'); const a = approve(r); assert.equal(a.head, null); const c = commit(a); assert.ok(c.commit); assert.equal(git(r, 'show', 'HEAD:首 次.txt'), 'first'); });
test('部分暂存和 hook 阻断且保持索引', () => {
  const r = fixture(); write(r, 'a.txt', 'stage'); git(r, 'add', 'a.txt'); write(r, 'a.txt', 'later'); const index = git(r, 'show', ':a.txt'); let a = approve(r); assert.match(a.reasons.join(), /部分暂存/); assert.throws(() => commit(a), /部分暂存/); assert.equal(git(r, 'show', ':a.txt'), index);
  write(r, 'a.txt', 'stage'); const hooksDir = path.join(r, 'custom hooks'); fs.mkdirSync(hooksDir); git(r, 'config', 'core.hooksPath', 'custom hooks'); fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); a = approve(r); assert.match(a.reasons.join(), /hook/); assert.throws(() => commit(a), /hook/);
});
test('同状态内容变化使确认失效并重计', () => {
  const r = fixture(); write(r, 'a.txt', 'one'); const a = approve(r); const t = new Tracker(600, 7200); t.observe(r, a.version, 0); write(r, 'a.txt', 'two'); const b = snapshot(r); assert.notEqual(a.version, b.version); t.observe(r, b.version, 500); assert.equal(t.ready(r, false, 700), false); assert.equal(t.ready(r, false, 1100), true); assert.throws(() => commit(a), /版本已变化/); t.reject(r, b.version, 1100); assert.equal(t.ready(r, false, 1200), false);
});
test('运行标记持续阻断及重复锁', () => {
  const r = fixture(); write(r, 'a.txt', 'changed'); const a = approve(r); marker(r, 'begin', 'one'); assert.equal(busy(r), true); assert.throws(() => commit(a), /运行标记/); marker(r, 'end', 'one'); const lock = path.join(r, '.git', 'index.lock'); fs.writeFileSync(lock, 'other'); assert.throws(() => commit(a), /EEXIST/); assert.equal(fs.readFileSync(lock, 'utf8'), 'other');
});
test('身份缺失时失败，索引与工作树保持', () => {
  const r = fixture(false); git(r, 'config', '--unset', 'user.name'); git(r, 'config', '--unset', 'user.email'); write(r, 'a.txt', 'work'); const a = approve(r); const prior = fs.existsSync(path.join(r, '.git', 'index')); assert.throws(() => commit(a)); assert.equal(fs.readFileSync(path.join(r, 'a.txt'), 'utf8'), 'work'); assert.equal(fs.existsSync(path.join(r, '.git', 'index')), prior);
});
test('扫描区分无仓库、检查失败并排除依赖目录', () => {
  const empty = path.join(base, 'empty'); fs.mkdirSync(empty); assert.equal(scan(empty).status, '未发现仓库'); assert.equal(scan(path.join(base, 'missing')).status, '检查失败');
  const hidden = path.join(empty, 'node_modules'); fs.mkdirSync(hidden); fs.writeFileSync(path.join(hidden, '.git'), 'gitdir: missing'); assert.equal(scan(empty).repos.length, 0);
});
test('真实隐藏 WinForms 三个按钮与退出码映射', () => {
  // 拒绝分两种意图：只是这次不提交，还是这段时间别烦我。窗口用退出码把它告诉监视进程。
  const expect = { confirm: ['committed', 0], cancel: ['skipped', 3], snooze: ['snoozed', 4] };
  for (const action of Object.keys(expect)) {
    const r = fixture(); write(r, 'a.txt', action); const a = approve(r); const f = path.join(base, `approval-${action}.json`); fs.writeFileSync(f, JSON.stringify(a)); const old = git(r, 'rev-parse', 'HEAD');
    const result = run(folder, 'pwsh', ['-NoProfile', '-STA', '-File', path.join(folder, 'window.ps1'), '-Approval', f, '-SelfTest', action, '-NodeExe', process.execPath]);
    assert.equal(JSON.parse(result), expect[action][0]);
    assert.equal(git(r, 'rev-parse', 'HEAD') === old, action !== 'confirm');
    const coded = spawnRaw(folder, 'pwsh', ['-NoProfile', '-STA', '-File', path.join(folder, 'window.ps1'), '-Approval', f, '-SelfTest', action, '-SelfTestExit', '-NodeExe', process.execPath]);
    assert.equal(coded.status, expect[action][1], action + ' 的退出码');
  }
});
test('本次不提交只跳过一个版本，一段时间不打扰到期前不再问', () => {
  const t = new Tracker(1000, 7200000), r = fixture();
  const v1 = snapshot(r).version; t.observe(r, v1);
  t.skip(r, v1);
  assert.equal(t.ready(r, false, Date.now() + 60000, 1000), false, '同一版本不再问，也不受冷却时间影响');
  const v2 = v1 + '-changed'; t.observe(r, v2);
  assert.equal(t.ready(r, false, Date.now() + 60000, 1000), true, '文件变了就该重新问');
  t.snooze(r, Date.now() + 3600000);
  assert.equal(t.ready(r, false, Date.now() + 60000, 1000), false, '不打扰期间不处理');
  assert.equal(t.ready(r, false, Date.now() + 7200000, 1000), true, '到点后恢复');
});
test('默认提交说明带本地时间，并标明文件数', () => {
  assert.equal(defaultMessage(new Date(2026, 10, 25, 9, 5)), '11月25日09:05：自动提交');
  assert.equal(defaultMessage(new Date(2026, 0, 1, 0, 0)), '1月1日00:00：自动提交');
  assert.equal(defaultMessage(new Date(2026, 10, 25, 9, 5), 3), '11月25日09:05：自动提交（3 个文件）');
  assert.equal(defaultMessage(new Date(2026, 10, 25, 9, 5), 0), '11月25日09:05：自动提交', '没有文件数时不拼空括号');
});
test('.git 文件工作树及已有完全暂存', () => {
  const r = fixture(); const linked = path.join(base, 'linked 中文 空格');
  git(r, 'worktree', 'add', '-qb', 'linked-test', linked); assert.equal(fs.statSync(path.join(linked, '.git')).isFile(), true);
  write(linked, 'a.txt', 'staged'); git(linked, 'add', 'a.txt'); const a = createApproval(linked, ['a.txt'], 'worktree commit'); commit(a);
  assert.equal(git(linked, 'show', 'HEAD:a.txt'), 'staged'); assert.equal(git(linked, 'status', '--porcelain'), '');
});
test('自身状态、构建和备份不影响指纹', () => {
  const r = fixture(); write(r, 'a.txt', 'dirty'); const a = snapshot(r);
  for (const dir of ['.state', 'node_modules', 'dist', '备份', 'backup-2026']) { fs.mkdirSync(path.join(r, dir)); write(r, `${dir}/log.txt`, 'generated'); }
  const b = snapshot(r); assert.equal(a.version, b.version); assert.equal(b.paths.includes('.state/log.txt'), false);
});
test('精确范围 prepare/validate/commit 非交互入口', () => {
  const r = fixture(); write(r, 'a.txt', 'cli'); write(r, 'b.txt', 'keep'); const paths = path.join(base, 'scope.json'); fs.writeFileSync(paths, JSON.stringify(['a.txt']));
  const a = JSON.parse(run(folder, process.execPath, [path.join(folder, 'guard.mjs'), 'prepare', '--repo', r, '--paths', paths, '--message', 'exact scope']));
  assert.equal(JSON.parse(run(folder, process.execPath, [path.join(folder, 'guard.mjs'), 'validate', '--approval', a.approvalFile])).valid, true);
  const result = JSON.parse(run(folder, process.execPath, [path.join(folder, 'guard.mjs'), 'commit', '--approval', a.approvalFile])); assert.ok(result.commit);
  assert.equal(git(r, 'show', 'HEAD:b.txt'), 'base'); assert.equal(fs.readFileSync(path.join(r, 'b.txt'), 'utf8'), 'keep');
});
test('运行结束即时检查、事件变动撤销旧授权', async () => {
  const r = fixture(); write(r, 'a.txt', 'ready'); marker(r, 'begin', 'writer'); let accept;
  const shown = new Promise(resolve => { accept = resolve; });
  // 现在只监视显式列出的项目（不再有「扫描根目录」回退）
  const m = startMonitor({ projects: [{ path: r, enabled: true }], idleSeconds: 600, pollSeconds: 1800 }, (a, done) => accept({ a, done }));
  try {
    m.tracker.items.get(snapshot(r).repo).since = Date.now() - 601000;
    marker(r, 'end', 'writer');
    let timeout; const result = await Promise.race([shown, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('end 未触发即时检查')), 20000); })]); clearTimeout(timeout);
    write(r, 'a.txt', 'temporary'); write(r, 'a.txt', 'ready'); await new Promise(resolve => setTimeout(resolve, 200));
    assert.throws(() => validate(result.a), /旧确认失效/); result.done();
  } finally { m.close(); }
});
test('停手计时按文件最后改动算：重启后不会让早已停手的仓库重新等一轮', async () => {
  const r = fixture();
  write(r, 'a.txt', '停了很久的改动');
  // 文件三小时前就写完了；监视器却是「刚刚」启动的
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  fs.utimesSync(path.join(r, 'a.txt'), old, old);
  let accept;
  const shown = new Promise(resolve => { accept = resolve; });
  // 停手阈值仍是 10 分钟：若按监视器启动时刻计时，这里至少要等 10 分钟才会提醒
  const m = startMonitor({ projects: [{ path: r, enabled: true }], idleSeconds: 600, pollSeconds: 1800 }, (a, done) => accept({ a, done }));
  try {
    let timeout;
    const result = await Promise.race([
      shown,
      new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('按启动时刻计时了，重启后又要等满一轮')), 6000); })
    ]);
    clearTimeout(timeout);
    assert.ok(result.a.changes.length > 0);
    result.done();
  } finally { m.close(); }
});

test('监视自己的 git status 不算改动：已弹出的确认仍然有效', async () => {
  const r = fixture();
  write(r, 'a.txt', '待提交的改动');
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  fs.utimesSync(path.join(r, 'a.txt'), old, old);
  let accept;
  const shown = new Promise(resolve => { accept = resolve; });
  // pollSeconds=1：弹窗后监视还会跑好几轮，每轮都会执行 git status（会创建 .git/index.lock）
  const m = startMonitor({ projects: [{ path: r, enabled: true }], idleSeconds: 600, pollSeconds: 1 }, (a, done) => accept({ a, done }));
  try {
    let timeout;
    const { a, done } = await Promise.race([shown, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('没有弹窗')), 15000); })]);
    clearTimeout(timeout);
    // 复现「监视器自己跑 git status」：它会重写 .git/index（只改 mtime 就够触发事件）
    // 和创建删除 .git/index.lock。这些都不是工作区改动，不该让确认失效。
    const now = new Date();
    fs.utimesSync(path.join(r, '.git', 'index'), now, now);
    fs.writeFileSync(path.join(r, '.git', 'index.lock'), '');
    await new Promise(resolve => setTimeout(resolve, 400));
    fs.unlinkSync(path.join(r, '.git', 'index.lock'));
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(fs.existsSync(path.join(base, `invalid-${a.id}.json`)), false, '.git 里的动静不该让确认失效');
    assert.ok(validate(a));   // 不会抛「弹窗后观察到修改，旧确认失效」
    done();
  } finally { m.close(); }
});

test('重启后接手仍然有效的旧弹窗，不重复叠窗口', async () => {
  const r = fixture();
  write(r, 'a.txt', '待提交');
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  fs.utimesSync(path.join(r, 'a.txt'), old, old);
  const cfg = { projects: [{ path: r, enabled: true }], idleSeconds: 600, pollSeconds: 1 };
  let accept;
  const shown = new Promise(resolve => { accept = resolve; });
  // 第一次：弹窗，模拟「人不回应」，窗口一直挂着
  const m1 = startMonitor(cfg, (a, done) => accept({ a, done }));
  let timeout;
  const first = await Promise.race([shown, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('第一次没有弹窗')), 15000); })]);
  clearTimeout(timeout);
  // 模拟窗口进程还活着（真实场景里是独立的 pwsh 进程，不随应用退出）
  fs.writeFileSync(path.join(process.env.GIT_GUARD_STATE, `window-${first.a.id}.json`), JSON.stringify({ pid: process.pid, repo: first.a.repo }));
  m1.close();   // 应用退出，但窗口进程还在屏幕上
  // 第二次启动（模拟重启重开）：不应再弹一个
  let again = 0;
  const m2 = startMonitor(cfg, (a, done) => { again++; });
  try {
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal(again, 0, '重启后不该为同一个仓库再弹一个窗口');
    // 旧窗口还能用：这段时间没有被判失效
    assert.ok(validate(first.a));
    first.done();
  } finally { m2.close(); }
});


test('残留的审批文件不带活窗口时不再占用名额', async () => {
  const r = fixture();
  write(r, 'a.txt', '待提交');
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  fs.utimesSync(path.join(r, 'a.txt'), old, old);
  // 造一个「窗口已经关掉」的残留审批：PID 指向一个不存在的进程
  const stale = { id: 'dead-window-approval', repo: r.replace(/\\/g, '/'), paths: ['a.txt'], changes: [], message: 'x', version: 'x' };
  fs.writeFileSync(path.join(process.env.GIT_GUARD_STATE, `approval-${stale.id}.json`), JSON.stringify(stale));
  fs.writeFileSync(path.join(process.env.GIT_GUARD_STATE, `window-${stale.id}.json`), JSON.stringify({ pid: 999999, repo: stale.repo }));
  let fired = 0;
  const m = startMonitor({ projects: [{ path: r, enabled: true }], idleSeconds: 600, pollSeconds: 1 }, (a, done) => { fired++; done && done(); });
  try {
    await new Promise(resolve => setTimeout(resolve, 4000));
    assert.ok(fired > 0, '窗口早就关了的残留审批不该挡住新的提醒');
    assert.equal(fs.existsSync(path.join(process.env.GIT_GUARD_STATE, `approval-${stale.id}.json`)), false, '残留审批文件应被清掉');
  } finally { m.close(); }
});

test('窗口自查：有效审批通过，失效审批带回原因', () => {
  const r = fixture();
  write(r, 'a.txt', '待提交');
  const s = snapshot(r);
  const a = { ...s, message: 'x', id: crypto.randomUUID() };
  fs.mkdirSync(process.env.GIT_GUARD_STATE, { recursive: true });
  const file = path.join(process.env.GIT_GUARD_STATE, `approval-${a.id}.json`);
  fs.writeFileSync(file, JSON.stringify(a));
  const win = path.join(folder, 'window.ps1');
  // 有效：这条路径正是窗口每 3 秒做的复查
  const okRun = spawnRaw(folder, 'pwsh', ['-NoProfile', '-STA', '-File', win, '-Approval', file, '-NodeExe', process.execPath, '-SelfTestTimer']);
  const ok = JSON.parse(okRun.stdout.trim());
  assert.equal(ok.ok, true, '有效审批的复查必须通过：' + ok.text);
  assert.equal(okRun.status, 0);
  // 失效：授权之后工作区又变了，复查必须失败并带回原因
  write(r, 'a.txt', '授权之后又改了');
  const staleFile = path.join(process.env.GIT_GUARD_STATE, `approval-stale-${a.id}.json`);
  fs.writeFileSync(staleFile, JSON.stringify(a));
  const badRun = spawnRaw(folder, 'pwsh', ['-NoProfile', '-STA', '-File', win, '-Approval', staleFile, '-NodeExe', process.execPath, '-SelfTestTimer']);
  const bad = JSON.parse(badRun.stdout.trim());
  assert.equal(bad.ok, false, '失效审批的复查必须失败');
  assert.equal(badRun.status, 1, '复查失败时要给出非零退出码');
  assert.match(bad.text, /失效|变化|过期/, '失败时要带上人能看懂的原因');
});

test('环境自查识别缺 git、缺 pwsh、缺提交身份', () => {
  const all = { exec: () => ({ ok: true, out: 'git version 2.40.0' }) };
  // pwsh 那条命令要返回主版本号，其它返回版本串
  const fakeFull = { exec: (f, a) => (a.some(x => String(x).includes('PSVersionTable')) ? { ok: true, out: '7' } : { ok: true, out: 'git version 2.40.0' }) };
  const good = inspectPrereqs(fakeFull);
  assert.equal(good.ok, true, '全齐时应当 ok');
  assert.deepEqual(good.missing, []);

  const noGit = inspectPrereqs({ exec: (f) => (f === 'git' ? { ok: false, out: '' } : { ok: true, out: '7' }) });
  assert.equal(noGit.ok, false);
  assert.deepEqual(noGit.missing, ['git']);
  // git 都没有时不再追问提交身份（没有意义）
  assert.equal(noGit.items.some(i => i.id === 'identity'), false);

  const noPwsh = inspectPrereqs({ exec: (f, a) => (f === 'pwsh' ? { ok: false, out: '' } : { ok: true, out: 'x' }) });
  assert.deepEqual(noPwsh.missing, ['pwsh']);
  assert.equal(noPwsh.items.find(i => i.id === 'pwsh').fix, 'download');

  // 只有 5.1：版本号不够，也算缺
  const oldPwsh = inspectPrereqs({ exec: (f, a) => (f === 'pwsh' ? { ok: true, out: '5' } : { ok: true, out: 'x' }) });
  assert.deepEqual(oldPwsh.missing, ['pwsh']);

  const noId = inspectPrereqs({ exec: (f, a) => (a.includes('config') ? { ok: false, out: '' } : (a.some(x => String(x).includes('PSVersionTable')) ? { ok: true, out: '7' } : { ok: true, out: 'x' })) });
  assert.deepEqual(noId.missing, ['identity']);
  const idItem = noId.items.find(i => i.id === 'identity');
  assert.equal(idItem.fix, 'config');
  assert.equal(idItem.commands.length, 2);
});

test('安装包挑法：Git 取 64 位安装器，PowerShell 取最新带 MSI 的稳定版', () => {
  const gitRel = { assets: [
    { name: 'Git-2.56.1-32-bit.exe', browser_download_url: 'u32', size: 1 },
    { name: 'Git-2.56.1-64-bit.exe', browser_download_url: 'u64', size: 2 },
    { name: 'PortableGit.7z.exe', browser_download_url: 'portable', size: 3 }
  ] };
  assert.equal(pickGitAsset(gitRel).url, 'u64');
  assert.equal(pickGitAsset({ assets: [] }), null);

  // 最新版常常只发 zip，要往更早的稳定版退
  const rels = [
    { tag_name: 'v7.7.0', draft: false, prerelease: false, assets: [{ name: 'PowerShell-7.7.0-win-x64.zip', browser_download_url: 'zip' }] },
    { tag_name: 'v7.7.0-rc.1', draft: false, prerelease: true, assets: [{ name: 'PowerShell-7.7.0-rc.1-win-x64.msi', browser_download_url: 'rc' }] },
    { tag_name: 'v7.6.10', draft: false, prerelease: false, assets: [{ name: 'PowerShell-7.6.10-win-x64.msi', browser_download_url: 'msi', size: 9 }] }
  ];
  const ps = pickPowerShellMsi(rels);
  assert.equal(ps.url, 'msi', '要跳过只有 zip 的最新版，也要跳过预发布');
  assert.equal(ps.version, 'v7.6.10');
});


test('GitHub 连不上时退国内镜像，按目录列表挑最新版本', () => {
  const listing = [
    { name: 'v2.55.0.windows.3/', type: 'dir' },
    { name: 'v2.56.1.windows.1/', type: 'dir' },
    { name: 'v2.56.1.windows.10/', type: 'dir' },
    { name: 'portable/', type: 'dir' },
    { name: 'readme.md', type: 'file' }
  ];
  const tag = pickMirrorGitTag(listing);
  assert.equal(tag, 'v2.56.1.windows.10', '按出现顺序取最后一个版本目录，不能按字符串排序');
  const asset = mirrorGitAsset(tag);
  assert.equal(asset.name, 'Git-2.56.1-64-bit.exe');
  assert.match(asset.url, /^https:\/\/registry\.npmmirror\.com\/-\/binary\/git-for-windows\/v2\.56\.1\.windows\.10\//);
  assert.equal(pickMirrorGitTag([]), null);
  assert.equal(pickMirrorGitTag(null), null);
  assert.equal(pickMirrorGitTag([{ name: 'v1.0.0/' }]), null, '不完整的版本号不算');
});


test('改无关文件不作废确认，改批准的文件才作废并说清是哪个', async () => {
  const r = fixture(); write(r, 'a.txt', 'approved'); write(r, 'b.txt', 'other');
  const a = { ...snapshot(r, ['a.txt']), message: 'scope test' };
  // 只改了 b.txt（不在批准范围内）——这份确认仍然有效，提交也只提交 a.txt
  write(r, 'b.txt', 'other changed');
  assert.equal(sameContent(a, snapshot(r, ['a.txt'])), true, '无关文件变化不该作废确认');
  // 批准的那个文件被改了，才必须作废，并且提示里要带出文件名
  write(r, 'a.txt', 'approved changed');
  const now = snapshot(r, ['a.txt']);
  assert.equal(sameContent(a, now), false, '批准的文件变了必须作废');
  assert.deepEqual(contentDiff(a, now), ['a.txt']);
});

test('监听无关文件不作废确认，只有确认覆盖的文件变了才作废', async () => {
  const r = fixture(); write(r, 'a.txt', 'approved');
  const got = [];
  const m = startMonitor({ projects: [{ path: r, enabled: true }], idleSeconds: 600, pollSeconds: 1800 }, (a) => got.push(a));
  try {
    const repo = snapshot(r).repo;
    m.tracker.items.get(repo).since = Date.now() - 601000;
    for (let i = 0; i < 80 && !got.length; i++) { await new Promise(res => setTimeout(res, 100)); m.check(); }
    assert.equal(got.length, 1, '应先弹出一份确认');
    const a = got[0];
    assert.deepEqual(a.paths, ['a.txt'], '这份确认只覆盖 a.txt');
    // 在同一个仓库里新建别的文件：不该作废这份确认
    write(r, 'b.txt', 'unrelated work');
    await new Promise(res => setTimeout(res, 400));
    validate(a);
    // 确认覆盖的那个文件真的改了，才必须作废，并说清是哪个文件
    write(r, 'a.txt', 'approved changed');
    await new Promise(res => setTimeout(res, 400));
    assert.throws(() => validate(a), /旧确认失效/);
    assert.throws(() => validate(a), /a\.txt/);
  } finally { m.close(); }
});

test('包名必须固定：它决定用户配置目录，改名会让老配置看起来丢了', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'git-quiet-helper',
    'Electron 用 package.json 的 name 推导 %APPDATA% 目录；改名等于换一个空配置目录，用户会以为设置被删了');
});

test('默认 hook 存在时隐藏窗口确认按钮阻断', () => {
  const r = fixture(); write(r, 'a.txt', 'hook'); const hook = path.join(r, '.git', 'hooks', 'pre-commit'); fs.writeFileSync(hook, '#!/bin/sh\necho bad > hook-ran\n', { mode: 0o755 }); const a = approve(r); assert.match(a.reasons.join(), /hook/);
  const f = path.join(base, 'blocked.json'); fs.writeFileSync(f, JSON.stringify(a)); const old = git(r, 'rev-parse', 'HEAD');
  const result = run(folder, 'pwsh', ['-NoProfile', '-STA', '-File', path.join(folder, 'window.ps1'), '-Approval', f, '-SelfTest', 'confirm', '-NodeExe', process.execPath]);
  assert.equal(JSON.parse(result), ''); assert.equal(git(r, 'rev-parse', 'HEAD'), old); assert.equal(fs.existsSync(path.join(r, 'hook-ran')), false);
});
test('Windows 大小写别名共用身份、运行标记、协调锁与冷却', () => {
  const r = fixture(), alias = process.platform === 'win32' ? r.toUpperCase() : r;
  const realStat = fs.statSync(r), aliasStat = fs.statSync(alias);
  assert.equal(realStat.dev, aliasStat.dev); assert.equal(realStat.ino, aliasStat.ino);
  write(r, 'a.txt', 'case-sensitive authorization');
  const a = createApproval(r, ['a.txt'], 'case alias test'), aliased = snapshot(alias, ['a.txt']);
  assert.equal(a.repo, aliased.repo); assert.equal(a.version, aliased.version);
  const head = git(r, 'rev-parse', 'HEAD'), indexFile = path.join(r, '.git', 'index'), index = fs.readFileSync(indexFile);
  marker(alias, 'begin', 'case-writer');
  try { assert.equal(busy(r), true); assert.throws(() => commit(a), /运行标记/); }
  finally { marker(r, 'end', 'case-writer'); }
  marker(r, 'begin', 'reverse-case-writer');
  try { assert.equal(busy(alias), true); assert.throws(() => commit({ ...a, repo: alias }), /运行标记/); }
  finally { marker(alias, 'end', 'reverse-case-writer'); }
  const lock = path.join(process.env.GIT_GUARD_STATE, 'run-' + digest(a.repo) + '.json.lock');
  fs.writeFileSync(lock, 'fixture-owned coordination lock', { flag: 'wx' });
  try {
    assert.equal(busy(alias), true); assert.throws(() => commit({ ...a, repo: alias }), /协调锁/);
    assert.throws(() => marker(alias, 'begin', 'blocked'), /EEXIST/);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'fixture-owned coordination lock');
  } finally { fs.unlinkSync(lock); }
  const tracker = new Tracker(600, 7200); tracker.observe(alias, a.version, 0);
  assert.equal(tracker.ready(r, false, 600), true); tracker.reject(r, a.version, 600);
  assert.equal(tracker.ready(alias, false, 601), false); assert.equal(tracker.items.size, 1);
  assert.equal(git(r, 'rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(indexFile), index);
  record('case-alias', { repo: r, alias, canonicalRepo: a.repo, samePhysicalDirectory: true, version: a.version, headBefore: head, headAfter: head, indexBefore: digest(index), indexAfter: digest(fs.readFileSync(indexFile)), busyAndLockBlocked: true, sharedCooldown: true });
});
test('索引只读在创建提交前阻断，HEAD、索引和其他部分暂存不变', () => {
  const r = fixture(); write(r, 'a.txt', 'confirmed'); write(r, 'b.txt', 'staged-other'); git(r, 'add', 'b.txt'); write(r, 'b.txt', 'unselected-work');
  const a = createApproval(r, ['a.txt'], 'readonly test'), indexFile = path.join(r, '.git', 'index');
  const head = git(r, 'rev-parse', 'HEAD'), index = fs.readFileSync(indexFile), mode = fs.statSync(indexFile).mode;
  fs.chmodSync(indexFile, 0o444);
  try {
    assert.throws(() => commit(a), /索引只读或不可发布，未创建提交/);
    assert.equal(git(r, 'rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(indexFile), index);
    assert.equal(git(r, 'show', ':b.txt'), 'staged-other'); assert.equal(fs.readFileSync(path.join(r, 'b.txt'), 'utf8'), 'unselected-work');
    assert.equal(fs.readFileSync(path.join(r, 'a.txt'), 'utf8'), 'confirmed'); assert.equal(fs.existsSync(indexFile + '.lock'), false);
    record('readonly-index', { repo: r, headBefore: head, headAfter: head, indexBefore: digest(index), indexAfter: digest(fs.readFileSync(indexFile)), blockedBeforeCommit: true, unselectedPartialStagePreserved: true });
  } finally { fs.chmodSync(indexFile, mode); }
});
test('发布故障注入返回提交号、保留候选并阻断别名重试，真实 GUI 显示待恢复', () => {
  for (const mode of ['cli', 'gui']) {
    const r = fixture(); write(r, 'a.txt', 'confirmed-' + mode); write(r, 'b.txt', 'staged-other'); git(r, 'add', 'b.txt'); write(r, 'b.txt', 'unselected-work');
    const a = createApproval(r, ['a.txt'], 'publish failure ' + mode), indexFile = path.join(r, '.git', 'index'), index = fs.readFileSync(indexFile);
    const approval = path.join(base, 'publish-' + mode + '.json'), preload = path.join(base, 'inject-' + mode + '.mjs');
    fs.writeFileSync(approval, JSON.stringify(a));
    fs.writeFileSync(preload, "import fs from 'node:fs'; import path from 'node:path';\nconst target = " + JSON.stringify(path.resolve(indexFile).toLowerCase()) + ";\nconst rename = fs.renameSync; fs.renameSync = function(from, to) { if (path.resolve(to).toLowerCase() === target) { throw Object.assign(new Error('fixture final index publication EPERM'), { code: 'EPERM' }); } return rename.apply(this, arguments); };\n");
    const extra = { NODE_OPTIONS: '--import=' + pathToFileURL(preload).href };
    let details, cliExit;
    if (mode === 'cli') {
      const p = spawnSync(process.execPath, [path.join(folder, 'guard.mjs'), 'commit', '--approval', approval], { cwd: folder, env: { ...process.env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 45000 });
      assert.equal(p.status, 2, p.stderr || p.stdout); cliExit = p.status; details = JSON.parse(p.stdout);
      assert.equal(details.status, 'committed-index-pending'); assert.match(details.message, /提交已生成，索引待恢复/);
    } else {
      details = JSON.parse(run(folder, 'pwsh', ['-NoProfile', '-STA', '-File', path.join(folder, 'window.ps1'), '-Approval', approval, '-SelfTest', 'confirm', '-SelfTestDetails', '-NodeExe', process.execPath], extra));
      assert.equal(details.outcome, 'committed-index-pending'); assert.match(details.status, /提交已生成，索引待恢复/);
      assert.equal(details.confirmEnabled, false); assert.equal(details.handleCreated, true);
    }
    const head = git(r, 'rev-parse', 'HEAD'); assert.notEqual(head, a.head); assert.equal(git(r, 'show', 'HEAD:a.txt'), 'confirmed-' + mode);
    assert.deepEqual(fs.readFileSync(indexFile), index); assert.equal(git(r, 'show', ':b.txt'), 'staged-other');
    assert.equal(fs.readFileSync(path.join(r, 'b.txt'), 'utf8'), 'unselected-work');
    const recovery = JSON.parse(run(folder, process.execPath, [path.join(folder, 'guard.mjs'), 'recovery', '--repo', r]));
    const alias = process.platform === 'win32' ? r.toUpperCase() : r;
    assert.deepEqual(JSON.parse(run(folder, process.execPath, [path.join(folder, 'guard.mjs'), 'recovery', '--repo', alias])), recovery);
    assert.equal(recovery.record.commit, head); assert.equal(recovery.record.status, 'committed-index-pending');
    assert.equal(fs.existsSync(recovery.record.nextIndex), true);
    assert.equal(run(r, 'git', ['show', ':a.txt'], { GIT_INDEX_FILE: recovery.record.nextIndex }), 'confirmed-' + mode);
    assert.equal(run(r, 'git', ['show', ':b.txt'], { GIT_INDEX_FILE: recovery.record.nextIndex }), 'staged-other');
    assert.throws(() => validate(a), /事务尚未完成|恢复记录/); assert.throws(() => commit({ ...a, repo: alias }), /事务尚未完成|恢复记录/);
    if (mode === 'gui') { assert.ok(details.status.includes(head)); assert.ok(details.status.includes(recovery.recoveryFile)); assert.ok(details.status.includes(recovery.record.nextIndex)); }
    record('publication-failure-' + mode, { repo: r, previousHead: a.head, commit: head, indexBefore: digest(index), indexAfter: digest(fs.readFileSync(indexFile)), recoveryFile: recovery.recoveryFile, indexCandidate: recovery.record.nextIndex, candidateSelectedAndOtherStageVerified: true, aliasRetryBlocked: true, cliExit, gui: mode === 'gui' ? details : undefined });
  }
});
test('安装入口拒绝非 PowerShell 7 宿主且未调用任务注册', () => {
  const installer = path.join(folder, 'install-task.ps1').replaceAll("'", "''");
  const script = "$script:registered = $false; function Register-ScheduledTask { $script:registered = $true; throw 'unexpected registration' }; $PSVersionTable.PSVersion = [version]'5.1'; try { & '" + installer + "'; throw 'installer did not block' } catch { if ($_.Exception.Message -notlike '*PowerShell 7*') { throw }; @{ message=$_.Exception.Message; registered=$script:registered } | ConvertTo-Json -Compress }";
  const result = JSON.parse(run(folder, 'pwsh', ['-NoProfile', '-Command', script]));
  assert.equal(result.registered, false); assert.match(result.message, /PowerShell 7/);
  record('powershell-host-guard', { simulatedVersion: '5.1 under PowerShell 7', ...result });
});
test('合法未跟踪嵌套 Git 工作树独立扫描，普通 skills 文件仍进入父仓库', () => {
  const r = fixture(), nested = path.join(r, 'skills', 'awesome-design-html'), linked = path.join(r, 'skills', 'linked 中文');
  fs.mkdirSync(nested, { recursive: true }); git(nested, 'init', '-q'); git(nested, 'config', 'user.name', 'Fixture'); git(nested, 'config', 'user.email', 'fixture@example.invalid');
  write(nested, 'child.txt', 'child base'); git(nested, 'add', '.'); git(nested, 'commit', '-qm', 'child base');
  git(nested, 'worktree', 'add', '-qb', 'nested-linked', linked); write(nested, 'child.txt', 'child dirty'); write(linked, 'linked.txt', 'linked new');
  write(r, 'skills/notes.txt', 'ordinary skills file'); write(r, 'a.txt', 'parent change');
  const parent = snapshot(r); assert.deepEqual(parent.reasons, []);
  assert.deepEqual(parent.nestedWorktrees.sort(), ['skills/awesome-design-html', 'skills/linked 中文']);
  assert.equal(parent.paths.some(p => p.startsWith('skills/awesome-design-html') || p.startsWith('skills/linked 中文')), false);
  assert.equal(parent.paths.includes('skills/notes.txt'), true);
  const found = scan(r); assert.deepEqual(found.errors, []); assert.equal(found.repos.length, 3);
  assert.equal(found.repos.filter(x => x.changes === 1).length, 2);
  const childIndex = fs.readFileSync(path.join(nested, '.git', 'index')), childHead = git(nested, 'rev-parse', 'HEAD');
  const result = commit(createApproval(r, parent.paths, 'parent only'));
  assert.equal(git(r, 'show', 'HEAD:skills/notes.txt'), 'ordinary skills file');
  assert.equal(git(r, 'ls-tree', 'HEAD', '--', 'skills/awesome-design-html', 'skills/linked 中文'), '');
  assert.equal(git(nested, 'rev-parse', 'HEAD'), childHead); assert.deepEqual(fs.readFileSync(path.join(nested, '.git', 'index')), childIndex);
  assert.equal(fs.readFileSync(path.join(nested, 'child.txt'), 'utf8'), 'child dirty');
  assert.equal(fs.readFileSync(path.join(linked, 'linked.txt'), 'utf8'), 'linked new');
  record('nested-worktrees', { repo: r, nestedWorktrees: parent.nestedWorktrees, parentPaths: parent.paths, scannedRepos: found.repos.map(x => x.repo), commit: result.commit, nestedIndexAndHeadUnchanged: true });
});
test('已跟踪 gitlink 子模块仍阻断', () => {
  const r = fixture(), head = git(r, 'rev-parse', 'HEAD');
  git(r, 'update-index', '--add', '--cacheinfo', '160000,' + head + ',skills/tracked-module'); write(r, 'a.txt', 'changed');
  const index = fs.readFileSync(path.join(r, '.git', 'index')), a = createApproval(r, ['a.txt'], 'must block submodule');
  assert.match(a.reasons.join(), /含子模块/); assert.throws(() => commit(a), /含子模块/);
  assert.equal(git(r, 'rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(path.join(r, '.git', 'index')), index);
  record('tracked-submodule-blocked', { repo: r, head, reasons: a.reasons, indexUnchanged: true });
});
test('方括号及前导短横文件名按字面执行，不匹配其他改动', () => {
  const r = fixture(); write(r, '[ab].txt', 'literal bracket'); write(r, '-[xy] 中文.txt', 'literal dash');
  write(r, 'a.txt', 'unselected work'); write(r, 'b.txt', 'unselected staged'); git(r, 'add', 'b.txt'); write(r, 'b.txt', 'unselected partial work');
  const a = createApproval(r, ['[ab].txt', '-[xy] 中文.txt'], 'literal names'); const result = commit(a);
  const names = git(r, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', result.commit).split('\0').filter(Boolean).sort();
  assert.deepEqual(names, ['-[xy] 中文.txt', '[ab].txt']);
  assert.equal(git(r, 'show', 'HEAD:a.txt'), 'base'); assert.equal(git(r, 'show', 'HEAD:b.txt'), 'base');
  assert.equal(git(r, 'show', ':b.txt'), 'unselected staged'); assert.equal(fs.readFileSync(path.join(r, 'b.txt'), 'utf8'), 'unselected partial work');
  assert.equal(fs.readFileSync(path.join(r, 'a.txt'), 'utf8'), 'unselected work');
  record('literal-paths', { repo: r, paths: a.paths, committedNames: names, commit: result.commit, otherPartialStagePreserved: true });
});
test('超过 Windows 32K 的真实合法文件清单经 stdin 完成增改删并保留其他暂存', () => {
  const r = fixture(), dir = '长清单 合法目录', paths = []; fs.mkdirSync(path.join(r, dir));
  for (let i = 0; i < 2600; i++) {
    const name = `${dir}/file-${String(i).padStart(4, '0')}-[literal]-long-path-segment-中文 空格.txt`;
    paths.push(name); write(r, name, 'before ' + i);
  }
  git(r, 'add', '--', dir); git(r, 'commit', '-qm', 'long-list baseline');
  for (let i = 0; i < paths.length; i++) { if (i % 2 === 0) fs.unlinkSync(path.join(r, paths[i])); else write(r, paths[i], 'after ' + i); }
  for (let i = 0; i < 64; i++) { const name = `${dir}/new-${i}-[literal]-long-path-segment-中文 空格.txt`; paths.push(name); write(r, name, 'new ' + i); }
  write(r, 'b.txt', 'other staged'); git(r, 'add', '--', 'b.txt'); write(r, 'b.txt', 'other partial work');
  const quotedUtf16Units = paths.reduce((sum, name) => sum + name.length + 3, 0);
  assert.ok(quotedUtf16Units > 32767); assert.ok(paths.length > 2472);
  const a = createApproval(r, paths, 'stdin long list'); assert.deepEqual(a.reasons, []); const result = commit(a);
  const committedNames = git(r, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', result.commit).split('\0').filter(Boolean);
  assert.deepEqual(committedNames.sort(), [...paths].sort());
  assert.equal(git(r, 'show', 'HEAD:b.txt'), 'base'); assert.equal(git(r, 'show', ':b.txt'), 'other staged');
  assert.equal(fs.readFileSync(path.join(r, 'b.txt'), 'utf8'), 'other partial work');
  assert.equal(git(r, 'show', 'HEAD:' + paths[1]), 'after 1');
  const treeNames = git(r, 'ls-tree', '-rz', '--name-only', 'HEAD').split('\0').filter(Boolean);
  assert.deepEqual(treeNames.sort(), ['a.txt', 'b.txt', ...paths.filter((_, i) => i >= 2600 || i % 2 === 1)].sort());
  assert.equal(git(r, 'show', 'HEAD:' + paths.at(-1)), 'new 63');
  record('long-list-stdin', { repo: r, pathCount: paths.length, quotedUtf16Units, maxAbsolutePathLength: Math.max(...paths.map(name => path.join(r, name).length)), deleted: 1300, modified: 1300, added: 64, actualCommittedCount: committedNames.length, commit: result.commit, otherPartialStagePreserved: true });
});
test('索引发布与恢复落盘双故障后，新 ID 与大小写别名仍被提交前持久门禁阻断', () => {
  for (const mode of ['cli', 'gui']) {
    const r = fixture(); write(r, 'a.txt', 'double-fault-' + mode); write(r, 'b.txt', 'other staged'); git(r, 'add', 'b.txt'); write(r, 'b.txt', 'other work');
    const a = createApproval(r, ['a.txt'], 'double failure ' + mode), indexFile = path.join(r, '.git', 'index'), index = fs.readFileSync(indexFile);
    const transactionFile = path.join(process.env.GIT_GUARD_STATE, 'transaction-' + digest(a.repo) + '.json');
    const approval = path.join(base, 'double-' + mode + '.json'), preload = path.join(base, 'double-inject-' + mode + '.mjs'), gateProof = path.join(base, 'gate-proof-' + mode + '.json');
    fs.writeFileSync(approval, JSON.stringify(a));
    fs.writeFileSync(preload, "import fs from 'node:fs'; import path from 'node:path'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';\nconst target = " + JSON.stringify(path.resolve(indexFile).toLowerCase()) + "; const gate = " + JSON.stringify(transactionFile) + "; const proof = " + JSON.stringify(gateProof) + "; const originalSpawn = cp.spawnSync; cp.spawnSync = function(exe,args,options) { if (args[0] === 'commit') { const record = JSON.parse(fs.readFileSync(gate,'utf8')); fs.writeFileSync(proof,JSON.stringify(record)); } return originalSpawn.apply(this,arguments); }; syncBuiltinESMExports();\nconst rename=fs.renameSync; fs.renameSync=function(from,to) { const dest=path.resolve(to); if(dest.toLowerCase()===target || /^recovery-.*\\.json$/.test(path.basename(dest))) throw Object.assign(new Error('fixture index and recovery publication EPERM'),{code:'EPERM'}); return rename.apply(this,arguments); };\n");
    const extra = { NODE_OPTIONS: '--import=' + pathToFileURL(preload).href }; let details;
    if (mode === 'cli') {
      const p = spawnSync(process.execPath, [path.join(folder, 'guard.mjs'), 'commit', '--approval', approval], { cwd: folder, env: { ...process.env, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 45000 });
      assert.equal(p.status, 2, p.stderr || p.stdout); details = JSON.parse(p.stdout); assert.equal(details.recoveryWritten, false); assert.equal(fs.existsSync(details.recoveryFile), false);
    } else {
      details = JSON.parse(run(folder, 'pwsh', ['-NoProfile', '-STA', '-File', path.join(folder, 'window.ps1'), '-Approval', approval, '-SelfTest', 'confirm', '-SelfTestDetails', '-NodeExe', process.execPath], extra));
      assert.equal(details.outcome, 'committed-index-pending'); assert.match(details.status, /恢复记录未落盘，持久事务门禁保持/);
      assert.ok(details.status.includes(transactionFile)); assert.equal(details.confirmEnabled, false); assert.equal(details.handleCreated, true);
    }
    const head = git(r, 'rev-parse', 'HEAD'), pending = JSON.parse(fs.readFileSync(transactionFile, 'utf8')), beforeCommit = JSON.parse(fs.readFileSync(gateProof, 'utf8'));
    assert.equal(beforeCommit.status, 'prepared'); assert.equal(beforeCommit.previousHead, a.head); assert.deepEqual(beforeCommit.paths, ['a.txt']);
    assert.equal(pending.commit, head); assert.equal(pending.status, 'committed-index-pending'); assert.notEqual(head, a.head); assert.deepEqual(fs.readFileSync(indexFile), index);
    write(r, 'c.txt', 'new approval must block'); const fresh = createApproval(r, ['c.txt'], 'new id blocked'); assert.notEqual(fresh.id, a.id);
    const alias = process.platform === 'win32' ? r.toUpperCase() : r;
    assert.throws(() => validate(fresh), /事务尚未完成/); assert.throws(() => commit({ ...fresh, repo: alias }), /事务尚未完成/);
    assert.equal(busy(r), true); assert.equal(busy(alias), true); assert.equal(git(r, 'rev-list', '--count', 'HEAD'), '2');
    const inspection = JSON.parse(run(folder, process.execPath, [path.join(folder, 'guard.mjs'), 'recovery', '--repo', alias]));
    assert.equal(inspection.record, null); assert.equal(inspection.transactionFile, transactionFile); assert.equal(inspection.transaction.commit, head);
    assert.equal(fs.existsSync(pending.nextIndex), true); assert.equal(run(r, 'git', ['show', ':b.txt'], { GIT_INDEX_FILE: pending.nextIndex }), 'other staged');
    if (mode === 'gui') assert.ok(details.status.includes(head));
    record('persistent-transaction-gate-' + mode, { repo: r, commit: head, transactionFile, gateProof, recoveryWritten: false, freshIdRejected: fresh.id, aliasBlocked: true, indexUnchanged: true, gui: mode === 'gui' ? details : undefined });
  }
});
test('安装 settings 明确无限执行时长，Mock 不访问任务计划服务', () => {
  const installer = path.join(folder, 'install-task.ps1').replaceAll("'", "''");
  const script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $global:gitGuardFixtureSettings=$null; function New-ScheduledTaskAction { param($Execute,$Argument) @{Execute=$Execute;Argument=$Argument} }; function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User) @{} }; function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) @{} }; function New-ScheduledTaskSettingsSet { param($MultipleInstances,[TimeSpan]$ExecutionTimeLimit) $global:gitGuardFixtureSettings=@{multipleInstances=$MultipleInstances;executionTimeLimitTicks=$ExecutionTimeLimit.Ticks}; @{} }; function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,$Description) }; & '" + installer + "'; $global:gitGuardFixtureSettings | ConvertTo-Json -Compress";
  const result = JSON.parse(run(folder, 'pwsh', ['-NoProfile', '-Command', script]));
  assert.equal(result.executionTimeLimitTicks, 0); assert.equal(result.multipleInstances, 'IgnoreNew');
  record('unlimited-task-duration', { ...result, mockedOnly: true });
});
console.log(`隔离夹具：${base}`);

test('自启动开关：写配置、调宿主、浏览器模式如实说不支持', async () => {
  const { startPanel } = await import('./panel.mjs');
  const dir = fs.mkdtempSync(path.join(base, 'panel-'));
  const calls = [];
  const panel = await startPanel({
    port: 0, dataDir: dir, autoStartMonitor: false,
    setAutoStart: async (on) => { calls.push(on); return { openAtLogin: on }; }
  });
  try {
    const status = await (await fetch(panel.url + 'api/status')).json();
    assert.equal(status.autoStartSupported, true);
    assert.deepEqual(calls, [false], '启动时按配置对齐一次（默认关闭）');
    const post = (body) => fetch(panel.url + 'api/autostart', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const on = await (await post({ enabled: true })).json();
    assert.equal(on.ok, true); assert.equal(on.openAtLogin, true);
    assert.deepEqual(calls, [false, true]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).autoStart, true, '配置要落盘');
    const bad = await post({ enabled: 'yes' });
    assert.equal(bad.status, 400, '非布尔值要拦住');
  } finally { panel.stop(); }

  // 浏览器模式：没有宿主钩子，必须如实回 supported:false，不能假装成功
  const plain = await startPanel({ port: 0, dataDir: fs.mkdtempSync(path.join(base, 'panel-')), autoStartMonitor: false });
  try {
    const status = await (await fetch(plain.url + 'api/status')).json();
    assert.equal(status.autoStartSupported, false);
    const r = await (await fetch(plain.url + 'api/autostart', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true })
    })).json();
    assert.equal(r.supported, false);
    assert.ok(r.note && r.note.indexOf('浏览器') >= 0);
  } finally { plain.stop(); }
});

test('自动提交通知只对新的 notify 提交触发一次', async () => {
  // 测试在 工具/git-guard/，通知模块在 electron/，跨两层
  const notifyUrl = pathToFileURL(path.join(folder, '..', '..', 'electron', 'notify.mjs')).href;
  const { watchAutoCommits } = await import(notifyUrl);
  const file = path.join(fs.mkdtempSync(path.join(base, 'notify-')), 'auto-commits.jsonl');
  fs.writeFileSync(file, JSON.stringify({ time: 't0', mode: 'notify', commit: 'old', count: 1 }) + '\n');
  const got = [];
  const w = watchAutoCommits({ file: file, intervalMs: 30, onCommit: (e) => got.push(e.commit) });
  try {
    w.poll();
    assert.deepEqual(got, [], '启动前的历史提交不该弹通知');
    fs.appendFileSync(file, JSON.stringify({ time: 't1', mode: 'notify', commit: 'aaa', count: 2, repo: 'D:/x/proj' }) + '\n');
    w.poll();
    assert.deepEqual(got, ['aaa']);
    w.poll();
    assert.deepEqual(got, ['aaa'], '同一条记录不该重复通知');
    fs.appendFileSync(file, JSON.stringify({ time: 't2', mode: 'silent', commit: 'bbb' }) + '\n');
    fs.appendFileSync(file, JSON.stringify({ time: 't3', mode: 'notify', error: 'boom' }) + '\n');
    w.poll();
    assert.deepEqual(got, ['aaa'], '静默模式与失败记录都不通知');
    fs.appendFileSync(file, JSON.stringify({ time: 't4', mode: 'notify', commit: 'ccc' }) + '\n');
    w.poll();
    assert.deepEqual(got, ['aaa', 'ccc']);
  } finally { w.stop(); }
});
