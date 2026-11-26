// 工作线程：把同步 git 计算搬离 HTTP 线程，主线程只读缓存。
import { parentPort } from 'node:worker_threads';
import { useStateDir } from './guard.mjs';
import { projectRows, branchList } from './panel-facts.mjs';

parentPort.on('message', function (msg) {
  try {
    // 状态目录随任务下发：线程模块实例是独立的，不能只靠启动时的环境变量。
    if (msg.stateDir) useStateDir(msg.stateDir);
    const data = msg.kind === 'branches' ? branchList(msg.config) : projectRows(msg.config);
    parentPort.postMessage({ id: msg.id, data: data });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: (e && e.message) || String(e) });
  }
});