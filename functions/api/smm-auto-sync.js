// functions/api/smm-auto-sync.js · SMM上游自动同步（安全加固版）
// 变更：
//   1. 鉴权 key 改走 X-Sync-Key 请求头（不再用 URL query，避免日志泄露）
//   2. 缺失 SMM_SYNC_KEY 或使用默认值一律拒绝服务
//   3. CORS 收紧、错误脱敏、上游返回 raw 不再回显
import { corsHeaders, optionsResponse, jsonError, jsonOk } from '../_lib/common.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return optionsResponse(request, env);
  if (request.method !== 'GET') return jsonError('Method not allowed', 405, env, request);

  // 鉴权：X-Sync-Key header，必须配置且非默认值
  const key = request.headers.get('x-sync-key') || '';
  const expected = env.SMM_SYNC_KEY || '';
  if (!expected || expected === 'yunfaka-smm-sync-2026' || key !== expected) {
    return jsonError('未授权或未配置 SMM_SYNC_KEY', 403, env, request);
  }

  try {
    const API_KEY = env.CHINAYINLIU_API_KEY;
    if (!API_KEY) return jsonError('未配置 CHINAYINLIU_API_KEY', 400, env, request);
    const params = new URLSearchParams();
    params.append('key', API_KEY); params.append('action', 'services');
    const r = await fetch('https://chinayinliu.com/api/v2', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
    });
    const data = await r.json();
    if (!Array.isArray(data)) return jsonError('上游返回异常', 502, env, request);

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
      const cnyCost = costCur === 'USD' ? rateVal * rate : rateVal;
      const priceFen = Math.max(1, Math.round(cnyCost * markup * 100));
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
    return jsonOk({ ok: true, added, updated, total, markup, costCur, at: nowStr() }, env, request);
  } catch (e) {
    return jsonError('同步失败', 500, env, request, e);
  }
}
