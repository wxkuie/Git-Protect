import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 把打包好的程序目录和安装脚本装进一个压缩包：
// 解压后双击「安装.cmd」即可，装完就不再需要压缩包（卸载脚本会一起装进去）。
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const appDir = path.resolve('dist', 'GitQuietHelper-win32-x64');
const extras = path.resolve('安装包');
const stageRoot = path.resolve('dist', 'installer');
const stage = path.join(stageRoot, 'GitQuietHelper-' + pkg.version);
const zipPath = path.resolve('dist', 'GitQuietHelper-' + pkg.version + '-win64.zip');

if (!fs.existsSync(path.join(appDir, 'GitQuietHelper.exe'))) {
  console.error('先运行 npm run package 生成程序目录');
  process.exit(1);
}

fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
console.log('装配 ' + stage);
fs.cpSync(appDir, stage, { recursive: true });
for (const name of fs.readdirSync(extras)) {
  fs.copyFileSync(path.join(extras, name), path.join(stage, name));
}

// 校验必需文件都在，缺了就别出包
for (const name of ['GitQuietHelper.exe', '安装.cmd', '安装.ps1', '卸载.cmd', 'uninstall.ps1', '说明.txt']) {
  if (!fs.existsSync(path.join(stage, name.replace('安装.ps1', 'install.ps1')))) {
    console.error('缺少 ' + name);
    process.exit(1);
  }
}

fs.rmSync(zipPath, { force: true });
const started = Date.now();
const r = spawnSync('pwsh', ['-NoProfile', '-Command',
  'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
  '[System.IO.Compression.ZipFile]::CreateFromDirectory("' + stage + '", "' + zipPath + '", [System.IO.Compression.CompressionLevel]::Optimal, $true)'
], { encoding: 'utf8' });
if (r.status !== 0) { console.error('压缩失败：' + (r.stderr || '')); process.exit(1); }

const info = fs.statSync(zipPath);
const hash = spawnSync('pwsh', ['-NoProfile', '-Command', '(Get-FileHash -Algorithm SHA256 -Path "' + zipPath + '").Hash.ToLower()'], { encoding: 'utf8' }).stdout.trim();
const count = fs.readdirSync(stage).length;
console.log('安装包：' + zipPath);
console.log('大小：' + info.size + ' 字节（' + (info.size / 1024 / 1024).toFixed(1) + ' MB）');
console.log('sha256：' + hash);
console.log('耗时：' + Math.round((Date.now() - started) / 1000) + ' 秒');
fs.rmSync(stageRoot, { recursive: true, force: true });
