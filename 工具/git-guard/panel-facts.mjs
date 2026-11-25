// 面板里最重的两块计算：项目状态行、分支列表。
// 单独成一个模块，是为了让它们能在工作线程里跑——同步 git 留在 HTTP 线程里会把整个面板卡住
// （实测一次重算 1.2 秒起步，叠加界面轮询时单次请求要等 5 秒）。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { snapshot, busy, recoveryReport } from './guard.mjs';

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
export function projectRows(config) {
  const rows = [];
  for (const p of config.projects) {
    const required = p.branch || '';
    const row = {
      path: p.path, enabled: p.enabled, branch: p.branch,
      // 模式/停手都是全局的；这里回报生效值，方便外部查看，但不参与项目配置
      idleSeconds: config.idleSeconds, mode: config.mode, reachable: false, currentBranch: '',
      changes: 0, branchOk: true, requiredBranch: required, error: '', busy: null, identityOk: true,
      gate: null
    };
    if (!fs.existsSync(p.path)) { row.error = '路径不存在'; rows.push(row); continue; }
    try {
      const view = snapshot(p.path);
      row.reachable = true;
      row.currentBranch = view.branch;
      row.changes = view.changes.length;
      row.branchOk = !required || view.branch === required;
      row.busy = safeBusy(p.path);
      row.identityOk = !!gitOut(p.path, ['var', 'GIT_AUTHOR_IDENT']).trim();
    } catch (e) { row.error = e.message; }
    // 提交收尾没做完会留下事务门禁，validate 会一直挡住；这里单独标出来，让界面能提供处理入口
    try { const report = recoveryReport(p.path); if (report.transaction) row.gate = { canClear: report.canClear, reason: report.reason }; }
    catch (e) {}
    rows.push(row);
  }
  return rows;
}