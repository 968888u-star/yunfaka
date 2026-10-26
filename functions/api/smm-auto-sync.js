// functions/api/smm-auto-sync.js · SMM上游自动同步（增强版：支持下架/恢复检测）
// 变更：
//   1. 鉴权 key 改走 X-Sync-Key 请求头（不再用 URL query，避免日志泄露）
//   2. 缺失 SMM_SYNC_KEY 或使用默认值一律拒绝服务
//   3. CORS 收紧、错误脱敏、上游返回 raw 不再回显
//   4. 【新增】上游下架检测：上游返回列表中不存在的服务自动下架（active=false）
//   5. 【新增】恢复检测：之前被下架但上游重新上架的服务自动恢复（active=true）
//   6. 【新增】防误下架保护：上游返回数量异常骤降时跳过下架操作，仅更新价格
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

    // 上游 service_id 集合（用于下架检测）
    const upstreamIds = new Set();
    data.forEach(s => { const sid = String(s.service || ''); if (sid) upstreamIds.add(sid); });

    // 本地 SMM 商品统计
    const localSmm = db.products.filter(p => p.source === 'smm');
    const localActiveCount = localSmm.filter(p => p.active).length;

    // 【防误下架保护】上游返回数量异常骤降（不足本地上架数30%且本地上架>100）时，跳过下架操作
    const skipRemoval = upstreamIds.size < Math.max(10, localActiveCount * 0.3) && localActiveCount > 100;

    let added = 0, updated = 0, removed = 0, restored = 0;

    // 第一步：处理上游返回的服务（新增/更新/恢复）
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
        exist.smm_min = parseInt(s.min) || 1;
        exist.smm_max = parseInt(s.max) || 100000;
        exist.smm_refill = !!s.refill;
        exist.smm_cancel = !!s.cancel;
        if (!exist.smm_custom_price) exist.price = priceFen;
        // 恢复检测：之前被自动下架，现在上游又有了 → 恢复上架
        if (exist.active === false && exist._auto_removed) {
          exist.active = true;
          delete exist._auto_removed;
          restored++;
        }
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

    // 第二步：下架检测——本地存在但上游已移除的服务
    if (!skipRemoval) {
      db.products.forEach(p => {
        if (p.source !== 'smm') return;
        const sid = String(p.smm_service_id || '');
        if (!upstreamIds.has(sid) && p.active) {
          p.active = false;
          p._auto_removed = true; // 标记为自动下架，用于恢复检测
          p.removed_at = nowStr();
          removed++;
        }
      });
    }

    // 记录上次同步时间
    cfg.smm_last_sync = Date.now();
    state.rev = (state.rev || 0) + 1;
    await env.YUNFAKA_KV.put('state', JSON.stringify(state));
    const total = db.products.filter(p => p.source === 'smm').length;
    return jsonOk({
      ok: true, added, updated, removed, restored, total,
      markup, costCur, skipRemoval, upstreamCount: upstreamIds.size,
      at: nowStr()
    }, env, request);
  } catch (e) {
    return jsonError('同步失败', 500, env, request, e);
  }
}
