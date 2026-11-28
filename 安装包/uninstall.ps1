# 卸载 Git 静默提交助手（当前用户）
param([switch]$KeepConfig, [switch]$Silent)
$ErrorActionPreference = 'Continue'

$target = $PSScriptRoot
if (-not $Silent) {
  Write-Host ''
  Write-Host '即将卸载 Git 静默提交助手。'
  Write-Host ('安装目录：' + $target)
}

Get-Process GitQuietHelper -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 1000

if (-not $Silent) {
  $configDir = Join-Path $env:APPDATA 'git-quiet-helper'
  if (Test-Path $configDir) {
    $answer = Read-Host ('是否一并删除配置和提交记录（' + $configDir + '）？删了就找不回，输入 y 删除，直接回车保留')
    if ($answer -eq 'y') { Remove-Item $configDir -Recurse -Force -ErrorAction SilentlyContinue }
    else { Write-Host '  已保留配置' }
  }
}

$startMenu = [Environment]::GetFolderPath('Programs')
foreach ($name in @('Git 静默提交助手.lnk', '卸载 Git 静默提交助手.lnk')) {
  Remove-Item (Join-Path $startMenu $name) -ErrorAction SilentlyContinue
}
$desktop = [Environment]::GetFolderPath('Desktop')
Remove-Item (Join-Path $desktop 'Git 静默提交助手.lnk') -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GitQuietHelper' -Recurse -ErrorAction SilentlyContinue
# 开机自启项：Electron 用 appUserModelId 作值名。不清掉的话，卸载后每次登录还会去启动已删除的程序。
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'electron.app.GitQuietHelper' -ErrorAction SilentlyContinue

# 从安装目录里删掉自己：先切到临时目录，否则目录被占用删不掉
Set-Location $env:TEMP
Start-Sleep -Milliseconds 300
Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue

if (-not $Silent) {
  Write-Host ''
  if (Test-Path $target) {
    Write-Host ('目录没能完全删除，请手动删除：' + $target) -ForegroundColor Yellow
  } else {
    Write-Host '已卸载。' -ForegroundColor Green
  }
  Start-Sleep -Seconds 1
}
