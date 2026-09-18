'use strict';
const crypto = require('node:crypto');

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(buf);
}
const ok = (res, data) => json(res, 200, { code: 0, msg: 'ok', data });
// 业务错误码（1xxx 参数 / 2xxx 鉴权 / 3xxx 业务 / 5xxx 系统）不是 HTTP 状态码，
// 只有落在 100–599 区间的才直接当状态码用，其余一律 400，码本身放在响应体里。
const httpStatus = (code) => (Number.isInteger(code) && code >= 100 && code <= 599 ? code : 400);
const fail = (res, code, msg) => json(res, httpStatus(code), { code: code || 3000, msg });

// 读取请求体（MVP：图片/音频走 base64 JSON，省掉 multipart 解析依赖）
function readBody(req, limitBytes = 48 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

const rid = () => crypto.randomBytes(16).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* 老师口令的可还原保存：用主口令（TEACHER_CODE）派生密钥做 AES-256-GCM。
 * 数据库或备份单独被拿到也解不开；换了主口令，旧的口令副本就看不了了，重置一个即可。 */
const secretKey = () => crypto.createHash('sha256').update('tap-read|' + (process.env.TEACHER_CODE || 'dev')).digest();
function encryptSecret(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function decryptSecret(blob) {
  try {
    const [iv, tag, data] = String(blob || '').split('.');
    if (!iv || !tag || !data) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}
/** 老师登录口令：6 位数字，好念也好在手机上输 */
const staffCode = () => String(crypto.randomInt(100000, 1000000));
// 一天按北京时间算：机构和学生都在国内。用固定 +8 而不是服务器本地时区，
// 服务器在日本，学生手机时区也可能不对，固定下来两边才对得上。
const CN_OFFSET_MS = 8 * 3600 * 1000;
const dayKey = (ms = Date.now()) => new Date(ms + CN_OFFSET_MS).toISOString().slice(0, 10);
const today = () => dayKey();
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function inviteCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符
  let s = '';
  for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)];
  return s;
}

module.exports = { json, ok, fail, readBody, rid, sha256, staffCode, encryptSecret, decryptSecret, today, dayKey, now, inviteCode };
