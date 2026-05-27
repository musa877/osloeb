// Единая точка входа для нового unified Cloudflare Worker.
// Маршрутизирует POST /notify и POST /bot к соответствующим функциям,
// всё остальное отдаёт как статику (через биндинг ASSETS).

import { onRequestPost as handleNotify } from './functions/notify.js';
import { onRequestPost as handleBot }    from './functions/bot.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST') {
      if (url.pathname === '/notify') {
        return handleNotify({ request, env });
      }
      if (url.pathname === '/bot') {
        return handleBot({ request, env });
      }
    }

    // Всё остальное — статические файлы сайта
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not Found', { status: 404 });
  }
};
