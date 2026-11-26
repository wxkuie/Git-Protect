# 安装 Git 静默提交助手（当前用户，不需要管理员）
param(
  [string]$Target = (Join-Path $env:LOCALAPPDATA 'Programs\GitQuietHelper'),
  [switch]$NoLaunch,
  [switch]$NoDesktopShortcut
)
$ErrorActionPreference = 'Stop'

$src = $PSScriptRoot
$srcExe = Join-Path $src 'GitQuietHelper.exe'
if (-not (Test-Path $srcExe)) { throw '安装包不完整：同目录下找不到 GitQuietHelper.exe' }
$version = (Get-Item $srcExe).VersionInfo.ProductVersion
if (-not $version) { $version = (Get-Item $srcExe).VersionInfo.FileVersion }

# 这个脚本会先删掉目标目录再复制：目标一旦指错，删的就是用户的资料。
# 先把源/目标的关系与目录归属校验清楚，宁可拒绝安装也不能误删。
$sep = [IO.Path]::DirectorySeparatorChar
$srcFull = [IO.Path]::GetFullPath($src)
$targetFull = [IO.Path]::GetFullPath($Target)
if ($srcFull.Length -gt 3) { $srcFull = $srcFull.TrimEnd([char[]]@($sep)) }
if ($targetFull.Length -gt 3) { $targetFull = $targetFull.TrimEnd([char[]]@($sep)) }
$srcPrefix = if ($srcFull.EndsWith($sep)) { $srcFull } else { $srcFull + $sep }
$targetPrefix = if ($targetFull.EndsWith($sep)) { $targetFull } else { $targetFull + $sep }
if ($targetFull -eq $srcFull) { throw ('安装目标不能是安装包所在目录：' + $targetFull) }
if ($srcFull.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw ('安装目标不能是安装包目录的上级：' + $targetFull) }
if ($targetFull.StartsWith($srcPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw ('安装目标不能放在安装包目录里面：' + $targetFull) }
$Target = $targetFull

Write-Host ''
Write-Host ('正在安装 Git 静默提交助手 ' + $version)
Write-Host ('目标目录：' + $Target)

# 正在运行的实例会占用文件，先关掉
$running = Get-Process GitQuietHelper -ErrorAction SilentlyContinue
if ($running) {
  Write-Host ('  先关闭正在运行的 ' + $running.Count + ' 个实例')
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 1200
}

if (Test-Path $Target) {
  # 只清理「确认是本软件安装目录」的目录：有主程序，且带卸载脚本。
  # 少一个都可能是用户自己的文件夹，直接递归删除是数据事故。
  $looksInstalled = (Test-Path (Join-Path $Target 'GitQuietHelper.exe')) -and (Test-Path (Join-Path $Target 'uninstall.ps1'))
  if (-not $looksInstalled) {
    throw ('目标目录已经存在，但不像是本软件的安装目录，已停止以免误删：' + $Target + '。请换一个空目录，或先手动清理。')
  }
  Write-Host '  清理上一次安装'
  Remove-Item $Target -Recurse -Force
}
New-Item -ItemType Directory -Path $Target -Force | Out-Null

# 整个目录复制过去（含卸载脚本，装完不再需要压缩包）
Write-Host '  复制文件'
Get-ChildItem $src -Force | ForEach-Object {
  Copy-Item $_.FullName -Destination $Target -Recurse -Force
}
$installedExe = Join-Path $Target 'GitQuietHelper.exe'
if (-not (Test-Path $installedExe)) { throw '复制后找不到 GitQuietHelper.exe，安装失败' }

# 快捷方式：开始菜单 + 桌面
Write-Host '  创建快捷方式'
$shell = New-Object -ComObject WScript.Shell
$startMenu = [Environment]::GetFolderPath('Programs')
$lnk = $shell.CreateShortcut((Join-Path $startMenu 'Git 静默提交助手.lnk'))
$lnk.TargetPath = $installedExe
$lnk.WorkingDirectory = $Target
$lnk.IconLocation = $installedExe
$lnk.Description = '停手后自动把改动提交到本地 Git'
$lnk.Save()

$uninstallCmd = Join-Path $Target '卸载.cmd'
if (Test-Path $uninstallCmd) {
  $lnk2 = $shell.CreateShortcut((Join-Path $startMenu '卸载 Git 静默提交助手.lnk'))
  $lnk2.TargetPath = $uninstallCmd
  $lnk2.WorkingDirectory = $Target
  $lnk2.IconLocation = $installedExe
  $lnk2.Save()
}

if (-not $NoDesktopShortcut) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $lnk3 = $shell.CreateShortcut((Join-Path $desktop 'Git 静默提交助手.lnk'))
  $lnk3.TargetPath = $installedExe
  $lnk3.WorkingDirectory = $Target
  $lnk3.IconLocation = $installedExe
  $lnk3.Save()
}

# 控制面板的「应用和功能」里能看到、能卸载
Write-Host '  登记卸载信息'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GitQuietHelper'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name 'DisplayName' -Value 'Git 静默提交助手'
Set-ItemProperty -Path $key -Name 'DisplayVersion' -Value $version
Set-ItemProperty -Path $key -Name 'Publisher' -Value '本地工具'
Set-ItemProperty -Path $key -Name 'InstallLocation' -Value $Target
Set-ItemProperty -Path $key -Name 'DisplayIcon' -Value $installedExe
Set-ItemProperty -Path $key -Name 'UninstallString' -Value ('pwsh -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Target 'uninstall.ps1') + '"')
Set-ItemProperty -Path $key -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name 'NoRepair' -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name 'EstimatedSize' -Value ([int]((Get-ChildItem $Target -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1KB)) -Type DWord

# 依赖自查：缺了也给装，只提示
Write-Host ''
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host '  [注意] 没找到 git。这个工具靠 git 提交，请先安装 Git for Windows。' -ForegroundColor Yellow
}
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
  Write-Host '  [注意] 没找到 PowerShell 7。确认提交用的窗口需要它。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host ('已安装到：' + $Target)
Write-Host ('  配置和状态保存在：' + (Join-Path $env:APPDATA 'git-quiet-helper'))
Write-Host '  关闭窗口只是收进托盘，自动提交继续跑；要退出请用托盘菜单。'

if (-not $NoLaunch) {
  Write-Host ''
  Write-Host '正在启动…'
  Start-Process -FilePath $installedExe
}
