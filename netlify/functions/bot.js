// Telegram-бот: интерактивный калькулятор фулфилмента GoPack.
// Пошаговый опрос с inline-клавиатурой. Состояние храним в callback_data,
// БД не нужна — каждый клик несёт всё накопленное состояние.

const TOKEN         = process.env.BOT_TOKEN;
const MANAGER_CHAT  = process.env.MANAGER_CHAT_ID || process.env.CHAT_ID;

// Справочники
const mpNames    = { w:'Wildberries', o:'Ozon', y:'Яндекс Маркет' };
const tariffNames= { e:'Эконом', o:'Оптимальный', s:'Стандарт', p:'Премиум' };
const markNames  = { n:'не нужна', '1':'одинарная (+4 ₽/шт)', '2':'двойная (+8 ₽/шт)' };
const packNames  = { n:'без упаковки', v:'ВПП пакет', b:'БОПП', u:'Пупырка', k:'Курьерский', x:'Картонная коробка' };
const delivNames = { n:'не нужна', s:'до 1 м³', p:'паллет + стретч', c:'договорная' };

// Цены (зеркало логики калькулятора сайта)
const tariffPrices = {
  e: { 1:25, 100:21, 250:17, 500:13, 1000:9  },
  o: { 1:29, 100:25, 250:21, 500:17, 1000:13 },
  s: { 1:33, 100:29, 250:25, 500:21, 1000:17 },
  p: { 1:45, 100:42, 250:36, 500:30, 1000:25 }
};
const markPrices  = { '1':4, '2':8 };
const packPrices  = { v:3, b:4, u:5, k:6, x:15 };
const delivPrices = { s:2200, p:4900 };

function pricePerUnit(t, q) {
  const tbl = tariffPrices[t];
  if (q >= 1000) return tbl[1000];
  if (q >= 500)  return tbl[500];
  if (q >= 250)  return tbl[250];
  if (q >= 100)  return tbl[100];
  return tbl[1];
}

function compute(s) {
  const per = pricePerUnit(s.t, s.q);
  const tariffTotal = per * s.q;
  let markExtra = 0;
  if (s.t === 'e' && s.l && s.l !== 'n') markExtra = markPrices[s.l] * s.q;
  let packExtra = 0;
  if (s.t !== 'p' && s.p && s.p !== 'n') packExtra = packPrices[s.p] * s.q;
  const delivExtra = delivPrices[s.d] || 0;
  const total = tariffTotal + markExtra + packExtra + delivExtra;
  const isCustom = s.d === 'c' || s.q >= 5000;
  return {
    per, tariffTotal, markExtra, packExtra, delivExtra, total,
    totalStr: (isCustom ? '≈ ' : '') + total.toLocaleString('ru') + ' ₽'
  };
}

// Кодирование/декодирование состояния в callback_data (формат "S|m|t|q|l|p|d|step")
function enc(s, step) {
  return ['S', s.m||'_', s.t||'_', s.q==null?'_':s.q, s.l||'_', s.p||'_', s.d||'_', step].join('|');
}
function parse(data) {
  const a = data.split('|');
  return {
    m: a[1]==='_' ? null : a[1],
    t: a[2]==='_' ? null : a[2],
    q: a[3]==='_' ? null : parseInt(a[3]),
    l: a[4]==='_' ? null : a[4],
    p: a[5]==='_' ? null : a[5],
    d: a[6]==='_' ? null : a[6],
    step: a[7]
  };
}

// Какой шаг идёт после текущего (учёт пропусков по тарифу)
function nextAfter(s, cur) {
  if (cur === 'm') return 't';
  if (cur === 't') return 'q';
  if (cur === 'q') {
    if (s.t === 'e') return 'l';     // только эконом спрашивает маркировку
    if (s.t === 'p') return 'd';     // премиум пропускает и маркировку, и упаковку
    return 'p';                       // опт/стандарт — пропускают маркировку, спрашивают упаковку
  }
  if (cur === 'l') return s.t === 'p' ? 'd' : 'p';
  if (cur === 'p') return 'd';
  if (cur === 'd') return 'done';
}

const resetBtn = [{ text: '🔄 Начать заново', callback_data: enc({}, 'm') }];

function buildStep(s) {
  switch (s.step) {
    case 'm':
      return {
        text: '👋 <b>Здравствуйте!</b>\n\nЯ помогу рассчитать стоимость фулфилмента в GoPack за минуту.\n\nВыберите <b>маркетплейс</b>:',
        keyboard: [
          [{ text: '🟣 Wildberries',    callback_data: enc({...s, m:'w'}, 't') }],
          [{ text: '🔵 Ozon',           callback_data: enc({...s, m:'o'}, 't') }],
          [{ text: '🟡 Яндекс Маркет',  callback_data: enc({...s, m:'y'}, 't') }]
        ]
      };
    case 't':
      return {
        text: `🛒 ${mpNames[s.m]}\n\nВыберите <b>тариф</b>:`,
        keyboard: [
          [{ text: 'Эконом — от 9 ₽/шт',           callback_data: enc({...s, t:'e'}, 'q') }],
          [{ text: '🔥 Оптимальный — от 13 ₽/шт',  callback_data: enc({...s, t:'o'}, 'q') }],
          [{ text: 'Стандарт — от 17 ₽/шт',        callback_data: enc({...s, t:'s'}, 'q') }],
          [{ text: 'Премиум — от 25 ₽/шт',         callback_data: enc({...s, t:'p'}, 'q') }],
          resetBtn
        ]
      };
    case 'q': {
      const opts = [[100,250],[500,1000],[2000]];
      const rows = opts.map(row => row.map(q => ({
        text: q.toLocaleString('ru') + ' шт.',
        callback_data: enc({...s, q}, nextAfter({...s, q}, 'q'))
      })));
      rows.push([{ text: '5 000+ шт. (договорная)', callback_data: enc({...s, q:5000}, nextAfter({...s, q:5000}, 'q')) }]);
      rows.push(resetBtn);
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]}\n\nСколько <b>единиц товара</b>?`,
        keyboard: rows
      };
    }
    case 'l':
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\nНужна <b>маркировка</b>?`,
        keyboard: [
          [{ text: 'Не нужна',             callback_data: enc({...s, l:'n'}, nextAfter(s, 'l')) }],
          [{ text: 'Одинарная (+4 ₽/шт)', callback_data: enc({...s, l:'1'}, nextAfter(s, 'l')) }],
          [{ text: 'Двойная (+8 ₽/шт)',   callback_data: enc({...s, l:'2'}, nextAfter(s, 'l')) }],
          resetBtn
        ]
      };
    case 'p':
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\n<b>Упаковка</b>?`,
        keyboard: [
          [
            { text: 'Без упаковки',  callback_data: enc({...s, p:'n'}, 'd') },
            { text: 'ВПП (+3 ₽)',    callback_data: enc({...s, p:'v'}, 'd') }
          ],
          [
            { text: 'БОПП (+4 ₽)',     callback_data: enc({...s, p:'b'}, 'd') },
            { text: 'Пупырка (+5 ₽)',  callback_data: enc({...s, p:'u'}, 'd') }
          ],
          [
            { text: 'Курьерский (+6 ₽)', callback_data: enc({...s, p:'k'}, 'd') },
            { text: 'Коробка (+15 ₽)',   callback_data: enc({...s, p:'x'}, 'd') }
          ],
          resetBtn
        ]
      };
    case 'd':
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\n<b>Доставка до склада МП</b>?`,
        keyboard: [
          [
            { text: 'Не нужна',            callback_data: enc({...s, d:'n'}, 'done') },
            { text: 'До 1 м³ (+2 200 ₽)', callback_data: enc({...s, d:'s'}, 'done') }
          ],
          [
            { text: 'Паллет (+4 900 ₽)',  callback_data: enc({...s, d:'p'}, 'done') },
            { text: 'Договорная',           callback_data: enc({...s, d:'c'}, 'done') }
          ],
          resetBtn
        ]
      };
    case 'done': {
      const c = compute(s);
      const lLabel = s.t === 'e' ? (markNames[s.l] || 'не указано') : 'включена в тариф';
      const pLabel = s.t === 'p' ? 'включена в тариф' : (packNames[s.p] || 'не указано');
      return {
        text:
          '✅ <b>Ваш расчёт готов</b>\n\n' +
          `🛒 Маркетплейс: <b>${mpNames[s.m]}</b>\n` +
          `📦 Тариф: <b>${tariffNames[s.t]}</b>\n` +
          `🔢 Количество: <b>${s.q.toLocaleString('ru')} шт.</b>\n` +
          `🏷 Маркировка: ${lLabel}\n` +
          `📫 Упаковка: ${pLabel}\n` +
          `🚚 Доставка: ${delivNames[s.d]}\n\n` +
          `💰 <b>Итого: ${c.totalStr}</b>\n\n` +
          'Нажмите кнопку — менеджер свяжется в течение часа для уточнения деталей и оформления договора.',
        keyboard: [
          [{ text: '📤 Отправить менеджеру', callback_data: enc(s, 'send') }],
          [{ text: '🔄 Пересчитать',          callback_data: enc({}, 'm') }]
        ]
      };
    }
    case 'sent':
      return {
        text:
          '✅ <b>Готово! Расчёт отправлен менеджеру.</b>\n\n' +
          'Менеджер свяжется с вами в Telegram в течение часа.\n\n' +
          'Хотите рассчитать ещё вариант?',
        keyboard: [
          [{ text: '🔄 Новый расчёт', callback_data: enc({}, 'm') }]
        ]
      };
  }
}

async function tg(method, params) {
  const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return r.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'ok' };
  if (!TOKEN || !MANAGER_CHAT)     return { statusCode: 200, body: 'not configured' };

  let upd;
  try { upd = JSON.parse(event.body); }
  catch { return { statusCode: 200, body: 'bad json' }; }

  try {
    // 1) Команды и текстовые сообщения
    if (upd.message && upd.message.text) {
      const text   = upd.message.text.trim();
      const chatId = upd.message.chat.id;
      const cmd    = text.split(/\s+/)[0].split('@')[0];

      if (cmd === '/start' || cmd === '/calc') {
        const step = buildStep({ step: 'm' });
        await tg('sendMessage', {
          chat_id: chatId, text: step.text, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: step.keyboard }
        });
      } else if (cmd === '/help') {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'GoPack — фулфилмент для маркетплейсов.\n\n/calc — рассчитать стоимость\n/start — начать заново'
        });
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '👋 Чтобы рассчитать стоимость фулфилмента, отправьте /calc'
        });
      }
    }

    // 2) Нажатия на inline-кнопки
    else if (upd.callback_query) {
      const cq    = upd.callback_query;
      const data  = cq.data || '';
      const chatId= cq.message.chat.id;
      const msgId = cq.message.message_id;

      await tg('answerCallbackQuery', { callback_query_id: cq.id });

      if (data.startsWith('S|')) {
        const s = parse(data);

        // Финальная отправка менеджеру
        if (s.step === 'send') {
          const c = compute(s);
          const u = cq.from;
          const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'без имени';
          const link = u.username
            ? '@' + u.username
            : `<a href="tg://user?id=${u.id}">${fullName}</a>`;
          const lLabel = s.t === 'e' ? (markNames[s.l] || 'не указано') : 'включена в тариф';
          const pLabel = s.t === 'p' ? 'включена в тариф' : (packNames[s.p] || 'не указано');

          await tg('sendMessage', {
            chat_id: MANAGER_CHAT, parse_mode: 'HTML',
            text:
              '🧮 <b>Расчёт через Telegram-бота</b>\n\n' +
              `👤 Клиент: ${fullName}\n` +
              `📩 Связаться: ${link}\n\n` +
              `🛒 Маркетплейс: ${mpNames[s.m]}\n` +
              `📦 Тариф: ${tariffNames[s.t]}\n` +
              `🔢 Количество: ${s.q.toLocaleString('ru')} шт.\n` +
              `🏷 Маркировка: ${lLabel}\n` +
              `📫 Упаковка: ${pLabel}\n` +
              `🚚 Доставка: ${delivNames[s.d]}\n\n` +
              `💰 <b>Итого: ${c.totalStr}</b>`
          });

          const sent = buildStep({ step: 'sent' });
          await tg('editMessageText', {
            chat_id: chatId, message_id: msgId, text: sent.text, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: sent.keyboard }
          });
        }
        // Обычные переходы между шагами — редактируем то же сообщение
        else {
          const step = buildStep(s);
          await tg('editMessageText', {
            chat_id: chatId, message_id: msgId, text: step.text, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: step.keyboard }
          });
        }
      }
    }
  } catch (e) {
    // глотаем ошибки — иначе Telegram будет ретраить webhook
  }

  return { statusCode: 200, body: 'ok' };
};
