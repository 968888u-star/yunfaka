// functions/_lib/auth.js · 共享鉴权工具（HMAC 签名 session token）
// 用法：import { signToken, verifyToken, hashPwd, verifyPwd } from '../_lib/auth.js';

const enc = new TextEncoder();

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function b64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64decode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 生成签名 token：payload 为 JSON 对象，exp 为过期时间戳（秒）
export async function signToken(payload, secret) {
  const key = await hmacKey(secret);
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=+$/, '');
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, '');
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(header + '.' + body));
  const sig = await b64(sigBuf);
  return header + '.' + body + '.' + sig;
}

// 校验签名 token，返回 payload 或 null
export async function verifyToken(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const key = await hmacKey(secret);
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(parts[0] + '.' + parts[1]));
    const expected = await b64(sigBuf);
    if (expected !== parts[2]) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}

// 与前端 hashPwd 兼容的密码哈希（salt + 多轮异或哈希）
export function hashPwd(pwd) {
  const salt = 'yfk2024salt::v2::';
  const str = salt + '::' + pwd + '::' + salt;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'v2:' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function hashPwdOld(pwd) {
  const salt = 'yfk2024salt';
  const str = salt + '::' + pwd + '::' + salt;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

// 前端旧版密码哈希（1000轮迭代，与 public/index.html 前端 hashPwd 完全一致）
// 旧会员/管理员通过前端注册或改密时用此算法存储，登录需兼容校验
export function hashPwdFrontendOld(pwd) {
  const salt = 'yfk2024salt::v2::';
  let str = salt + pwd + salt;
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let round = 0; round < 1000; round++) {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    }
    str = h1.toString(16) + h2.toString(16) + pwd + salt;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
// 判断存储的哈希是否为旧格式（需升级到 v2 标准格式）
export function needsHashUpgrade(storedHash) {
  return !!(storedHash && !String(storedHash).startsWith('v2:'));
}
export function verifyPwd(input, storedHash) {
  if (!storedHash) return false;
  if (storedHash.startsWith('v2:')) return hashPwd(input) === storedHash;
  if (hashPwdOld(input) === storedHash) return true;
  // 兼容前端旧版 1000 轮迭代哈希（注册/改密时前端生成，无 v2: 前缀）
  if (hashPwdFrontendOld(input) === storedHash) return true;
  return false;
}

export function getSecret(env) {
  return env.ADMIN_SECRET || env.ACCESS_TOKEN || 'yunfaka-default-secret-change-me';
}
