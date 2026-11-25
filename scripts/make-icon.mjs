import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

// 从源图标生成多尺寸 ICO：Windows 会按 DPI 取最合适的那一档，
// 比让外壳把 256 硬缩到 16px 清楚得多。产物可重复生成，不手工改二进制。
const SRC = '图标.ico';
const OUT = '图标-多尺寸.ico';
const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.disableHardwareAcceleration();
app.whenReady().then(function () {
  const src = nativeImage.createFromPath(SRC);
  if (src.isEmpty()) { console.log('源图标读不出来'); app.exit(1); return; }
  const images = SIZES.map(function (size) {
    const img = src.resize({ width: size, height: size, quality: 'best' });
    return { size: size, png: img.toPNG() };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const item of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(item.size >= 256 ? 0 : item.size, 0);
    e.writeUInt8(item.size >= 256 ? 0 : item.size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(item.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += item.png.length;
  }

  fs.writeFileSync(OUT, Buffer.concat([header].concat(entries, images.map(function (x) { return x.png; }))));
  const bytes = fs.statSync(OUT).size;
  console.log('已生成 ' + OUT + ' 尺寸=' + SIZES.join(',') + ' 字节=' + bytes);

  const back = nativeImage.createFromPath(OUT);
  console.log('回读尺寸=' + JSON.stringify(back.getSize()) + ' 空=' + back.isEmpty());
  app.exit(0);
});
