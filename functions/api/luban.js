export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  const apikey = env.LUBAN_APIKEY;
  if (!apikey) return Response.json({ ok: false, msg: '未配置 LUBAN_APIKEY 环境变量' }, { headers: corsHeaders });

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const BASE = 'https://lubansms.com/v2/api/';
  const MARKUP = 1.3;
  const USD_TO_CNY = 7.2;

  function buildUrl(path, params) {
    const p = new URLSearchParams();
    p.set('apikey', apikey);
    Object.keys(params || {}).forEach(function(k){
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') p.set(k, v);
    });
    return BASE + path + '?' + p.toString();
  }
  function ok(data) { return Response.json(data, { headers: corsHeaders }); }

  try {
    if (action === 'balance') {
      const r = await fetch(buildUrl('getBalance', {}));
      return ok(await r.json());
    }

    if (action === 'countries') {
      const r = await fetch(buildUrl('countries', {}));
      return ok(await r.json());
    }

    // 后台用（带成本价）
    if (action === 'services') {
      const params = {
        language: url.searchParams.get('language') || 'zh',
        page: url.searchParams.get('page') || '1',
      };
      const countryName = url.searchParams.get('countryName');
      const service = url.searchParams.get('service');
      if (countryName) params.country = countryName;
      if (service) params.service = service;
      const r = await fetch(buildUrl('List', params));
      const d = await r.json();
      if (d.code === 0 && Array.isArray(d.msg)) {
        d.msg = d.msg.map(function(item){
          if (item.cost !== undefined) {
            item.origin_cost = item.cost;
            item.cost = Math.round(parseFloat(item.cost) * MARKUP * 100) / 100;
          }
          return item;
        });
      }
      return ok(d);
    }

    // 客户端用（只返回人民币最终售价，不暴露成本）
    if (action === 'client_services') {
      const params = {
        language: url.searchParams.get('language') || 'zh',
        page: url.searchParams.get('page') || '1',
      };
      const countryName = url.searchParams.get('countryName');
      const service = url.searchParams.get('service');
      if (countryName) params.country = countryName;
      if (service) params.service = service;
      const r = await fetch(buildUrl('List', params));
      const d = await r.json();
      if (d.code === 0 && Array.isArray(d.msg)) {
        d.msg = d.msg.map(function(item){
          if (item.cost !== undefined) {
            const originUsd = parseFloat(item.cost) || 0;
            const finalUsd = originUsd * MARKUP;
            item.price_cny = Math.round(finalUsd * USD_TO_CNY * 100);
            delete item.cost;
            delete item.origin_cost;
          }
          return item;
        });
      }
      return ok(d);
    }

    if (action === 'request_number') {
      const serviceId = url.searchParams.get('service_id');
      if (!serviceId) return ok({ ok: false, msg: '缺少 service_id' });
      const r = await fetch(buildUrl('getNumber', { service_id: serviceId }));
      return ok(await r.json());
    }
    if (action === 'get_sms') {
      const requestId = url.searchParams.get('request_id');
      if (!requestId) return ok({ ok: false, msg: '缺少 request_id' });
      const r = await fetch(buildUrl('getSms', { request_id: requestId }));
      return ok(await r.json());
    }
    if (action === 'change_status') {
      const requestId = url.searchParams.get('request_id');
      const status = url.searchParams.get('status') || 'reject';
      if (!requestId) return ok({ ok: false, msg: '缺少 request_id' });
      const r = await fetch(buildUrl('setStatus', { request_id: requestId, status: status }));
      return ok(await r.json());
    }
    if (action === 'reactivate') {
      const requestId = url.searchParams.get('request_id');
      if (!requestId) return ok({ ok: false, msg: '缺少 request_id' });
      const r = await fetch(buildUrl('getAgainNmber', { request_id: requestId }));
      return ok(await r.json());
    }
    if (action === 'common_request') {
      const phone = url.searchParams.get('phone') || '';
      const params = phone ? { phone: phone } : {};
      const r = await fetch(buildUrl('getKeywordNumber', params));
      return ok(await r.json());
    }
    if (action === 'common_get_sms') {
      const phone = url.searchParams.get('phone');
      const keyword = url.searchParams.get('keyword') || '';
      if (!phone) return ok({ ok: false, msg: '缺少 phone' });
      const r = await fetch(buildUrl('getKeywordSms', { phone: phone, keyword: keyword }));
      return ok(await r.json());
    }
    if (action === 'common_release') {
      const phone = url.searchParams.get('phone');
      if (!phone) return ok({ ok: false, msg: '缺少 phone' });
      const r = await fetch(buildUrl('delKeywordNumber', { phone: phone }));
      return ok(await r.json());
    }

    return ok({ ok: false, msg: '未知 action: ' + action });
  } catch (e) {
    return ok({ ok: false, msg: e.message });
  }
}
