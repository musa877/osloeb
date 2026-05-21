// Serverless-функция Netlify: принимает заявки и расчёты с сайта
// и отправляет их в Telegram-бота.
// Токен и chat_id берутся из переменных окружения Netlify —
// в коде их нет, поэтому они не видны в публичном репозитории.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'method not allowed' }) };
  }

  const TOKEN   = process.env.BOT_TOKEN;
  const CHAT_ID = process.env.CHAT_ID;

  if (!TOKEN || !CHAT_ID) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'not configured' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'bad json' }) };
  }

  // экранируем HTML, чтобы пользовательский ввод не ломал разметку Telegram
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

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
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'unknown type' }) };
  }

  try {
    const resp = await fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: text, parse_mode: 'HTML' })
    });
    const result = await resp.json();
    return {
      statusCode: result.ok ? 200 : 502,
      body: JSON.stringify({ ok: !!result.ok })
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'send failed' }) };
  }
};
