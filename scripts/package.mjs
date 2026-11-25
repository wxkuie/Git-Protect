import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// 只带运行必需的文件；node_modules 由 prune 清掉，打包产物不依赖 npm 安装
const appPaths = await packager({
  dir: '.',
  name: 'GitQuietHelper',
  platform: 'win32',
  arch: 'x64',
  out: 'dist',
  overwrite: true,
  asar: false,
  prune: true,
  icon: '图标-多尺寸.ico',
  appVersion: pkg.version,
  ignore: [/^\/(\.git|\.tmp|验证|档案|dist|scripts|node_modules)(\/|$)/]
});
// 裁掉用不到的语言包：Electron 自带 55 种，共约 49 MB，我们只要中文和英文。
// 缺语言时 Chromium 会回退到 en-US，界面文案本来也是我们自己写的，不受影响。
const keepLocales = new Set(['zh-CN.pak', 'en-US.pak']);
let trimmedBytes = 0;
let trimmedCount = 0;
for (const dir of appPaths) {
  const localesDir = path.join(dir, 'locales');
  if (!fs.existsSync(localesDir)) continue;
  for (const name of fs.readdirSync(localesDir)) {
    if (keepLocales.has(name)) continue;
    const target = path.join(localesDir, name);
    trimmedBytes += fs.statSync(target).size;
    fs.rmSync(target, { force: true });
    trimmedCount++;
  }
}
if (trimmedCount) {
  console.log('裁剪语言包 ' + trimmedCount + ' 个，省 ' + (trimmedBytes / 1048576).toFixed(1) + ' MB（保留 zh-CN / en-US）');
}
console.log('PACKAGED ' + appPaths.join(','));

// 配了证书就签名，没配就明确跳过——不静默假装签过。
// 用 PowerShell 自带的 Authenticode 能力，不要求装 Windows SDK。
import { spawnSync } from 'node:child_process';
const exeName = 'GitQuietHelper.exe';
for (const dir of appPaths) {
  const exe = path.join(dir, exeName);
  if (!fs.existsSync(exe)) continue;
  const result = spawnSync('pwsh', ['-NoProfile', '-File', path.join('scripts', 'sign.ps1'), '-Exe', exe], { encoding: 'utf8' });
  const out = ((result.stdout || '') + (result.stderr || '')).trim();
  console.log(out);
  if (result.status !== 0) { console.error('签名失败，构建中止'); process.exit(1); }
}
