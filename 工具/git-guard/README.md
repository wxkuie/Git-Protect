# 内核与命令行

这里是 `guard.mjs` 内核的行为说明和命令行接口，供想改代码或绕过界面直接用的人参考。日常使用不需要看这一页，直接开桌面窗口就行。

适用 Windows、Node.js 20+、Git for Windows、PowerShell 7。纯本机运行，无 npm 依赖，无自动 push。正常使用：逐仓库连续静默后显示中文原生窗口，核对仓库、分支、文件清单和提交说明；点“确认并提交”即执行这一版本的一次本地提交，无第二次确认。“不提交”及关闭窗口不改变 Git 状态。

## 启用边界

本目录只交付程序和安装脚本，不替你安装计划任务、也不替你提交任何项目。首次启用前，请为每个真实仓库确认忽略规则和是否有未收尾的操作。

默认运行状态位于本目录 `.state/`，可用绝对路径环境变量 `GIT_GUARD_STATE` 改到独立本机目录。建议把 `工具/git-guard/.state/` 加进忽略规则（仓库 `.gitignore`，或只在本机生效的 `.git/info/exclude`）。程序自身也排除该路径和任意 `.state/`，避免状态、授权、冷却和临时索引造成递归提醒；它不代改忽略文件。

不传 `--root` 时扫描当前目录下的工作树根，识别 `.git` 目录和 worktree 的 `.git` 文件，不追随目录链接。无仓库、检查失败、未有首提交分别报告；不能把失败当干净。排除目录段：`.git`、`node_modules`、`vendor`、`dist`、`build`、`out`、`.next`、`.tmp`、`.state`、`coverage`、`.cache`、`backup`、`backups`、`备份`，以及 `backup-*`、`backup_*`、`*_backup`、`*-backup` 和以“备份”开头的目录段。这些排除同样作用于提交候选，不能拿本工具提交被排除路径。

父仓库中未跟踪、具有有效 `.git` 目录或文件且没有父索引条目的嵌套工作树，列入 `nestedWorktrees`，不作为父仓库提交候选；扫描仍深入该目录，将其独立列为仓库。不会整体排除 `skills/`，普通文件继续展示；已跟踪 gitlink 子模块仍按 v1 阻断。

## 命令

以下命令从项目根执行，仓库和文件数组示例必须替换为已核对的真实范围。

```powershell
# 只读扫描、单轮检查；均不写仓库或创建后台进程
node 工具/git-guard/guard.mjs scan --root C:/code
node 工具/git-guard/guard.mjs once --root C:/code

# 只读指纹和候选；不读取文件正文到日志
node 工具/git-guard/guard.mjs snapshot --repo C:/code/alpha

# 所有已接入写入者必须在动手前成功 begin，在真正停写后 end
node 工具/git-guard/guard.mjs begin --repo C:/code/alpha --token task-unique-token
node 工具/git-guard/guard.mjs end --repo C:/code/alpha --token task-unique-token

# 精确文件范围的非交互接口。scope.json 内容为相对仓库根的文件路径数组，禁止目录通配。
# 例：["工具/git-guard/guard.mjs", "工具/git-guard/README.md"]
node 工具/git-guard/guard.mjs prepare --repo C:/code/alpha --paths scope.json --message "完善本机提交提醒"
# prepare 只生成授权文件，返回 approvalFile、版本、阻断原因及路径清单。
# 验收并确认这一范围就是提交授权；下一步直接提交，不再二次确认。
node 工具/git-guard/guard.mjs validate --approval '<prepare 返回的 approvalFile>'
node 工具/git-guard/guard.mjs commit --approval '<prepare 返回的 approvalFile>'

# 只读查看提交收尾异常的恢复记录和索引候选，不自动替换索引或回退提交
node 工具/git-guard/guard.mjs recovery --repo C:/code/alpha
# 提交做到一半中断后留下的门禁：先诊断，确认能证明提交已落地再加 --clear
node 工具/git-guard/guard.mjs recover --repo C:/code/alpha
node 工具/git-guard/guard.mjs recover --repo C:/code/alpha --clear

# 前台启动监测；安装脚本使用隐藏启动器
node 工具/git-guard/guard.mjs monitor --config 工具/git-guard/config.example.json
```

`prepare` 必须给非空、去重的精确文件数组；不存在、未改动、被排除的路径及目录不会获准。`commit` 退出码 0 表示提交及索引发布成功，输出 `commit` 提交号，同时保存 `.state/result-*.json` 和尝试记录；退出码 1 为普通阻断或失败；退出码 2 明确表示提交已生成但收尾待核对，输出 JSON 中的 `commit`、`status`、`recoveryFile`、`recoveryWritten`、`transactionFile`、`indexCandidate`，不能当作“没有提交”直接重试。授权文件包含版本和一次性 ID；同一授权已开始执行后不复用，失败后须先通过 `recovery --repo` 检查是否留有未完成事务门禁，再核对并生成授权。不要编辑旧授权文件。弹窗额外校验展示时授权文件的 SHA-256。

`begin/end` 不靠进程心跳超时清除，失联标记保持未知/运行中，持续抑制提醒。只有确认写入已结束后原调用者才能 `end`；对未接入本接口的编辑器或 Agent，静默不能证明任务结束。协调锁存在时 `begin` 会失败，调用者必须先等工具结束，不能忽略失败继续写入。

Windows 仓库身份先解析物理路径，再统一大小写；snapshot、运行标记、busy、协调锁、事务门禁、尝试、结果、恢复和冷却使用同一身份。对大小写别名执行 begin、对原路径确认仍会阻断；反向 end 也使用同一标记。升级后首次启动前，请先结束旧的监视进程，并核对是否留有运行标记。

## 静默和窗口

默认连续静默 600 秒；配置 `idleSeconds: 300` 可改为 5 分钟。

提交模式（`mode`）是全局的：`remind` 弹窗确认、`notify` 直接提交并通知、`silent` 直接提交只记日志。模式与停手时长都只从配置顶层读，项目里的同名残留字段有意忽略。提交说明不再可配：每次生成 `${月}月${日}日${时}:${分}：自动提交（N 个文件）`，需要自定义就在提交后 amend。

分支是项目级设置：项目的 `branch: "main"` 表示只在该分支处理，当前分支不符的仓库直接跳过、不弹窗；留空则跟随该仓库当前分支。没有全局默认分支。本工具不切换工作树分支。

自动提交的通知由主进程监视 `state/auto-commits.jsonl` 后发 Windows 通知（`electron/notify.mjs`，纯 Node、可单测）：只对 `mode: "notify"` 且带 `commit` 的新记录触发，启动时把已有内容当历史；页面里不再发通知，避免重复。

打包签名：`scripts/package.mjs` 在产物生成后调用 `scripts/sign.ps1`，用 `GQH_SIGN_PFX`+`GQH_SIGN_PASSWORD` 或 `GQH_SIGN_THUMBPRINT` 指定证书；未配置时打印 `SIGN_SKIPPED` 并继续，不静默假装签过。签名用系统自带 `Set-AuthenticodeSignature`，不依赖 signtool。

面板的状态行（`panel-facts.mjs` 的 `projectRows`）与分支列表（`branchList`）跑在 worker thread 里：同步 git 放在 HTTP 线程会冻结整个面板（实测单次重算 5 秒，同期请求全部排队）。主线程只读缓存，集合变化时才等新结果。

主进程调试：`GIT_GUARD_DEBUG_MAIN=1` 启动桌面外壳会让主进程打印窗口事件（ready-to-show/shown/close/closed/hide/blur/minimize/render-process-gone/did-fail-load），排查「窗口怎么没了」用；不设则完全静默。

`panel.mjs` 支持被宿主内嵌：`startPanel({ port: 0, dataDir, autoStartMonitor, pickFolder, setAutoStart })` 返回 `{ url, port, stop }`；`setAutoStart(enabled)` 是宿主注入的开机自启动作（Electron 用 `app.setLoginItemSettings` 写 HKCU 的 Run 项），注入后界面才能开关，启动时还会按配置对齐一次；没有注入时 `POST /api/autostart` 返回 `supported:false`，界面禁用该项而不是假装成功。`pickFolder` 是宿主注入的选目录函数，注入后界面才能弹原生对话框，没有则退回手填路径，只在被当作脚本直接运行时才自启服务。传入 `dataDir` 后配置与状态改放该目录（打包版用 `%APPDATA%`，默认仍是本目录）；`autoStartMonitor` 仅在已配置启用项目时才真正启动监视。监视子进程的状态目录通过 `GIT_GUARD_STATE` 传给 `guard.mjs`。监视只处理 `projects` 里显式列出的仓库，`projects` 为空则什么都不做——没有「扫描根目录」这种回退，避免第一次运行就对整台机器的仓库弹窗。面板通过 `GET /api/branches` 取各项目的本地分支供下拉选择。每项只有三个字段：`path`、`enabled`、`branch`（留空跟随当前分支）。`mode` 只认配置顶层，取值 `remind`/`notify`/`silent`，其他值启动时直接报错。自动模式不经过人工确认，因此完全依赖 `validate` 的门禁：版本变化、不支持的状态、未结束的运行标记、事务门禁、未配提交身份、游离 HEAD 都会被挡住而不提交；单次改动超过 `AUTO_MAX_FILES`（500）时自动降级为弹窗确认。每次自动提交或失败都会追加一行到状态目录的 `auto-commits.jsonl`（超过 256KB 时保留最近 200 条）。使用递归事件监听，并默认每 30 秒重算 Git 状态、HEAD、索引字节和候选文件内容 SHA-256。同一路径保持 `M/??` 但内容继续变化也会重计。首次启动、重启、监听失败、扫描失败、仓库消失后重新发现均重计，不推测启动前已静默。运行标记结束会唤起即时检查，仍须满足原静默阈值。

弹窗上有两种拒绝，窗口用退出码把意图交给监视进程：`3` = 本次不提交，`4` = 一段时间不打扰，其余按「没有拒绝意图」处理。

- **本次不提交（3）**：该仓库该版本写入 `skip-<repoKey>.json`，同一个版本不再问；文件内容一变（版本变）自然重新询问。
- **一段时间不打扰（4）**：写 `snooze-<repoKey>.json`，在 `cooldownSeconds`（默认 2 小时）内该仓库**完全不处理**——不弹窗，自动模式也不提交；到点自动恢复。
- **直接关窗或提交失败**：保守路径，该版本写入 `cooldown-<repoKey>.json` 冷却一段时间，避免立刻又弹。

以上记录都在状态目录，重启后仍有效。窗口显示期间观察到相关事件会撤销旧授权；界面每 3 秒复核，点击时再次复核。窗口非置顶、初次展示不抢焦点。测试用 `GIT_GUARD_SELFTEST=cancel|snooze|confirm` 让弹窗自己按下按钮并以隐藏方式退出，验证时不会在屏幕上闪窗。自检入口只针对隔离夹具：

```powershell
pwsh -NoProfile -STA -File 工具/git-guard/window.ps1 -Approval '<fixture 授权文件>' -SelfTest confirm -NodeExe '<node.exe 绝对路径>'
# 或 -SelfTest cancel；创建透明、不进入任务栏的真实 WinForms，调用实际按钮 PerformClick。
# 可加 -SelfTestDetails 输出实际处理器结果、状态文本、确认按钮状态及窗口句柄创建结果。
```

## 提交保护与已知限制

- 所选文件有部分暂存或冲突时阻断；保留用户原暂存选择。未选择的部分暂存和其他改动保持原样。
- 检出有效 `pre-commit`、`prepare-commit-msg`、`commit-msg`、`post-commit`、`reference-transaction`、`post-rewrite` 时阻断，含 `core.hooksPath`；不禁用、不跳过 hooks。Windows 对存在的同名 hook 保守判定，`.sample` 不算。
- 重命名/复制、分离 HEAD、进行中的 merge/rebase/cherry-pick/revert、子模块、拆分索引、skip-worktree/assume-unchanged、不支持的文件类型等复杂状态明确阻断。可由用户用原有 Git 流程处理，不显示为提交成功。
- 独立临时索引从展示的 HEAD 构建，只对明确路径执行 Git add；不是整仓 `add -A`。实际索引持有 `index.lock`，另一个索引候选保留未选择条目；HEAD 更新前检查原索引可写、探测同目录文件替换，并将候选写入锁文件且 fsync。已知只读或不可发布状态在创建提交前阻断。提交后再替换真实索引。运行标记修改与本工具提交共用协调锁。普通失败不改真实索引、不回退工作树，不强设身份。
- `add` 路径使用 NUL 分隔 stdin 和字面 pathspec；`update-index` 同样走 NUL 分隔 stdin；`ls-files` 不带长路径参数，返回的索引条目按完整文件名精确筛选。路径数量不受 Windows 命令行 32K 长度限制，合法 `[]` 及前导短横文件名不会扩展成未展示文件。
- 调用任何可能创建提交的 Git 操作前，先以排他创建和 fsync 落盘 `.state/transaction-<仓库键>.json`；记录展示前 HEAD、分支、范围、尝试文件和索引候选。成功取得提交号后更新同一记录。只有提交、索引发布及结果保存均正常完成才移除门禁；进入 Git commit 后发生普通失败也保守保留，须人工核对。新审批 ID、重启或大小写别名都不能绕过它。
- 提交前复核整个候选版本、HEAD、分支和原索引；提交后复核树和父提交。其他不遵守本工具协调接口的程序仍能改工作树、配置或引用；本工具不能对任意外部写入提供跨文件系统与 Git 引用的原子事务，也不声称完全消除并发风险。
- 若提交已产生但索引更新异常，GUI 明确显示“提交已生成，索引待恢复”，列出提交号、恢复入口及索引候选，确认按钮保持禁用；结果记录异常另标“提交已生成，结果记录待核对”。保留索引候选、持久事务门禁及可写时的 `recovery-*.json`，阻断后续提交。若 `recoveryWritten=false`，GUI 明示“恢复记录未落盘，持久事务门禁保持”，恢复入口改为已存在的事务文件。用 `recovery --repo` 读取 `record` 和 `transaction`，人工比对提交、现有索引与候选后处理；本轮没有自动恢复索引或解除门禁命令，不自动回退、不删除恢复依据。探测成功后外部权限或设备状态仍可能变化，因此不能把前置探测视为全局原子性保证。断电/强杀可能留下锁、prepared 或 started 记录；须核对 HEAD、分支、尝试与索引，不能盲删锁或门禁重试。

这些临时索引/恢复记录是提交事务所需元数据，不是文件副本或自动快照。提醒及提交保护与未来快照候选分开；本轮没有实现工作文件自动快照、恢复、清理、远程推送或外部服务。

## 计划任务（可选）

计划任务不是必需的：桌面外壳自己会在托盘常驻，`install-task.ps1` 只是给「不装桌面外壳、只跑内核」准备的。安装入口强检查 PowerShell Core 7 或更新宿主；不合格时在任务注册前报错。脚本解析当前 Node、Git 和 `$PSHOME/pwsh.exe` 绝对路径，保存到任务动作，交给 `launch.ps1` 和弹窗子进程使用；不依赖登录任务的 PATH。配置文件也使用绝对路径。任务以当前用户交互登录、普通权限运行，隐藏启动、同任务不并行，显式设置 `ExecutionTimeLimit = TimeSpan.Zero` 以持续监控。默认名称 `LocalGitQuietReminder`；存在同名任务时注册报错，不静默覆盖。安装不会立即启动任务，需要你自己启动它。`disable-task.ps1` 停用并停止这个明确名称的任务，不搜索或终止其他用户进程。

```powershell
pwsh -NoProfile -File 工具/git-guard/install-task.ps1 -Config C:/code/alpha/工具/git-guard/config.example.json
pwsh -NoProfile -File 工具/git-guard/disable-task.ps1
```

## 验证

```powershell
node --test --test-reporter=spec 工具/git-guard/test.mjs
```

测试只在 `.tmp/git-guard-*` 下创建、暂存及提交隔离仓库，保留夹具供复核；其中包含真实隐藏窗口的按钮自检（窗口建在屏幕外，不会闪）。计划任务安装、登录环境、可见窗口体验这类依赖真实桌面环境的部分不在自动化测试范围内，需要自己手动过一遍。


从项目根使用 npm test 会自动创建隔离夹具目录并固定测试工作目录；直接使用本页原测试命令前须先创建 .tmp。
