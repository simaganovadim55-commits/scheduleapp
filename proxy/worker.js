// Бесплатный прокси на Cloudflare Workers: пропускает только поиск групп и расписание
// и добавляет CORS, чтобы мини-апп мог ходить на ruz.guz.ru прямо из браузера.
// Установка — см. README, раздел «Прокси».
const TARGET = 'https://ruz.guz.ru';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    if (req.method !== 'GET' || !/^\/api\/(search|schedule\/group\/[\w-]+)$/.test(u.pathname))
      return new Response('Not found', { status: 404, headers: CORS });
    const r = await fetch(TARGET + u.pathname + u.search, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (schedule-miniapp)' },
      cf: { cacheTtl: 600, cacheEverything: true }, // кэш 10 минут, чтобы не долбить сайт вуза
    });
    const h = new Headers(r.headers);
    for (const [k, v] of Object.entries(CORS)) h.set(k, v);
    return new Response(r.body, { status: r.status, headers: h });
  },
};
