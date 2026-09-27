const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = null, rev = 0;
try {
  if (fs.existsSync(DB_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = parsed.db || null;
    rev = parsed.rev || 0;
  }
} catch (e) { console.error('读取数据失败:', e.message); }

let saveTimer = null;
function saveToDisk() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify({ rev, db, updated_at: Date.now() })); }
    catch (e) { console.error('写入数据失败:', e.message); }
  }, 200);
}

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',   '.json':'application/json; charset=utf-8',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml',
  '.ico':'image/x-icon','.webp':'image/webp','.woff2':'font/woff2'
};
function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function checkToken(req) {
  if (!ACCESS_TOKEN) return true;
  return (req.headers['x-access-token'] || '') === ACCESS_TOKEN;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Access-Token'
    });
    return res.end();
  }

  if (p === '/api/state' && req.method === 'GET') {
    if (!checkToken(req)) return send(res, 403, { ok:false, msg:'无权限' });
    return send(res, 200, { ok:true, rev, db });
  }

  if (p === '/api/state' && req.method === 'POST') {
    if (!checkToken(req)) return send(res, 403, { ok:false, msg:'无权限' });
    let body = '';
    req.on('data', c => { body += c; if (body.length > 30e6) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || !parsed.db) throw new Error('bad');
        if (parsed.baseRev !== undefined && db && parsed.baseRev !== rev) {
          return send(res, 409, { ok:false, msg:'数据已被其他设备更新', rev, db });
        }
        db = parsed.db;
        rev++;
        saveToDisk();
        send(res, 200, { ok:true, rev });
      } catch (e) {
        send(res, 400, { ok:false, msg:'数据格式错误' });
      }
    });
    return;
  }

  if (p === '/healthz') return send(res, 200, { ok:true, rev });

  let file = p === '/' ? '/index.html' : decodeURIComponent(p);
  file = path.join(__dirname, 'public', file);
  const PUBLIC = path.join(__dirname, 'public');
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');

  fs.readFile(file, (err, buf) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, b2) => {
        if (e2) return send(res, 404, 'Not Found', 'text/plain');
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(b2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`✅ 云发卡已启动: http://localhost:${PORT}`);
  console.log(`   数据文件: ${DB_FILE}`);
  if (ACCESS_TOKEN) console.log('   API 访问已启用 Token 校验');
});