param(
    [Parameter(Mandatory)][string]$Approval,
    [ValidateSet('', 'confirm', 'cancel', 'snooze')][string]$SelfTest = '',
    [string]$NodeExe = 'node',
    [switch]$SelfTestDetails,
    [switch]$SelfTestExit,
    [switch]$SelfTestTimer,
    [string]$SelfTestShot = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$NodeExe = (Get-Command $NodeExe -ErrorAction Stop).Source

# 退出码约定（监视进程靠它区分拒绝意图）：0 无拒绝意图、3 本次不提交、4 一段时间不打扰
function Get-ExitCode([string]$outcome) {
    if ($outcome -eq 'skipped') { return 3 }
    if ($outcome -eq 'snoozed') { return 4 }
    return 0
}

$data = Get-Content -LiteralPath $Approval -Raw -Encoding UTF8 | ConvertFrom-Json
$approvalHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($Approval))).ToLowerInvariant()
$guardScript = Join-Path $PSScriptRoot 'guard.mjs'
$nl = [string][char]13 + [char]10

# 调用内核一律走后台进程：node 启动 150ms、git 若干次，同步跑会把界面冻住。
# 界面线程只轮询 HasExited（几乎零成本），结果回来再更新控件。
function Quote-Arg([string]$s) {
    if ($s -match '[\s"]') { return '"' + ($s -replace '"', '\"') + '"' }
    return $s
}
function Start-GuardJob([string[]]$argv, [string]$kind) {
    $out = [IO.Path]::GetTempFileName()
    $err = [IO.Path]::GetTempFileName()
    $line = (Quote-Arg $guardScript) + ' ' + (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')
    $p = Start-Process -FilePath $NodeExe -ArgumentList $line -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $script:job = @{ proc = $p; out = $out; err = $err; kind = $kind }
}
function Read-JobText($job) {
    $text = ''
    try { $text = [IO.File]::ReadAllText($job.out, [Text.Encoding]::UTF8) } catch { }
    try { if (-not $text) { $text = [IO.File]::ReadAllText($job.err, [Text.Encoding]::UTF8) } } catch { }
    return $text
}
function Clear-JobFiles($job) {
    foreach ($f in @($job.out, $job.err)) { try { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } catch { } }
}

if ($SelfTestTimer) {
    # 只做复查、不显示窗口：用来确认「弹窗后几秒就失效」到底卡在哪。
    # 这条路径没有界面，同步调用即可。
    $raw = & $NodeExe $guardScript validate --approval $Approval --expected-sha $approvalHash 2>&1 | Out-String
    $first = if ($LASTEXITCODE -eq 0) { @{ ok = $true; text = '' } } else { @{ ok = $false; text = $raw.Trim() } }
    $out = @{ ok = $first.ok; text = $first.text; nodeExe = $NodeExe; guard = $guardScript; approval = $Approval }
    [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
    exit ([int](-not $first.ok))
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @([System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Point].Assembly.Location, [System.ComponentModel.Component].Assembly.Location, [System.Runtime.GCSettings].Assembly.Location) -TypeDefinition @'
using System.Windows.Forms;
public class QuietGitGuardForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000; return p; } }
}
'@

# ---- 配色 ----
$script:cBg      = [System.Drawing.ColorTranslator]::FromHtml('#F5F6F8')
$script:cCard    = [System.Drawing.Color]::White
$script:cLine    = [System.Drawing.ColorTranslator]::FromHtml('#E3E6EA')
$script:cText    = [System.Drawing.ColorTranslator]::FromHtml('#1F2328')
$script:cMuted   = [System.Drawing.ColorTranslator]::FromHtml('#6B7280')
$script:cAccent  = [System.Drawing.ColorTranslator]::FromHtml('#2563EB')
$script:cAccent2 = [System.Drawing.ColorTranslator]::FromHtml('#1D4ED8')
$script:cDanger  = [System.Drawing.ColorTranslator]::FromHtml('#B91C1C')
$script:cOk      = [System.Drawing.ColorTranslator]::FromHtml('#15803D')
$script:cWarn    = [System.Drawing.ColorTranslator]::FromHtml('#B45309')
$script:cDim     = [System.Drawing.ColorTranslator]::FromHtml('#C7CDD6')
$script:uiFont   = 'Microsoft YaHei UI'

$filePaths = @($data.changes | Where-Object { $_.path -in $data.paths } | ForEach-Object { $_.path })
$fileCount = $filePaths.Count
$hasBlock  = ($data.reasons.Count -gt 0)

$form = [QuietGitGuardForm]::new()
$form.Text = '本地提交提醒'
$form.ClientSize = [System.Drawing.Size]::new(760, 648)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.BackColor = $script:cBg
$form.TopMost = $false
$form.Font = [System.Drawing.Font]::new($script:uiFont, 9.5)
$form.ShowInTaskbar = $true

# ---- 顶部：标题、仓库、分支 ----
$head = [System.Windows.Forms.Panel]::new()
$head.SetBounds(0, 0, 760, 116)
$head.BackColor = $script:cCard
$form.Controls.Add($head)
$head.Add_Paint({
    param($s, $e)
    $pen = [System.Drawing.Pen]::new($script:cLine, 1)
    $e.Graphics.DrawLine($pen, 0, $s.Height - 1, $s.Width, $s.Height - 1)
    $pen.Dispose()
})

$title = [System.Windows.Forms.Label]::new()
$title.Text = '有改动等待提交'
$title.Font = [System.Drawing.Font]::new($script:uiFont, 15, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = $script:cText
$title.SetBounds(28, 20, 300, 32)
$head.Controls.Add($title)

$badge = [System.Windows.Forms.Label]::new()
$badge.Text = if ($hasBlock) { "无法提交" } else { "$fileCount 个文件" }
$badge.Font = [System.Drawing.Font]::new($script:uiFont, 9, [System.Drawing.FontStyle]::Bold)
$badge.ForeColor = if ($hasBlock) { $script:cDanger } else { $script:cAccent }
$badge.BackColor = if ($hasBlock) { [System.Drawing.ColorTranslator]::FromHtml('#FEE2E2') } else { [System.Drawing.ColorTranslator]::FromHtml('#E8EFFD') }
$badge.TextAlign = 'MiddleCenter'
$badge.SetBounds(336, 24, 104, 24)
$head.Controls.Add($badge)

$where = [System.Windows.Forms.Label]::new()
$where.Text = $data.repo
$where.Font = [System.Drawing.Font]::new('Consolas', 9)
$where.ForeColor = $script:cMuted
$where.SetBounds(28, 60, 704, 20)
$head.Controls.Add($where)

$branchInfo = [System.Windows.Forms.Label]::new()
$branchInfo.Text = "分支 $($data.branch)     $($data.message)"
$branchInfo.Font = [System.Drawing.Font]::new($script:uiFont, 9)
$branchInfo.ForeColor = $script:cMuted
$branchInfo.SetBounds(28, 82, 704, 20)
$head.Controls.Add($branchInfo)

# ---- 文件清单 ----
$card = [System.Windows.Forms.Panel]::new()
$script:card.SetBounds(0, 116, 760, 384)
$card.BackColor = $script:cCard
$form.Controls.Add($card)

$listHead = [System.Windows.Forms.Label]::new()
$listHead.Text = '将要提交的文件'
$listHead.Font = [System.Drawing.Font]::new($script:uiFont, 9, [System.Drawing.FontStyle]::Bold)
$listHead.ForeColor = $script:cText
$listHead.SetBounds(28, 16, 200, 20)
$card.Controls.Add($listHead)

$listNote = [System.Windows.Forms.Label]::new()
$listNote.Text = if ($fileCount -gt 300) { "共 $fileCount 个，下表只列前 300 个" } else { "共 $fileCount 个" }
$listNote.Font = [System.Drawing.Font]::new($script:uiFont, 8.5)
$listNote.ForeColor = $script:cMuted
$listNote.SetBounds(500, 17, 232, 18)
$listNote.TextAlign = 'MiddleRight'
$card.Controls.Add($listNote)

$listBox = [System.Windows.Forms.Panel]::new()
$script:listBox.SetBounds(28, 42, 704, 312)
$listBox.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#FAFBFC')
$listBox.Add_Paint({
    param($s, $e)
    $pen = [System.Drawing.Pen]::new($script:cLine, 1)
    $e.Graphics.DrawRectangle($pen, 0, 0, $s.Width - 1, $s.Height - 1)
    $pen.Dispose()
})
$card.Controls.Add($listBox)
$list = [System.Windows.Forms.TextBox]::new()
$list.Multiline = $true
$list.ReadOnly = $true
$list.ScrollBars = 'Vertical'
$list.BorderStyle = 'None'
$list.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#FAFBFC')
$list.ForeColor = $script:cText
$list.Font = [System.Drawing.Font]::new('Consolas', 9)
$script:list.SetBounds(12, 10, 680, 292)
$shown = if ($fileCount -gt 300) { $filePaths[0..299] } else { $filePaths }
$list.Text = ($shown -join $nl)
$listBox.Controls.Add($list)

# ---- 底部：状态与按钮 ----
$foot = [System.Windows.Forms.Panel]::new()
$script:foot.SetBounds(0, 500, 760, 148)
$foot.BackColor = $script:cBg
$form.Controls.Add($foot)

$status = [System.Windows.Forms.Label]::new()
$status.AutoSize = $false
$script:status.SetBounds(28, 18, 704, 70)
$status.Font = [System.Drawing.Font]::new($script:uiFont, 9)
$status.ForeColor = if ($hasBlock) { $script:cDanger } else { $script:cMuted }
$status.Text = if ($hasBlock) { "无法提交：" + ($data.reasons -join "；") } else { "确认后只提交下列文件，其他改动不受影响。" }
$foot.Controls.Add($status)

# 事件处理器里拿不到脚本局部变量，这里按名字取色，避免传进来是 $null
function Set-Status([string]$text, [string]$tone = 'muted') {
    $map = @{ muted = $script:cMuted; warn = $script:cWarn; ok = $script:cOk; danger = $script:cDanger }
    $status.Text = $text
    $status.ForeColor = $map[$tone]
    $foot.Refresh()
}

$confirm = [System.Windows.Forms.Button]::new()
$confirm.Text = '确认并提交'
$confirm.Font = [System.Drawing.Font]::new($script:uiFont, 9.5, [System.Drawing.FontStyle]::Bold)
$confirm.FlatStyle = 'Flat'
$confirm.FlatAppearance.BorderSize = 0
$confirm.FlatAppearance.MouseOverBackColor = $script:cAccent2
$confirm.BackColor = $script:cAccent
$confirm.ForeColor = [System.Drawing.Color]::White
$confirm.Cursor = 'Hand'
$confirm.UseVisualStyleBackColor = $false
$script:confirm.SetBounds(488, 96, 124, 40)
$confirm.Enabled = -not $hasBlock
if ($hasBlock) { $confirm.BackColor = $script:cDim }
$foot.Controls.Add($confirm)

$cancel = [System.Windows.Forms.Button]::new()
$cancel.Text = '本次不提交'
$cancel.Font = [System.Drawing.Font]::new($script:uiFont, 9.5)
$cancel.FlatStyle = 'Flat'
$cancel.FlatAppearance.BorderSize = 1
$cancel.FlatAppearance.BorderColor = $script:cLine
$cancel.FlatAppearance.MouseOverBackColor = [System.Drawing.ColorTranslator]::FromHtml('#EEF1F5')
$cancel.BackColor = $script:cCard
$cancel.ForeColor = $script:cText
$cancel.Cursor = 'Hand'
$cancel.UseVisualStyleBackColor = $false
$script:cancel.SetBounds(620, 96, 112, 40)
$foot.Controls.Add($cancel)

$snooze = [System.Windows.Forms.Button]::new()
$snooze.Text = if ($data.snoozeText) { $data.snoozeText } else { '两小时内不打扰' }
$snooze.Font = [System.Drawing.Font]::new($script:uiFont, 9.5)
$snooze.FlatStyle = 'Flat'
$snooze.FlatAppearance.BorderSize = 1
$snooze.FlatAppearance.BorderColor = $script:cLine
$snooze.FlatAppearance.MouseOverBackColor = [System.Drawing.ColorTranslator]::FromHtml('#EEF1F5')
$snooze.BackColor = $script:cCard
$snooze.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#4B5563')
$snooze.Cursor = 'Hand'
$snooze.UseVisualStyleBackColor = $false
$script:snooze.SetBounds(28, 96, 200, 40)
$snooze.TextAlign = 'MiddleCenter'
$foot.Controls.Add($snooze)

# ---- 复查：窗口开着时文件被改，就别让人白点一次 ----
$script:outcome = ''
$script:job = $null
$script:retried = $false
$script:noAutoClose = $false
function Write-WindowLog([string]$text) {
    try {
        $log = Join-Path (Split-Path -Parent $Approval) 'window-errors.log'
        $line = '{0}  {1}  {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), (Split-Path -Leaf $Approval), ($text -replace '\s+', ' ')
        [IO.File]::AppendAllText($log, $line + $nl)
    } catch { }
}
# 授权真的作废时才会出现的说法；其它（索引被占、模块找不到）属于「暂时查不了」，不能据此禁用按钮
$invalidPattern = '弹窗后观察到修改|版本已变化|旧确认失效|已变化|旧确认'

# 轮询后台进程：界面线程只判断 HasExited，几乎零成本，不再有卡顿
$poll = [System.Windows.Forms.Timer]::new()
$poll.Interval = 120
$validate = [System.Windows.Forms.Timer]::new()
$validate.Interval = 3000
$retryTimer = [System.Windows.Forms.Timer]::new()
$retryTimer.Interval = 500
$retryTimer.Add_Tick({ $retryTimer.Stop(); if (-not $script:job) { Start-GuardJob @('validate', '--approval', $Approval, '--expected-sha', $approvalHash) 'validate' } })
# 提交成功后停一下再自动关窗，让人看清提交号；出错时窗口留着
$closeTimer = [System.Windows.Forms.Timer]::new()
$closeTimer.Interval = 900
$closeTimer.Add_Tick({ $closeTimer.Stop(); if (-not $script:noAutoClose) { $form.Close() } })

function Apply-Validate([string]$text, [int]$code) {
    if ($code -eq 0) {
        $script:retried = $false
        Set-Status '确认后只提交下列文件，其他改动不受影响。' 'muted'
        return
    }
    # 一次失败可能只是瞬时冲突（别的进程正在写索引），500ms 后重试一次再定性
    if (-not $script:retried) { $script:retried = $true; $retryTimer.Start(); return }
    $script:retried = $false
    $flat = $text -replace '\s+', ' '
    if ($flat -match $invalidPattern) {
        $validate.Stop()
        $confirm.Enabled = $false
        $confirm.BackColor = $script:cDim
        Set-Status ('这份确认已经不能用了：' + $flat) 'warn'
        Write-WindowLog $flat
        return
    }
    # 查不动（索引被占用、临时文件锁等）：按钮保持可用，下个周期再试；
    # 真点下去时 commit 还会完整校验一次，不会误提交。
    Set-Status ('暂时无法核对（可能正被其他程序写入），稍后自动重试：' + $flat) 'warn'
    Write-WindowLog $flat
}

function Apply-Commit([string]$text, [int]$code) {
    $flat = $text -replace '\s+', ' '
    if ($code -eq 0) {
        $script:outcome = 'committed'
        $id = ($text | ConvertFrom-Json).commit
        Set-Status ('已提交  ' + $id) 'ok'
        $cancel.Text = '关闭'
        $cancel.Enabled = $true
        $closeTimer.Start()
        return
    }
    if ($code -eq 2) {
        $recovery = $text | ConvertFrom-Json
        $script:outcome = $recovery.status
        $heading = if ($recovery.indexPublished) { '提交已生成，结果记录待核对' } else { '提交已生成，索引待恢复' }
        $entry = if ($recovery.recoveryWritten) { $recovery.recoveryFile } else { $recovery.transactionFile }
        $note = if ($recovery.recoveryWritten) { '' } else { '（恢复记录未落盘，持久事务门禁保持）' }
        Set-Status ($heading + $note + $nl + "提交号：$($recovery.commit)" + $nl + "恢复入口：$entry" + $nl + "索引候选：$($recovery.indexCandidate)") 'warn'
        $cancel.Text = '关闭'
        $cancel.Enabled = $true
        return
    }
    $script:outcome = 'failed'
    Set-Status ('提交失败：' + $flat) 'danger'
    $confirm.Enabled = $true
    $confirm.BackColor = $script:cAccent
    $cancel.Enabled = $true
    $snooze.Enabled = $true
    Write-WindowLog $flat
}

$poll.Add_Tick({
    $job = $script:job
    if (-not $job) { return }
    if (-not $job.proc.HasExited) { return }
    $text = Read-JobText $job
    $code = $job.proc.ExitCode
    $kind = $job.kind
    $script:job = $null
    Clear-JobFiles $job
    if ($kind -eq 'commit') { Apply-Commit $text $code } else { Apply-Validate $text $code }
})

$validate.Add_Tick({ if (-not $script:job) { Start-GuardJob @('validate', '--approval', $Approval, '--expected-sha', $approvalHash) 'validate' } })

$confirm.Add_Click({
    $validate.Stop()
    $retryTimer.Stop()
    $script:retried = $false
    $confirm.Enabled = $false
    $confirm.BackColor = $script:cDim
    $cancel.Enabled = $false
    $snooze.Enabled = $false
    Set-Status '正在提交…' 'muted'
    Start-GuardJob @('commit', '--approval', $Approval, '--expected-sha', $approvalHash) 'commit'
})

$cancel.Add_Click({ if (-not $script:outcome) { $script:outcome = 'skipped' }; $form.Close() })
$snooze.Add_Click({ if (-not $script:outcome) { $script:outcome = 'snoozed' }; $form.Close() })
$form.Add_FormClosed({
    foreach ($x in @($validate, $poll, $retryTimer, $closeTimer)) { try { $x.Stop(); $x.Dispose() } catch { } }
    if ($script:job -and $script:job.kind -eq 'validate') { try { $script:job.proc.Kill() } catch { } ; Clear-JobFiles $script:job }
})

if ($SelfTestShot) {
    # 验收外观用：把窗口摆到屏幕外再画出来，屏幕上不会出现它
    $form.StartPosition = 'Manual'
    $form.Location = [System.Drawing.Point]::new(-4000, -4000)
    $form.ShowInTaskbar = $false
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 300
    $bmp = [System.Drawing.Bitmap]::new($form.Width, $form.Height)
    $form.DrawToBitmap($bmp, [System.Drawing.Rectangle]::new(0, 0, $bmp.Width, $bmp.Height))
    $bmp.Save($SelfTestShot, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $form.Close()
    $form.Dispose()
    exit 0
}

if ($SelfTest) {
    $form.ShowInTaskbar = $false
    $form.Opacity = 0
    $script:noAutoClose = $true
    $form.Show()
    $poll.Start()
    if ($SelfTest -eq 'confirm') { $confirm.PerformClick() }
    elseif ($SelfTest -eq 'snooze') { $snooze.PerformClick() }
    else { $cancel.PerformClick() }
    # 提交改成异步了：把消息泵转起来等结果，否则这里会立刻读到空结果
    $deadline = (Get-Date).AddSeconds(180)
    while ($script:job -and (Get-Date) -lt $deadline) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 30
    }
    if ($SelfTestDetails) { [Console]::Out.WriteLine((@{outcome=$script:outcome; status=$status.Text; confirmEnabled=$confirm.Enabled; handleCreated=$form.IsHandleCreated} | ConvertTo-Json -Compress)) }
    else { [Console]::Out.WriteLine(($script:outcome | ConvertTo-Json -Compress)) }
    $form.Dispose()
    # 自检默认退 0 让调用方照常解析输出；带 -SelfTestExit 时按真实路径的约定退码，供测试核对映射
    if ($SelfTestExit) { exit (Get-ExitCode $script:outcome) }
} else {
    $poll.Start()
    $validate.Start()
    [void]$form.ShowDialog()
    $form.Dispose()
    # 退出码是监视进程区分「哪种拒绝」的唯一通道
    exit (Get-ExitCode $script:outcome)
}