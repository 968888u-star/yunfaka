// functions/api/smm-auto-sync.js · SMM上游自动同步（供定时任务/Cron调用）
// GET /api/smm-auto-sync?key=xxx
//   → 拉取 chinayinliu 全部服务，新增商品自动按后台加价倍数加价上架，已有商品更新成本价并重算售价（自定义价商品保持不变）
// 用法：用 cron-job.org / 阿里云函数定时 / Cloudflare Worker Cron 每 1~6 小时调用一次
// 鉴权 key = 环境变量 SMM_SYNC_KEY（默认 yunfaka-smm-sync-2026，建议修改）
export async function onRequest(context) {
  const { request, env } = context;
  const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  if (key !== (env.SMM_SYNC_KEY || 'yunfaka-smm-sync-2026')) {
    return new Response(JSON.stringify({ ok: false, msg: 'key invalid' }), { status: 403, headers: cors });
  }
  try {
    const API_KEY = env.CHINAYINLIU_API_KEY;
    if (!API_KEY) return new Response(JSON.stringify({ ok: false, msg: '未配置 CHINAYINLIU_API_KEY' }), { headers: cors });
    const params = new URLSearchParams();
    params.append('key', API_KEY); params.append('action', 'services');
    const r = await fetch('https://chinayinliu.com/api/v2', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
    });
    const data = await r.json();
    if (!Array.isArray(data)) return new Response(JSON.stringify({ ok: false, msg: '上游返回非数组', raw: String(data).slice(0, 200) }), { headers: cors });
    const raw = await env.YUNFAKA_KV.get('state');
    const state = raw ? JSON.parse(raw) : { rev: 0, db: { products: [], seq: { product: 0 }, config: {} } };
    const db = state.db; if (!db.products) db.products = []; if (!db.seq) db.seq = { product: 0 }; if (!db.config) db.config = {};
    const cfg = db.config;
    const markup = Number(cfg.smm_markup) || 1.5;
    const costCur = cfg.smm_cost_currency || 'CNY';
    const rate = Number(cfg.pay_usdt_rate) || 7.2;
    const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
    let added = 0, updated = 0;
    data.forEach(s => {
      const sid = String(s.service || ''); if (!sid) return;
      const rateVal = parseFloat(s.rate) || 0;
      const cnyCost = costCur === 'USD' ? rateVal * rate : rateVal; // 上游成本换算为人民币元
      const priceFen = Math.max(1, Math.round(cnyCost * markup * 100)); // 人民币分
      const exist = db.products.find(p => p.source === 'smm' && String(p.smm_service_id) === sid);
      if (exist) {
        exist.smm_rate_usd = rateVal.toFixed(4);
        exist.name = '[推广] ' + (s.name || '');
        exist.smm_service_name = s.name || '';
        if (!exist.smm_custom_price) exist.price = priceFen;
        updated++;
      } else {
        db.seq.product = (db.seq.product || 0) + 1;
        db.products.push({
          id: db.seq.product, name: '[推广] ' + (s.name || ''), price: priceFen,
          description: '类别：' + (s.category || ''), note: '下单后自动提交上游', category_id: 0,
          active: true, created_at: nowStr(), skus: [], source: 'smm',
          smm_service_id: sid, smm_service_name: s.name || '', smm_rate_usd: rateVal.toFixed(4),
          smm_min: parseInt(s.min) || 1, smm_max: parseInt(s.max) || 100000,
          smm_refill: !!s.refill, smm_cancel: !!s.cancel,
        });
        added++;
      }
    });
    state.rev = (state.rev || 0) + 1;
    await env.YUNFAKA_KV.put('state', JSON.stringify(state));
    const total = db.products.filter(p => p.source === 'smm').length;
    return new Response(JSON.stringify({ ok: true, added, updated, total, markup, costCur, at: nowStr() }), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, msg: e.message }), { status: 500, headers: cors });
  }
}
