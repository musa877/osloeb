// Telegram-бот GoPack: интерактивный калькулятор + сбор контактов.
// Stateless: всё состояние едет в callback_data и в скрытом маркере
// внутри текста force_reply-сообщений.

const TOKEN        = process.env.BOT_TOKEN;
const MANAGER_CHAT = process.env.MANAGER_CHAT_ID || process.env.CHAT_ID;

// ──────────────── Справочники ────────────────
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
  if (s.t !== 'p' && s.p && s.p !== 'n') {
    // s.p может быть одним символом или несколькими (несколько типов упаковки)
    for (const ch of s.p) packExtra += (packPrices[ch] || 0);
    packExtra *= s.q;
  }
  const delivExtra = delivPrices[s.d] || 0;
  const total = tariffTotal + markExtra + packExtra + delivExtra;
  const isCustom = s.d === 'c' || s.q >= 5000;
  return {
    per, tariffTotal, markExtra, packExtra, delivExtra, total,
    totalStr: (isCustom ? '≈ ' : '') + total.toLocaleString('ru') + ' ₽'
  };
}

// Текст про упаковку (поддерживает несколько типов)
function packLabel(s) {
  if (s.t === 'p')               return 'включена в тариф';
  if (!s.p)                       return 'не указано';
  if (s.p === 'n')                return packNames.n;
  if (s.p.length === 1)           return packNames[s.p];
  return [...s.p].map(c => packNames[c]).join(' + ');
}

// Переключатель упаковки в мульти-режиме (добавляет/убирает символ)
function togglePack(current, ch) {
  const cur = (!current || current === 'n') ? '' : current;
  if (cur.includes(ch)) {
    const next = cur.replace(ch, '');
    return next || null;
  }
  return cur + ch;
}

// ──────────────── Состояние ────────────────
// Формат: S|m|t|q|l|p|d|step|phone
function enc(s, step) {
  return ['S', s.m||'_', s.t||'_', s.q==null?'_':s.q, s.l||'_', s.p||'_', s.d||'_', step, s.phone||'_'].join('|');
}
function parse(data) {
  const a = data.split('|');
  return {
    m:     a[1]==='_' ? null : a[1],
    t:     a[2]==='_' ? null : a[2],
    q:     a[3]==='_' ? null : parseInt(a[3]),
    l:     a[4]==='_' ? null : a[4],
    p:     a[5]==='_' ? null : a[5],
    d:     a[6]==='_' ? null : a[6],
    step:  a[7],
    phone: (!a[8] || a[8]==='_') ? null : a[8]
  };
}

// ──────────────── Навигация ────────────────
function nextAfter(s, cur) {
  if (cur === 'm') return 't';
  if (cur === 't') return 'q';
  if (cur === 'q') {
    if (s.t === 'e') return 'l';
    if (s.t === 'p') return 'd';
    return 'p';
  }
  if (cur === 'l') return s.t === 'p' ? 'd' : 'p';
  if (cur === 'p') return 'd';
  if (cur === 'd') return 'done';
}

function backFrom(s, cur) {
  if (cur === 't')    return { ...s, m:null, step:'m' };
  if (cur === 'q')    return { ...s, t:null, step:'t' };
  if (cur === 'l')    return { ...s, q:null, step:'q' };
  if (cur === 'p') {
    if (s.t === 'e')  return { ...s, l:null, step:'l' };
    return                    { ...s, q:null, step:'q' };
  }
  if (cur === 'pm')   return { ...s, p:null, step:'p' };
  if (cur === 'd') {
    if (s.t === 'p')  return { ...s, q:null, step:'q' };
    // если в упаковке несколько типов — возвращаем в мульти-режим
    if (s.p && s.p.length > 1) return { ...s, step:'pm' };
    return                    { ...s, p:null, step:'p' };
  }
  if (cur === 'done') return { ...s, d:null, step:'d' };
  return null;
}

function navRow(s, cur) {
  const back = backFrom(s, cur);
  if (!back) return [{ text: '🔄 Начать заново', callback_data: enc({}, 'm') }];
  return [
    { text: '⬅️ Назад',  callback_data: enc(back, back.step) },
    { text: '🔄 Заново', callback_data: enc({}, 'm') }
  ];
}

// ──────────────── Телефон ────────────────
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10 && d[0] === '9') d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 11 && d[0] === '7') return d;
  return null;
}
function formatPhone(d) {
  return `+${d[0]} (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7,9)}-${d.slice(9,11)}`;
}

// ──────────────── Рендер шагов ────────────────
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
          navRow(s, 't')
        ]
      };
    case 'q': {
      const opts = [[100,250],[500,1000],[2000,5000]];
      const rows = opts.map(row => row.map(q => ({
        text: q.toLocaleString('ru') + ' шт.',
        callback_data: enc({...s, q}, nextAfter({...s, q}, 'q'))
      })));
      rows.push([{ text: '✏️ Ввести точное количество', callback_data: enc(s, 'qask') }]);
      rows.push(navRow(s, 'q'));
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]}\n\nСколько <b>единиц товара</b>?\n\nВыберите вариант или введите своё число.`,
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
          navRow(s, 'l')
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
          [{ text: '➕ Несколько типов упаковки', callback_data: enc({...s, p:null}, 'pm') }],
          navRow(s, 'p')
        ]
      };
    case 'pm': {
      const current = (s.p && s.p !== 'n') ? s.p : '';
      const items = [
        { ch:'v', name:'ВПП (+3 ₽)' },
        { ch:'b', name:'БОПП (+4 ₽)' },
        { ch:'u', name:'Пупырка (+5 ₽)' },
        { ch:'k', name:'Курьерский (+6 ₽)' },
        { ch:'x', name:'Коробка (+15 ₽)' }
      ];
      const rows = [];
      for (let i = 0; i < items.length; i += 2) {
        const row = [items[i], items[i+1]].filter(Boolean).map(it => {
          const selected = current.includes(it.ch);
          const newP = togglePack(current, it.ch);
          return {
            text: (selected ? '✅ ' : '➕ ') + it.name,
            callback_data: enc({...s, p: newP}, 'pm')
          };
        });
        rows.push(row);
      }
      if (current.length > 0) {
        let sum = 0;
        for (const ch of current) sum += (packPrices[ch] || 0);
        rows.push([{
          text: `✓ Готово (упаковка: +${sum} ₽/шт)`,
          callback_data: enc(s, 'd')
        }]);
      }
      rows.push(navRow(s, 'pm'));
      const sel = current ? [...current].map(c => packNames[c]).join(' + ') : 'пока ничего не выбрано';
      return {
        text:
          `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\n` +
          '<b>Несколько типов упаковки</b>\n' +
          'Клик по варианту — добавить/убрать. Цены складываются.\n\n' +
          `<i>Выбрано: ${sel}</i>`,
        keyboard: rows
      };
    }
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
          navRow(s, 'd')
        ]
      };
    case 'done': {
      const c = compute(s);
      const lLabel = s.t === 'e' ? (markNames[s.l] || 'не указано') : 'включена в тариф';
      const pLabel = packLabel(s);
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
          'Нажмите «Отправить менеджеру» — попрошу телефон, и наш специалист свяжется с вами для уточнения деталей.',
        keyboard: [
          [{ text: '📤 Отправить менеджеру', callback_data: enc(s, 'phoneask') }],
          navRow(s, 'done')
        ]
      };
    }
    case 'sent':
      return {
        text:
          '✅ <b>Готово! Заявка отправлена менеджеру.</b>\n\n' +
          'Менеджер свяжется с вами по указанному телефону в течение часа.\n\n' +
          'Хотите рассчитать ещё вариант?',
        keyboard: [
          [{ text: '🔄 Новый расчёт', callback_data: enc({}, 'm') }]
        ]
      };
  }
}

// ──────────────── Telegram API ────────────────
async function tg(method, params) {
  const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return r.json();
}

// Промпт с force_reply и скрытым state-маркером
async function askWithForceReply(chatId, header, prompt, state, placeholder) {
  return tg('sendMessage', {
    chat_id: chatId,
    text:
      (header ? header + '\n\n' : '') +
      prompt + '\n\n' +
      '<code>STATE:' + enc(state, state.step) + '</code>',
    parse_mode: 'HTML',
    reply_markup: {
      force_reply: true,
      input_field_placeholder: placeholder || ''
    }
  });
}

// Отправка заявки менеджеру + подтверждение пользователю
async function sendToManager(chatId, msgId, s, comment, user) {
  const c = compute(s);
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'без имени';
  const link = user.username
    ? '@' + user.username
    : `<a href="tg://user?id=${user.id}">${fullName}</a>`;
  const lLabel = s.t === 'e' ? (markNames[s.l] || 'не указано') : 'включена в тариф';
  const pLabel = packLabel(s);

  await tg('sendMessage', {
    chat_id: MANAGER_CHAT, parse_mode: 'HTML',
    text:
      '🧮 <b>Заявка из Telegram-бота</b>\n\n' +
      `👤 Клиент: ${fullName}\n` +
      `📞 Телефон: <code>${formatPhone(s.phone)}</code>\n` +
      `💬 Telegram: ${link}\n` +
      (comment ? `📝 Комментарий: ${comment}\n` : '') +
      `\n🛒 Маркетплейс: ${mpNames[s.m]}\n` +
      `📦 Тариф: ${tariffNames[s.t]}\n` +
      `🔢 Количество: ${s.q.toLocaleString('ru')} шт.\n` +
      `🏷 Маркировка: ${lLabel}\n` +
      `📫 Упаковка: ${pLabel}\n` +
      `🚚 Доставка: ${delivNames[s.d]}\n\n` +
      `💰 <b>Итого: ${c.totalStr}</b>`
  });

  const sent = buildStep({ step: 'sent' });
  await tg('sendMessage', {
    chat_id: chatId, text: sent.text, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: sent.keyboard }
  });
}

// ──────────────── Webhook handler ────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'ok' };
  if (!TOKEN || !MANAGER_CHAT)     return { statusCode: 200, body: 'not configured' };

  let upd;
  try { upd = JSON.parse(event.body); }
  catch { return { statusCode: 200, body: 'bad json' }; }

  try {
    // ────── 1) ТЕКСТОВЫЕ СООБЩЕНИЯ ──────
    if (upd.message && upd.message.text) {
      const text   = upd.message.text.trim();
      const chatId = upd.message.chat.id;
      const cmd    = text.split(/\s+/)[0].split('@')[0];
      const reply  = upd.message.reply_to_message;

      // Ответ на force_reply от бота (число количества, телефон или комментарий)
      if (reply && reply.text) {
        const m = reply.text.match(/STATE:(S\|[^\s<]+)/);
        if (m) {
          const s = parse(m[1]);
          const lc = text.toLowerCase();

          // Универсальная команда «назад» в любом force_reply
          if (lc === 'назад' || lc === 'back') {
            // Возвращаем на шаг ПЕРЕД force_reply:
            // qresp → q, phoneresp → done, commentresp → перепроcить телефон
            if (s.step === 'qresp') {
              const st = buildStep({ ...s, step: 'q' });
              await tg('sendMessage', { chat_id: chatId, text: st.text, parse_mode: 'HTML',
                reply_markup: { inline_keyboard: st.keyboard } });
            } else if (s.step === 'phoneresp') {
              const st = buildStep({ ...s, step: 'done' });
              await tg('sendMessage', { chat_id: chatId, text: st.text, parse_mode: 'HTML',
                reply_markup: { inline_keyboard: st.keyboard } });
            } else if (s.step === 'commentresp') {
              await askWithForceReply(chatId, null,
                '📞 Введите ваш <b>телефон</b> для связи:',
                { ...s, phone: null, step: 'phoneresp' },
                '+7 (___) ___-__-__');
            }
            return { statusCode: 200, body: 'ok' };
          }

          // ── Ответ: точное количество ──
          if (s.step === 'qresp') {
            const numStr = text.replace(/[\s.,' ]/g, '');
            const q = parseInt(numStr);
            if (!q || isNaN(q) || q < 1 || q > 100000) {
              await askWithForceReply(chatId, null,
                '⚠️ Нужно число от 1 до 100 000. Попробуйте ещё раз — например: 750',
                s, 'Например: 750');
              return { statusCode: 200, body: 'ok' };
            }
            const newS = { ...s, q };
            newS.step = nextAfter(newS, 'q');
            const step = buildStep(newS);
            await tg('sendMessage', {
              chat_id: chatId, text: step.text, parse_mode: 'HTML',
              reply_markup: { inline_keyboard: step.keyboard }
            });
            return { statusCode: 200, body: 'ok' };
          }

          // ── Ответ: телефон ──
          if (s.step === 'phoneresp') {
            const phoneDigits = normalizePhone(text);
            if (!phoneDigits) {
              await askWithForceReply(chatId, null,
                '⚠️ Не похоже на телефон. Введите номер в формате +7 (999) 123-45-67 или просто 9991234567.\n' +
                '(или отправьте «назад», чтобы вернуться)',
                s, '+7 (___) ___-__-__');
              return { statusCode: 200, body: 'ok' };
            }
            // Спрашиваем комментарий
            await askWithForceReply(chatId,
              `📞 Телефон: <code>${formatPhone(phoneDigits)}</code>`,
              '📝 <b>Комментарий</b> (объём партии, особенности товара) — необязательно.\n\n' +
              'Напишите пару слов ИЛИ отправьте <code>-</code> чтобы пропустить.',
              { ...s, phone: phoneDigits, step: 'commentresp' },
              'Пара слов о товаре или «-»');
            return { statusCode: 200, body: 'ok' };
          }

          // ── Ответ: комментарий ──
          if (s.step === 'commentresp') {
            const skipWords = ['-', '—', '–', 'нет', 'no', 'skip', 'пропустить', 'пропуск', 'нету', 'без'];
            const comment = skipWords.includes(lc) ? '' : text;
            await sendToManager(chatId, null, s, comment, upd.message.from);
            return { statusCode: 200, body: 'ok' };
          }
        }
      }

      // Секретная команда 🌙
      if (cmd === '/tungtungsahur') {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'привет любимая ❤️'
        });
        return { statusCode: 200, body: 'ok' };
      }

      // Команды
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

    // ────── 2) НАЖАТИЯ INLINE-КНОПОК ──────
    else if (upd.callback_query) {
      const cq    = upd.callback_query;
      const data  = cq.data || '';
      const chatId= cq.message.chat.id;
      const msgId = cq.message.message_id;

      await tg('answerCallbackQuery', { callback_query_id: cq.id });

      if (data.startsWith('S|')) {
        const s = parse(data);

        // Запрос точного количества
        if (s.step === 'qask') {
          await askWithForceReply(chatId,
            `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]}`,
            '✏️ Введите <b>количество товара</b> числом (от 1 до 100 000):\n' +
            '(или отправьте «назад», чтобы вернуться)',
            { ...s, step: 'qresp' },
            'Например: 750');
          return { statusCode: 200, body: 'ok' };
        }

        // Запрос телефона (новое имя 'phoneask') и старое 'send' — для совместимости
        if (s.step === 'phoneask' || s.step === 'send') {
          await askWithForceReply(chatId,
            null,
            '📞 Введите ваш <b>телефон</b> для связи:\n' +
            '(или отправьте «назад», чтобы вернуться к расчёту)',
            { ...s, phone: null, step: 'phoneresp' },
            '+7 (___) ___-__-__');
          return { statusCode: 200, body: 'ok' };
        }

        // Обычные переходы — редактируем то же сообщение
        const step = buildStep(s);
        await tg('editMessageText', {
          chat_id: chatId, message_id: msgId, text: step.text, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: step.keyboard }
        });
      }
    }
  } catch (e) {
    // глотаем ошибки — иначе Telegram будет ретраить webhook
  }

  return { statusCode: 200, body: 'ok' };
};
