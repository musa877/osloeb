// Cloudflare Pages Function: принимает заявки и расчёты с сайта
// и пересылает в Telegram-бота.
// Маршрут: /notify (автоматически из имени файла).
// Переменные окружения: BOT_TOKEN, CHAT_ID (настраиваются в Cloudflare Dashboard).

export async function onRequestPost({ request, env }) {
  const TOKEN   = env.BOT_TOKEN;
  const CHAT_ID = env.CHAT_ID;

  if (!TOKEN || !CHAT_ID) {
    return json({ ok: false, error: 'not configured' }, 500);
  }

  let data;
  try { data = await request.json(); }
  catch { return json({ ok: false, error: 'bad json' }, 400); }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let text;
  if (data.type === 'lead') {
    text =
      '📬 <b>Новая заявка с сайта GoPack</b>\n\n' +
      '👤 Имя: ' + esc(data.name) + '\n' +
      '📞 Телефон: ' + esc(data.phone) + '\n' +
      (data.mp      ? '🛒 Маркетплейсы: ' + esc(data.mp) + '\n' : '') +
      (data.comment ? '💬 Комментарий: ' + esc(data.comment) + '\n' : '') +
      '\n🌐 gopackfulfilment.ru';
  } else if (data.type === 'offer') {
    text =
      '🧮 <b>Расчёт в калькуляторе</b>\n\n' +
      '📦 Тариф: ' + esc(data.tariff) + '\n' +
      '🔢 Количество: ' + esc(data.qty) + ' шт.\n' +
      '🏷 Маркировка: ' + esc(data.marking) + '\n' +
      '📫 Упаковка: ' + esc(data.packaging) + '\n' +
      '🚚 Доставка: ' + esc(data.delivery) + '\n' +
      '💰 Итого: ' + esc(data.total) + '\n' +
      (data.source ? '\n↗️ Действие: ' + esc(data.source) : '') +
      '\n🌐 gopackfulfilment.ru';
  } else {
    return json({ ok: false, error: 'unknown type' }, 400);
  }

  try {
    const resp = await fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: text, parse_mode: 'HTML' })
    });
    const result = await resp.json();
    return json({ ok: !!result.ok }, result.ok ? 200 : 502);
  } catch (e) {
    return json({ ok: false, error: 'send failed' }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
