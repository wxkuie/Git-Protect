// 面板里最重的两块计算：项目状态行、分支列表。
// 单独成一个模块，是为了让它们能在工作线程里跑——同步 git 留在 HTTP 线程里会把整个面板卡住
// （实测一次重算 1.2 秒起步，叠加界面轮询时单次请求要等 5 秒）。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { snapshot, busy, recoveryReport, stateBlockers, lastTouched } from './guard.mjs';

function safeBusy(repo) { try { return busy(repo); } catch (e) { return null; } }

function gitOut(repo, args) {
  const out = spawnSync('git', ['-C', repo].concat(args), { encoding: 'utf8', windowsHide: true });
  return out.status === 0 ? String(out.stdout || '') : '';
}

// 刚 git init、还没有任何提交的仓库，rev-parse --abbrev-ref HEAD 会失败；
// symbolic-ref 能读符号引用，对未出生的分支同样有效。
export function currentBranchOf(dir) {
  return gitOut(dir, ['symbolic-ref', '--short', 'HEAD']).trim()
    || gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

// 列出本地分支：界面用它做下拉，避免让用户手打分支名。
export function branchList(config) {
  const items = [];
  for (const p of config.projects) {
    const row = { path: p.path, current: '', branches: [], error: '' };
    if (!fs.existsSync(p.path)) { row.error = '路径不存在'; items.push(row); continue; }
    try {
      row.current = currentBranchOf(p.path);
      row.branches = gitOut(p.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
        .split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!row.branches.length) row.error = '没有本地分支';
    } catch (e) { row.error = e.message; }
    items.push(row);
  }
  return { items: items };
}

// 每个项目算一次状态要拉起好几个 git 进程，单项目约 1.2 秒。
// 顺带把「现在为什么没提醒」算好：项目页和活动页都直接用它，
// 用户不用再去猜「明明有改动，为什么没弹窗」。
export function projectRows(config) {
  const rows = [];
  for (const p of config.projects) {
    const required = p.branch || '';
    const row = {
      path: p.path, enabled: p.enabled, branch: p.branch,
      // 模式/停手都是全局的；这里回报生效值，方便外部查看，但不参与项目配置
      idleSeconds: config.idleSeconds, mode: config.mode, reachable: false, currentBranch: '',
      changes: 0, branchOk: true, requiredBranch: required, error: '', busy: null, identityOk: true,
      gate: null, blockers: [], version: '', reasons: [], idleRemainingMs: null
    };
    const add = function (item) { row.blockers.push(item); };
    if (!p.enabled) add({ kind: 'disabled', short: '已停用', text: '这个项目已停用，不会提醒也不会自动提交' });
    if (!fs.existsSync(p.path)) {
      row.error = '路径不存在';
      add({ kind: 'error', short: '路径不存在', text: '路径不存在：检查盘符是否挂上、目录是否被改名' });
      rows.push(row); continue;
    }
    try {
      const view = snapshot(p.path);
      row.reachable = true;
      row.currentBranch = view.branch;
      row.changes = view.changes.length;
      row.version = view.version;
      row.reasons = view.reasons || [];
      row.branchOk = !required || view.branch === required;
      row.busy = safeBusy(p.path);
      row.identityOk = !!gitOut(p.path, ['var', 'GIT_AUTHOR_IDENT']).trim();
      for (const item of stateBlockers(p.path, view, { cooldownSeconds: config.cooldownSeconds })) add(item);
      if (!row.identityOk) add({ kind: 'identity', short: '未配 git 身份', text: 'Git 还没配置用户名和邮箱，提交会失败' });
      if (!row.branchOk) add({ kind: 'branch', short: '分支不符', text: '当前分支是 ' + (view.branch || '未知') + '，项目设置要求 ' + required + '，不会处理' });
      for (const reason of row.reasons) add({ kind: 'reason', short: reason, text: reason });
      if (view.changes.length) {
        const touched = lastTouched(p.path, view.changes);
        const idleMs = (Number(config.idleSeconds) || 600) * 1000;
        row.idleRemainingMs = Math.max(0, touched + idleMs - Date.now());
        if (!row.blockers.length) {
          if (row.idleRemainingMs > 0) add({ kind: 'waiting', short: '等停手', text: '改动还在停手计时里，约 ' + Math.ceil(row.idleRemainingMs / 60000) + ' 分钟后才够提醒条件' });
          else add({ kind: 'ready', short: '可提醒', text: '满足提醒条件，监视器下一轮（约 ' + (Number(config.pollSeconds) || 30) + ' 秒内）会提醒' });
        }
      } else {
        add({ kind: 'clean', short: '没有改动', text: '工作区是干净的，没有需要提交的内容' });
      }
    } catch (e) {
      row.error = e.message;
      add({ kind: 'error', short: '读取失败', text: e.message });
    }
    // 提交收尾没做完会留下事务门禁，validate 会一直挡住；这里单独标出来，让界面能提供处理入口
    try { const report = recoveryReport(p.path); if (report.transaction) row.gate = { canClear: report.canClear, reason: report.reason }; }
    catch (e) {}
    rows.push(row);
  }
  return rows;
}