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
