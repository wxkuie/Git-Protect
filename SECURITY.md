# 安全说明

这个工具会直接在你的仓库里执行 Git 操作，所以把它的行为边界写清楚。

## 它会做什么

- 读取仓库状态（`git status`、`git diff`、`git rev-parse` 等只读命令）
- 在你确认后（或自动模式下按你的设置）执行**一次**提交：用临时索引精确锁定你看到的那些文件，提交后原子地换回索引
- 「弹窗提醒」模式下启动一个 PowerShell 7 窗口，用来显示待提交清单
- 缺依赖时，只有你点了「下载安装包」才会联网，去 GitHub 或 npmmirror 取安装器

## 它不会做什么

- 不改写历史、不 `push`、不 `reset`、不切分支、不删除分支
- 不跳过 `pre-commit` 等钩子（钩子失败就阻断，并如实告诉你）
- 不替你 `git init`、不猜 `.gitignore`
- 不上传任何数据、不统计、不需要账号

## 配置与数据在哪

`%APPDATA%\git-quiet-helper\`（配置 `config.json`、提交记录 `state/auto-commits.jsonl`）。安装目录只读，不写盘。卸载时会问要不要一并删除。

## 已知的信任前提

- 程序没有代码签名，第一次运行 SmartScreen 会拦一下；请只从本仓库的 Releases 下载
- 从源码构建时，依赖 `electron` 与 `@electron/packager`（见 `package-lock.json`）

## 报告问题

发现安全问题请开 Issue。如果涉及敏感细节，先开 Issue 说「有安全问题，需要私下沟通」，不要贴利用代码。
