// functions/api/build.js · 返回当前部署的版本号（Cloudflare 自动注入）
export async function onRequest(context) {
  const { env } = context;

  // Cloudflare Pages 会在每次部署时自动注入这些变量
  // 优先级：commit hash > 部署 URL > 时间戳兜底
  const build =
    env.CF_PAGES_COMMIT_SHA ||
    env.CF_PAGES_URL ||
    env.CF_PAGES_BRANCH ||
    'dev';

  return Response.json(
    { ok: true, build: String(build).slice(0, 12) },
    {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
      }
    }
  );
}
