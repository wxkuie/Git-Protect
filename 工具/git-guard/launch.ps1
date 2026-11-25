param([Parameter(Mandatory)][string]$NodeExe, [Parameter(Mandatory)][string]$GitExe, [Parameter(Mandatory)][string]$PwshExe, [string]$Config = '')
$ErrorActionPreference = 'Stop'
foreach ($exe in @($NodeExe, $GitExe, $PwshExe)) { if (-not [IO.Path]::IsPathFullyQualified($exe) -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "运行时路径无效：$exe" } }
$env:GIT_GUARD_GIT = $GitExe
$env:GIT_GUARD_PWSH = $PwshExe
$guardArgs = @((Join-Path $PSScriptRoot 'guard.mjs'), 'monitor')
if ($Config) { $guardArgs += @('--config', [IO.Path]::GetFullPath($Config)) }
& $NodeExe @guardArgs
exit $LASTEXITCODE
