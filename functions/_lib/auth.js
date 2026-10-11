// functions/_lib/auth.js · 共享鉴权工具（安全加固版 v3）
// 变更：
//   1. 密码哈希升级为 PBKDF2-SHA256（120000 轮 + 每用户随机 16 字节 salt），格式 pbkdf2$120000$saltB64$hashB64
//   2. 完全兼容旧格式（v2: / 旧 hash / 前端 1000 轮迭代），验证通过后自动升级到 PBKDF2
//   3. getSecret 强制要求 ADMIN_SECRET，缺失返回 null（调用方必须拒绝服务）
//   4. 新增 hashSecret / verifySecret：会员暗号哈希存储
//   5. verifyPwd 返回 { ok, needUpgrade }，不再返回布尔值
const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 120000;
const PBKDF2_SALT_BYTES = 16;

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
function b64url(buf) {
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

// ========== JWT（HMAC-SHA256） ==========
export async function signToken(payload, secret) {
  const key = await hmacKey(secret);
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=+$/, '');
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, '');
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(header + '.' + body));
  return header + '.' + body + '.' + b64url(sigBuf);
}
export async function verifyToken(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const key = await hmacKey(secret);
    const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(parts[0] + '.' + parts[1]));
    if (b64url(sigBuf) !== parts[2]) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}

// ========== PBKDF2 密码哈希（新标准） ==========
export async function hashPwd(pwd) {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(String(pwd)), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(bits)}`;
}

async function verifyPbkdf2(pwd, stored) {
  try {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iter = parseInt(parts[1], 10);
    const salt = b64decode(parts[2]);
    const expected = parts[3];
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(String(pwd)), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, keyMaterial, 256
    );
    return b64url(bits) === expected;
  } catch (e) { return false; }
}

// ========== 旧格式兼容（仅用于 verify，验证通过后调用方应升级到 PBKDF2） ==========
function hashPwdLegacyV2(pwd) {
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
function hashPwdLegacyOld(pwd) {
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
function hashPwdLegacyFrontend(pwd) {
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

// 统一密码校验：返回 { ok, needUpgrade }
export async function verifyPwd(input, storedHash) {
  if (!storedHash) return { ok: false, needUpgrade: false };
  const s = String(storedHash);
  if (s.startsWith('pbkdf2$')) {
    const ok = await verifyPbkdf2(input, s);
    return { ok, needUpgrade: false };
  }
  let ok = false;
  if (s.startsWith('v2:')) ok = hashPwdLegacyV2(input) === s;
  else if (hashPwdLegacyOld(input) === s) ok = true;
  else if (hashPwdLegacyFrontend(input) === s) ok = true;
  return { ok, needUpgrade: ok };
}

export function needsHashUpgrade(storedHash) {
  return !!(storedHash && !String(storedHash).startsWith('pbkdf2$'));
}

// ========== 会员暗号哈希 ==========
export async function hashSecret(secret) {
  if (!secret) return '';
  return await hashPwd('::secret::' + secret);
}
export async function verifySecret(input, stored) {
  if (!stored) return { ok: false, needUpgrade: false };
  const s = String(stored);
  if (s.startsWith('pbkdf2$')) {
    const ok = await verifyPbkdf2('::secret::' + input, s);
    return { ok, needUpgrade: false };
  }
  return { ok: s === String(input).trim(), needUpgrade: s === String(input).trim() };
}

// ========== 密钥获取（强制 ADMIN_SECRET，缺失返回 null） ==========
export function getSecret(env) {
  const s = env.ADMIN_SECRET || '';
  if (!s || s === 'yunfaka-default-secret-change-me') return null;
  return s;
}

// 旧默认管理员密码 hash（兼容已部署但从未改密的站点）
export const LEGACY_DEFAULT_ADMIN_HASH = 'v2:1bc7d4e0d34ee3';
