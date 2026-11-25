param([string]$TaskName = 'LocalGitQuietReminder', [string]$Config = '')
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw '请使用 PowerShell 7（pwsh）运行安装脚本；未注册计划任务。' }
if (-not $IsWindows) { throw '本安装脚本仅支持 Windows。' }
$pwsh = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $pwsh -PathType Leaf)) { throw '无法定位 PowerShell 7 的 pwsh.exe；未注册计划任务。' }
$node = (Get-Command node -ErrorAction Stop).Source
$gitExe = (Get-Command git -ErrorAction Stop).Source
$launch = Join-Path $PSScriptRoot 'launch.ps1'
$command = "& '" + $launch.Replace("'", "''") + "' -NodeExe '" + $node.Replace("'", "''") + "' -GitExe '" + $gitExe.Replace("'", "''") + "' -PwshExe '" + $pwsh.Replace("'", "''") + "'"
if ($Config) { $command += " -Config '" + ([IO.Path]::GetFullPath($Config)).Replace("'", "''") + "'" }
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -WindowStyle Hidden -EncodedCommand $encoded"
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '本地 Git 静默提醒' -ErrorAction Stop
