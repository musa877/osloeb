// Telegram-бот GoPack: интерактивный калькулятор + сбор контактов.
// Состояние диалога (ожидание текстового ответа) хранится в Netlify Blobs
// по chat_id, поэтому работает независимо от reply_to_message.

const { getStore, connectLambda } = require('@netlify/blobs');

const TOKEN        = process.env.BOT_TOKEN;
const MANAGER_CHAT = process.env.MANAGER_CHAT_ID || process.env.CHAT_ID;
const PENDING_TTL_MS = 30 * 60 * 1000; // 30 минут

// ──────────────── Справочники ────────────────
const mpNames    = { w:'Wildberries', o:'Ozon', y:'Яндекс Маркет' };
const tariffNames= { e:'Эконом', o:'Оптимальный', s:'Стандарт', p:'Премиум' };
const markNames  = { n:'не нужна', '1':'одинарная (+4 ₽/шт)', '2':'двойная (+8 ₽/шт)' };
const packNames  = {
  n:'без упаковки',
  v:'ВПП пакет', b:'БОПП', u:'Пупырка', k:'Курьерский',
  x:'Картонная коробка',
  A:'Коробка 10×10 (трёхслойная)',
  B:'Коробка 15×15 (трёхслойная)',
  C:'Коробка 20×20 (двухслойная)',
  D:'Коробка 20×20 (трёхслойная)',
  E:'Коробка 30×30 (трёхслойная)',
  F:'Коробка 40×40 (трёхслойная)',
  G:'Коробка 50×50 (трёхслойная)',
  H:'Коробка 60×50 (трёхслойная)'
};
const delivNames = { n:'не нужна', s:'до 1 м³', p:'паллет + стретч', c:'договорная' };

const tariffPrices = {
  e: { 1:25, 100:21, 250:17, 500:13, 1000:9  },
  o: { 1:29, 100:25, 250:21, 500:17, 1000:13 },
  s: { 1:33, 100:29, 250:25, 500:21, 1000:17 },
  p: { 1:45, 100:42, 250:36, 500:30, 1000:25 }
};
const markPrices  = { '1':4, '2':8 };
const packPrices  = { v:3, b:4, u:5, k:6, x:15, A:22, B:23, C:24, D:27, E:32, F:42, G:45, H:51 };
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

function packLabel(s) {
  if (s.t === 'p')         return 'включена в тариф';
  if (!s.p)                 return 'не указано';
  if (s.p === 'n')          return packNames.n;
  if (s.p.length === 1)     return packNames[s.p];
  return [...s.p].map(c => packNames[c]).join(' + ');
}

function togglePack(current, ch) {
  const cur = (!current || current === 'n') ? '' : current;
  if (cur.includes(ch)) {
    const next = cur.replace(ch, '');
    return next || null;
  }
  return cur + ch;
}

// ──────────────── Состояние callback_data ────────────────
// Формат: S|m|t|q|l|p|d|step
function enc(s, step) {
  return ['S', s.m||'_', s.t||'_', s.q==null?'_':s.q, s.l||'_', s.p||'_', s.d||'_', step].join('|');
}
function parse(data) {
  const a = data.split('|');
  return {
    m:    a[1]==='_' ? null : a[1],
    t:    a[2]==='_' ? null : a[2],
    q:    a[3]==='_' ? null : parseInt(a[3]),
    l:    a[4]==='_' ? null : a[4],
    p:    a[5]==='_' ? null : a[5],
    d:    a[6]==='_' ? null : a[6],
    step: a[7]
  };
}

// ──────────────── Серверное хранение pending-state ────────────────
// Strong consistency обязательна: запись (на клике кнопки) и чтение
// (на следующем сообщении пользователя) идут разными вызовами функции.
let lastError = null;
function store() {
  const opts = { name: 'bot-pending', consistency: 'strong' };
  // Если автодетект не работает, используем явные siteID + token из env
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
  if (siteID && token) {
    opts.siteID = siteID;
    opts.token  = token;
  }
  return getStore(opts);
}

async function setPending(chatId, data) {
  try {
    await store().setJSON('chat:' + chatId, { ...data, ts: Date.now() });
  } catch (e) { lastError = 'setPending: ' + e.message; }
}
async function getPending(chatId) {
  try {
    const data = await store().get('chat:' + chatId, { type: 'json' });
    if (!data) return null;
    if (Date.now() - (data.ts || 0) > PENDING_TTL_MS) {
      await store().delete('chat:' + chatId).catch(() => {});
      return null;
    }
    return data;
  } catch (e) { lastError = 'getPending: ' + e.message; return null; }
}
async function clearPending(chatId) {
  try { await store().delete('chat:' + chatId); } catch (e) { lastError = 'clearPending: ' + e.message; }
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
  if (cur === 'pbox') return { ...s, p:null, step:'p' };
  if (cur === 'd') {
    if (s.t === 'p')  return { ...s, q:null, step:'q' };
    if (s.p && 'ABCDEFGH'.includes(s.p)) return { ...s, step:'pbox' };
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
            { text: '📦 Коробка — выбрать размер', callback_data: enc({...s, p:null}, 'pbox') }
          ],
          [{ text: '➕ Несколько типов упаковки', callback_data: enc({...s, p:null}, 'pm') }],
          navRow(s, 'p')
        ]
      };
    case 'pbox':
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\n📦 <b>Размер коробки</b>:`,
        keyboard: [
          [
            { text: '10×10 трёхсл. (+22 ₽)',  callback_data: enc({...s, p:'A'}, 'd') },
            { text: '15×15 трёхсл. (+23 ₽)',  callback_data: enc({...s, p:'B'}, 'd') }
          ],
          [
            { text: '20×20 двухсл. (+24 ₽)',  callback_data: enc({...s, p:'C'}, 'd') },
            { text: '20×20 трёхсл. (+27 ₽)',  callback_data: enc({...s, p:'D'}, 'd') }
          ],
          [
            { text: '30×30 трёхсл. (+32 ₽)',  callback_data: enc({...s, p:'E'}, 'd') },
            { text: '40×40 трёхсл. (+42 ₽)',  callback_data: enc({...s, p:'F'}, 'd') }
          ],
          [
            { text: '50×50 трёхсл. (+45 ₽)',  callback_data: enc({...s, p:'G'}, 'd') },
            { text: '60×50 трёхсл. (+51 ₽)',  callback_data: enc({...s, p:'H'}, 'd') }
          ],
          navRow(s, 'pbox')
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

async function sendStep(chatId, s) {
  const step = buildStep(s);
  await tg('sendMessage', {
    chat_id: chatId, text: step.text, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: step.keyboard }
  });
}

async function sendPrompt(chatId, text, placeholder) {
  await tg('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    reply_markup: {
      force_reply: true,
      input_field_placeholder: placeholder || ''
    }
  });
}

// Запрос телефона с кнопкой «Поделиться номером»
async function sendPhonePrompt(chatId) {
  await tg('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text:
      '📞 Нажмите <b>«Поделиться номером»</b> ниже\n' +
      'или введите телефон вручную\n\n' +
      '<i>(можно отправить «назад» чтобы вернуться к расчёту)</i>',
    reply_markup: {
      keyboard: [
        [{ text: '📞 Поделиться номером', request_contact: true }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
}

// Снятие reply-клавиатуры
async function removeReplyKeyboard(chatId, text) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: text || '⬅️',
    reply_markup: { remove_keyboard: true }
  });
}

async function sendToManager(chatId, s, comment, user) {
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
  // Инициализация Netlify Blobs контекста для Lambda-стиля функций
  try { connectLambda(event); } catch (e) { lastError = 'connectLambda: ' + e.message; }

  if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'ok' };
  if (!TOKEN || !MANAGER_CHAT)     return { statusCode: 200, body: 'not configured' };

  let upd;
  try { upd = JSON.parse(event.body); }
  catch { return { statusCode: 200, body: 'bad json' }; }

  try {
    // ────── КОНТАКТ (нажата кнопка «Поделиться номером») ──────
    if (upd.message && upd.message.contact) {
      const chatId = upd.message.chat.id;
      const pending = await getPending(chatId);
      if (pending && pending.step === 'phoneresp') {
        const phoneDigits = normalizePhone(upd.message.contact.phone_number);
        if (phoneDigits) {
          const newS = { ...pending.s, phone: phoneDigits };
          await setPending(chatId, { step: 'commentresp', s: newS });
          await sendPrompt(chatId,
            `📞 Телефон: <code>${formatPhone(phoneDigits)}</code>\n\n` +
            '📝 <b>Комментарий</b> (объём партии, особенности товара) — необязательно.\n\n' +
            'Напишите пару слов ИЛИ отправьте «<b>-</b>» чтобы пропустить.',
            'Пара слов о товаре или «-»');
        } else {
          // некорректный телефон в контакте — просим снова
          await sendPhonePrompt(chatId);
        }
      }
      return { statusCode: 200, body: 'ok' };
    }

    // ────── ТЕКСТОВЫЕ СООБЩЕНИЯ ──────
    if (upd.message && upd.message.text) {
      const text   = upd.message.text.trim();
      const chatId = upd.message.chat.id;
      const cmd    = text.split(/\s+/)[0].split('@')[0];
      const lc     = text.toLowerCase();

      // Секретная команда 🌙
      if (cmd === '/tungtungsahur') {
        await tg('sendMessage', { chat_id: chatId, text: 'привет любимая ❤️' });
        return { statusCode: 200, body: 'ok' };
      }

      // Диагностика хранилища: write → read → verify
      if (cmd === '/debug') {
        lastError = null;
        const testKey = 'test-' + Date.now();
        let report = '🔧 <b>Диагностика хранилища</b>\n\n';
        try {
          await store().setJSON('chat:' + chatId + ':' + testKey, { hello: 'world', ts: Date.now() });
          report += '✅ setJSON ok\n';
          const got = await store().get('chat:' + chatId + ':' + testKey, { type: 'json' });
          report += got && got.hello === 'world'
            ? '✅ get ok — данные совпали\n'
            : '❌ get вернул не то: ' + JSON.stringify(got) + '\n';
          await store().delete('chat:' + chatId + ':' + testKey).catch(() => {});
          report += '✅ delete ok\n';
        } catch (e) {
          report += '❌ Ошибка: ' + e.message + '\n';
        }
        if (lastError) report += '\n⚠️ lastError: ' + lastError;
        const pending = await getPending(chatId);
        report += '\n\n📦 pending для вашего chat_id: ' + (pending ? JSON.stringify(pending) : 'нет');
        report += '\n\n🔍 ENV:\n' +
          '• SITE_ID: ' + (process.env.SITE_ID ? '✓' : '✗') + '\n' +
          '• NETLIFY_SITE_ID: ' + (process.env.NETLIFY_SITE_ID ? '✓' : '✗') + '\n' +
          '• NETLIFY_BLOBS_CONTEXT: ' + (process.env.NETLIFY_BLOBS_CONTEXT ? '✓' : '✗') + '\n' +
          '• NETLIFY_AUTH_TOKEN: ' + (process.env.NETLIFY_AUTH_TOKEN ? '✓' : '✗') + '\n' +
          '• DEPLOY_ID: ' + (process.env.DEPLOY_ID ? '✓' : '✗');
        await tg('sendMessage', { chat_id: chatId, text: report, parse_mode: 'HTML' });
        return { statusCode: 200, body: 'ok' };
      }

      // Команды старта — всегда сбрасывают pending
      if (cmd === '/start' || cmd === '/calc') {
        await clearPending(chatId);
        await sendStep(chatId, { step: 'm' });
        return { statusCode: 200, body: 'ok' };
      }
      if (cmd === '/help') {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'GoPack — фулфилмент для маркетплейсов.\n\n/calc — рассчитать стоимость\n/start — начать заново'
        });
        return { statusCode: 200, body: 'ok' };
      }

      // Проверяем pending-state — ожидает ли бот сейчас текстовый ответ?
      const pending = await getPending(chatId);

      // Универсальная команда «назад» в любом текстовом шаге
      if (pending && (lc === 'назад' || lc === 'back')) {
        if (pending.step === 'qresp') {
          await clearPending(chatId);
          await sendStep(chatId, { ...pending.s, step: 'q' });
        } else if (pending.step === 'phoneresp') {
          await clearPending(chatId);
          // снять reply-клавиатуру с кнопкой «Поделиться номером»
          await removeReplyKeyboard(chatId, '⬅️ Возврат к расчёту');
          await sendStep(chatId, { ...pending.s, step: 'done' });
        } else if (pending.step === 'commentresp') {
          // Назад к телефону
          await setPending(chatId, { step: 'phoneresp', s: { ...pending.s, phone: null } });
          await sendPhonePrompt(chatId);
        }
        return { statusCode: 200, body: 'ok' };
      }

      if (pending) {
        // Ввод точного количества
        if (pending.step === 'qresp') {
          const numStr = text.replace(/[\s.,' ]/g, '');
          const q = parseInt(numStr);
          if (!q || isNaN(q) || q < 1 || q > 100000) {
            await sendPrompt(chatId,
              '⚠️ Нужно число от 1 до 100 000. Попробуйте ещё раз — например: 750',
              'Например: 750');
            return { statusCode: 200, body: 'ok' };
          }
          const newS = { ...pending.s, q };
          newS.step = nextAfter(newS, 'q');
          await clearPending(chatId);
          await sendStep(chatId, newS);
          return { statusCode: 200, body: 'ok' };
        }

        // Ввод телефона
        if (pending.step === 'phoneresp') {
          const phoneDigits = normalizePhone(text);
          if (!phoneDigits) {
            await sendPrompt(chatId,
              '⚠️ Не похоже на телефон. Введите номер в формате +7 (999) 123-45-67 или просто 9991234567.\n<i>(или отправьте «назад», чтобы вернуться)</i>',
              '+7 (___) ___-__-__');
            return { statusCode: 200, body: 'ok' };
          }
          const newS = { ...pending.s, phone: phoneDigits };
          await setPending(chatId, { step: 'commentresp', s: newS });
          await sendPrompt(chatId,
            `📞 Телефон: <code>${formatPhone(phoneDigits)}</code>\n\n` +
            '📝 <b>Комментарий</b> (объём партии, особенности товара) — необязательно.\n\n' +
            'Напишите пару слов ИЛИ отправьте «<b>-</b>» чтобы пропустить.',
            'Пара слов о товаре или «-»');
          return { statusCode: 200, body: 'ok' };
        }

        // Ввод комментария
        if (pending.step === 'commentresp') {
          const skipWords = ['-', '—', '–', 'нет', 'no', 'skip', 'пропустить', 'пропуск', 'нету', 'без'];
          const comment = skipWords.includes(lc) ? '' : text;
          await clearPending(chatId);
          await sendToManager(chatId, pending.s, comment, upd.message.from);
          return { statusCode: 200, body: 'ok' };
        }
      }

      // Нет ни команды, ни pending — мягкая подсказка
      await tg('sendMessage', {
        chat_id: chatId,
        text: '👋 Чтобы рассчитать стоимость фулфилмента, отправьте /calc'
      });
      return { statusCode: 200, body: 'ok' };
    }

    // ────── НАЖАТИЯ INLINE-КНОПОК ──────
    else if (upd.callback_query) {
      const cq    = upd.callback_query;
      const data  = cq.data || '';
      const chatId= cq.message.chat.id;
      const msgId = cq.message.message_id;

      await tg('answerCallbackQuery', { callback_query_id: cq.id });

      if (data.startsWith('S|')) {
        const s = parse(data);

        // Любое нажатие кнопки — отменяем ожидание текстового ответа
        await clearPending(chatId);

        // Запрос точного количества
        if (s.step === 'qask') {
          await setPending(chatId, { step: 'qresp', s });
          await sendPrompt(chatId,
            `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]}\n\n` +
            '✏️ Введите <b>количество товара</b> числом (от 1 до 100 000):\n' +
            '<i>(или отправьте «назад», чтобы вернуться)</i>',
            'Например: 750');
          return { statusCode: 200, body: 'ok' };
        }

        // Запрос телефона (новое имя 'phoneask' и старое 'send' для совместимости)
        if (s.step === 'phoneask' || s.step === 'send') {
          await setPending(chatId, { step: 'phoneresp', s });
          await sendPhonePrompt(chatId);
          return { statusCode: 200, body: 'ok' };
        }

        // Обычные переходы — редактируем сообщение
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
