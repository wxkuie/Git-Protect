# 给打包产物加 Authenticode 签名。没配置证书就明确跳过，不假装签过。
# 用系统自带的 Set-AuthenticodeSignature，不依赖 Windows SDK 的 signtool。
param(
  [Parameter(Mandatory)][string]$Exe,
  [string]$Pfx = $env:GQH_SIGN_PFX,
  [string]$Password = $env:GQH_SIGN_PASSWORD,
  [string]$Thumbprint = $env:GQH_SIGN_THUMBPRINT,
  [string]$Timestamp = $(if ($env:GQH_SIGN_TIMESTAMP) { $env:GQH_SIGN_TIMESTAMP } else { 'http://timestamp.digicert.com' })
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Exe)) { throw ('找不到要签名的文件：' + $Exe) }

$cert = $null
$temporary = $false
if ($Thumbprint) {
  $cert = Get-ChildItem 'Cert:\CurrentUser\My' | Where-Object { $_.Thumbprint -eq $Thumbprint } | Select-Object -First 1
  if (-not $cert) { throw ('证书库里找不到指纹 ' + $Thumbprint) }
} elseif ($Pfx) {
  if (-not (Test-Path -LiteralPath $Pfx)) { throw ('找不到证书文件：' + $Pfx) }
  $secure = ConvertTo-SecureString -String $Password -AsPlainText -Force
  # 注意：不能用 Get-PfxCertificate，带密码的 pfx 会弹密码框，无人值守就永远卡住
  $imported = Import-PfxCertificate -FilePath $Pfx -CertStoreLocation 'Cert:\CurrentUser\My' -Password $secure
  $cert = Get-ChildItem 'Cert:\CurrentUser\My' | Where-Object { $_.Thumbprint -eq $imported.Thumbprint } | Select-Object -First 1
  $temporary = $true
} else {
  Write-Output 'SIGN_SKIPPED 未配置签名证书（GQH_SIGN_PFX 或 GQH_SIGN_THUMBPRINT）'
  exit 0
}

try {
  if (-not $cert.HasPrivateKey) { throw '这张证书没有私钥，签不了' }
  $args = @{ LiteralPath = $Exe; Certificate = $cert }
  if ($Timestamp) { $args['TimestampServer'] = $Timestamp }
  $signed = Set-AuthenticodeSignature @args
  if ($signed.Status -eq 'Valid') {
    Write-Output ('SIGNED ' + $cert.Thumbprint + ' ' + $cert.Subject)
  } elseif ($signed.Status -eq 'UnknownError' -or $signed.Status -eq 'NotTrusted') {
    # 自签证书链不被信任时就是这个状态：签名确实写进去了，但系统不认这张证书
    Write-Output ('SIGNED_UNTRUSTED ' + $cert.Thumbprint + ' ' + $cert.Subject + ' status=' + $signed.Status)
  } else {
    throw ('签名失败：' + $signed.Status + ' ' + $signed.StatusMessage)
  }
} finally {
  if ($temporary) {
    Remove-Item ('Cert:\CurrentUser\My\' + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue
    Write-Output 'SIGN_CERT_REMOVED 临时导入的证书已从证书库删除'
  }
}