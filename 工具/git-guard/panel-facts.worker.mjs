// 工作线程：把同步 git 计算搬离 HTTP 线程，主线程只读缓存。
import { parentPort } from 'node:worker_threads';
import { projectRows, branchList } from './panel-facts.mjs';

parentPort.on('message', function (msg) {
  try {
    const data = msg.kind === 'branches' ? branchList(msg.config) : projectRows(msg.config);
    parentPort.postMessage({ id: msg.id, data: data });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: (e && e.message) || String(e) });
  }
});