'use strict';
/**
 * 文件存储层 —— 全库唯一碰文件系统的地方。
 *
 * 和 repo.js 一样是迁移边界：换成腾讯云 COS / 微信云存储时只改本文件。
 * 方法都是 async，为的是将来换成网络存储 SDK 时调用方不用动。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CONTENT_DIR } = require('./db');
const { rid } = require('./util');

const DIR_OF = { image: 'pages', audio: 'audio', rec: 'rec' };

/** 保存 base64 内容，返回相对路径与字节数 */
async function save(kind, base64, ext) {
  const raw = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('文件内容为空');
  const name = `${Date.now()}_${rid().slice(0, 8)}.${(ext || 'bin').replace(/[^a-z0-9]/gi, '')}`;
  const relPath = path.posix.join(DIR_OF[kind] || 'rec', name);
  fs.writeFileSync(path.join(CONTENT_DIR, relPath), buf);
  return { relPath, size: buf.length };
}

/** 对外可访问的地址（迁云后换成 COS 签名 URL） */
function urlOf(relPath) {
  return relPath ? '/files/' + relPath : null;
}

/** 音频时长（ffprobe）—— 迁云后这一步应在本地内容流水线里做完再上传 */
async function probeDurationMs(relPath) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', path.join(CONTENT_DIR, relPath)], { encoding: 'utf8' });
    return Math.round(parseFloat(out.trim()) * 1000) || 0;
  } catch { return 0; }
}

/** 图片尺寸（ImageMagick） */
async function imageSize(relPath) {
  try {
    const out = execFileSync('identify', ['-format', '%w %h', path.join(CONTENT_DIR, relPath)], { encoding: 'utf8' });
    const [w, h] = out.trim().split(/\s+/).map(Number);
    return { w: w || 0, h: h || 0 };
  } catch { return { w: 0, h: 0 }; }
}

module.exports = { save, urlOf, probeDurationMs, imageSize };
