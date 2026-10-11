// functions/_lib/admin-config.js · 管理员配置独立 KV 存储
// 目的：把 admin_pwd_hash 从 state.db.config 里剥离出来
//       即使 /api/state 被越权写入，也无法篡改管理员密码

export const ADMIN_CONFIG_KEY = 'admin_config';

export async function readAdminConfig(env) {
  try {
    const raw = await env.YUNFAKA_KV.get(ADMIN_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export async function writeAdminConfig(env, cfg) {
  await env.YUNFAKA_KV.put(
    ADMIN_CONFIG_KEY,
    JSON.stringify({ ...cfg, updated_at: Date.now() })
  );
}
