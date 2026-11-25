// 把已打好的 zip 包成一个单文件安装器 exe：双击 → 解压到临时目录 → 跑 install.ps1 → 清理。
// 用系统自带的 csc（.NET Framework 4.x）编译，不引入第三方工具。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const zip = path.resolve(root, arg('zip', 'dist/GitQuietHelper-' + version + '-win64.zip'));
const out = path.resolve(root, arg('out', 'dist/GitQuietHelper-' + version + '-setup.exe'));
const source = path.join(root, 'scripts', 'setup-host.cs');
if (!fs.existsSync(zip)) throw new Error('找不到安装包：' + zip + '（先 npm run installer）');

// csc 在 .NET Framework 目录下；优先 64 位
const cscCandidates = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
];
const csc = cscCandidates.find(function (p) { return fs.existsSync(p); });
if (!csc) throw new Error('找不到 csc.exe（.NET Framework 4.x 自带）');

// 资源名要固定成 payload.zip，程序里按这个名字取
const work = path.join(root, '.tmp', 'setup-build');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const resource = path.join(work, 'payload.zip');
fs.copyFileSync(zip, resource);
fs.mkdirSync(path.dirname(out), { recursive: true });

const args = [
  '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
  '/out:' + out,
  '/resource:' + resource + ',payload.zip',
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.IO.Compression.dll',
  '/reference:System.IO.Compression.FileSystem.dll',
  source
];
console.log('编译…（内嵌 ' + (fs.statSync(resource).size / 1048576).toFixed(1) + ' MB）');
const r = spawnSync(csc, args, { encoding: 'utf8', windowsHide: true });
if (r.status !== 0) {
  console.error(r.stdout || '');
  console.error(r.stderr || '');
  throw new Error('csc 编译失败，退出码 ' + r.status);
}
fs.rmSync(work, { recursive: true, force: true });
const size = fs.statSync(out).size;
console.log('安装器：' + out);
console.log('大小：' + (size / 1048576).toFixed(1) + ' MB');