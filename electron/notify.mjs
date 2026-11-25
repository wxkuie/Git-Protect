import fs from 'node:fs';

// 盯住提交记录文件，把「自动提交并通知」模式下的新提交交给上层弹系统通知。
// 放在主进程做而不是页面里：窗口收进托盘后渲染进程会被节流，靠页面轮询会漏或延迟；
// 页面里那条新通知还有一个硬伤——没有 AppUserModelId 时 Windows 根本不显示。
export function watchAutoCommits(options) {
  const file = options.file;
  const onCommit = options.onCommit;
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 2000;
  const seen = new Set();
  let order = [];
  let timer = null;
  let stopped = false;

  function readLines() {
    try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); }
    catch (e) { return []; }
  }
  function keyOf(entry) { return String(entry.time || '') + '|' + String(entry.commit || ''); }
  function remember(key) {
    seen.add(key); order.push(key);
    // 记录文件会滚动，旧键留着只会慢慢涨内存
    if (order.length > 1000) { const drop = order.splice(0, order.length - 1000); for (const k of drop) seen.delete(k); }
  }

  // 启动时先记住已有内容：历史提交不该在程序启动瞬间再弹一遍
  for (const line of readLines()) {
    try { remember(keyOf(JSON.parse(line))); } catch (e) {}
  }

  function poll() {
    if (stopped) return;
    for (const line of readLines()) {
      let entry;
      try { entry = JSON.parse(line); } catch (e) { continue; }
      const key = keyOf(entry);
      if (seen.has(key)) continue;
      remember(key);
      // 失败和跳过的记录不是「提交成功」，不该弹「已自动提交」
      if (!entry.commit) continue;
      // 静默模式本来就不打扰人；提醒模式下提交走的是弹窗确认，也不该再通知一次
      if (entry.mode !== 'notify') continue;
      try { onCommit(entry); } catch (e) {}
    }
  }

  timer = setInterval(poll, intervalMs);
  if (timer.unref) timer.unref();
  return {
    poll: poll,
    stop: function () { stopped = true; if (timer) clearInterval(timer); timer = null; }
  };
}