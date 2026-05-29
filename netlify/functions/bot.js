// Telegram-бот GoPack: интерактивный калькулятор + сбор контактов.
// Состояние диалога хранится в Netlify Blobs по chat_id.

const { getStore, connectLambda } = require('@netlify/blobs');

const TOKEN          = process.env.BOT_TOKEN;
const MANAGER_CHAT   = process.env.MANAGER_CHAT_ID || process.env.CHAT_ID;
const PENDING_TTL_MS = 30 * 60 * 1000;

// ──────────────── Справочники ────────────────
const mpNames    = { w:'Wildberries', o:'Ozon', y:'Яндекс Маркет' };
const tariffNames= { e:'Эконом', o:'Оптимальный', s:'Стандарт', p:'Премиум' };
const markNames  = { n:'не нужна', '1':'одинарная (+4 ₽/шт)', '2':'двойная (+8 ₽/шт)' };
const delivNames = { n:'не нужна', s:'до 1 м³', p:'паллет + стретч', c:'договорная' };

// Названия категорий упаковки (для multi-pack режима и для лейблов)
const typeNames = {
  v:'ВПП пакет', z:'Zip-Lock пакет', b:'БОПП пакет',
  u:'Пупырчатая плёнка', k:'Курьерский пакет',
  s:'Картонная коробка (самосборная)'
};

// Базовые цены для multi-pack режима (минимальная цена в категории)
const basicPackPrices = { v:3, z:15, b:18, u:15, k:15, s:15 };
const PREMIUM_PACK_LIMIT = 15; // ₽/шт — Премиум покрывает упаковку до этой суммы
const FIRST_CLIENT_DISCOUNT = 0.15; // 15% скидка первым клиентам

// Конкретные размеры — цены
const variantPrices = {
  v1:3, v2:8,
  z1:15, z2:15, z3:15, z4:17, z5:17, z6:20, z7:23, z8:30, z9:30, z10:38,
  b1:18, b2:20, b3:20, b4:21,
  u1:15, u2:30,
  k1:15, k2:18, k3:19, k4:20, k5:22, k6:26, k7:31, k8:34,
  s1:14, s2:20, s3:19, s4:23, s5:26, s6:33, s7:38
};

// Конкретные размеры — названия (для финального чека)
const variantNames = {
  v1:'ВПП пакет (материал заказчика)',
  v2:'ВПП пакет (материал включён)',
  z1:'Zip-Lock 80×120 мм, 45 мкм',
  z2:'Zip-Lock 100×100 мм, 45 мкм',
  z3:'Zip-Lock 100×150 мм, 45 мкм',
  z4:'Zip-Lock 70×100 мм, 60 мкм',
  z5:'Zip-Lock 150×200 мм, 45 мкм',
  z6:'Zip-Lock 120×180 мм, 60 мкм',
  z7:'Zip-Lock 150×200 мм, 60 мкм',
  z8:'Zip-Lock 180×250 мм, 70 мкм',
  z9:'Zip-Lock 300×400 мм, 45 мкм',
  z10:'Zip-Lock 200×300 мм, 80 мкм',
  b1:'БОПП 10×8 см', b2:'БОПП 15×12 см', b3:'БОПП 27×12 см', b4:'БОПП 38×15 см',
  u1:'Пупырка', u2:'Пупырка + пакет',
  k1:'Курьерский 100×150+40 мм', k2:'Курьерский 150×210+40 мм',
  k3:'Курьерский 165×240+40 мм', k4:'Курьерский 190×240+40 мм',
  k5:'Курьерский 240×320+40 мм', k6:'Курьерский 300×400+40 мм',
  k7:'Курьерский 340×460+40 мм', k8:'Курьерский 360×500+40 мм',
  s1:'Коробка самосб. 130×90×40 мм', s2:'Коробка самосб. 170×90×50 мм',
  s3:'Коробка самосб. 200×100×50 мм', s4:'Коробка самосб. 110×110×110 мм',
  s5:'Коробка самосб. 170×120×100 мм', s6:'Коробка самосб. 270×165×50 мм',
  s7:'Коробка самосб. 220×165×100 мм'
};

// Тарифные цены
const tariffPrices = {
  e: { 1:19, 100:16, 250:13, 500:10, 1000:7  },
  o: { 1:29, 100:25, 250:21, 500:17, 1000:13 },
  s: { 1:33, 100:29, 250:25, 500:21, 1000:17 },
  p: { 1:45, 100:42, 250:36, 500:30, 1000:25 }
};
const markPrices  = { '1':4, '2':8 };
const delivPrices = { s:2200, p:4900 };

function pricePerUnit(t, q) {
  const tbl = tariffPrices[t];
  if (q >= 1000) return tbl[1000];
  if (q >= 500)  return tbl[500];
  if (q >= 250)  return tbl[250];
  if (q >= 100)  return tbl[100];
  return tbl[1];
}

function packPerUnit(s) {
  if (!s.p || s.p === 'n') return 0;
  if (/\d/.test(s.p)) return variantPrices[s.p] || 0;
  let sum = 0;
  for (const ch of s.p) sum += (basicPackPrices[ch] || 0);
  return sum;
}
function packExtra(s) {
  let perUnit = packPerUnit(s);
  if (perUnit === 0) return 0;
  if (s.t === 'p') perUnit = Math.max(0, perUnit - PREMIUM_PACK_LIMIT);
  return perUnit * s.q;
}

function compute(s) {
  const per = pricePerUnit(s.t, s.q);
  const tariffTotal = per * s.q;
  let markE = 0;
  if (s.t === 'e' && s.l && s.l !== 'n') markE = markPrices[s.l] * s.q;
  const packE = packExtra(s);
  const delivE = delivPrices[s.d] || 0;
  const subtotal = tariffTotal + markE + packE + delivE;
  const discount = Math.round(subtotal * FIRST_CLIENT_DISCOUNT);
  const total = subtotal - discount;
  const isCustom = s.d === 'c' || s.q >= 5000;
  const prefix = isCustom ? '≈ ' : '';
  return {
    per, tariffTotal, markE, packE, delivE, subtotal, discount, total,
    subtotalStr: prefix + subtotal.toLocaleString('ru') + ' ₽',
    discountStr: '−' + discount.toLocaleString('ru') + ' ₽',
    totalStr:    prefix + total.toLocaleString('ru') + ' ₽'
  };
}

function packLabel(s) {
  if (!s.p)         return 'не указано';
  if (s.p === 'n')  return 'без упаковки';
  let baseName;
  if (variantNames[s.p]) baseName = variantNames[s.p];
  else if (s.p.length === 1) baseName = typeNames[s.p] || s.p;
  else baseName = [...s.p].map(c => typeNames[c] || c).join(' + ');
  if (s.t === 'p') {
    const extra = Math.max(0, packPerUnit(s) - PREMIUM_PACK_LIMIT);
    return extra === 0
      ? `${baseName} (включена в Премиум)`
      : `${baseName} (+${extra} ₽/шт сверх лимита ${PREMIUM_PACK_LIMIT} ₽)`;
  }
  return baseName;
}

function togglePack(current, ch) {
  const cur = (!current || current === 'n' || /\d/.test(current)) ? '' : current;
  if (cur.includes(ch)) {
    const next = cur.replace(ch, '');
    return next || null;
  }
  return cur + ch;
}

// ──────────────── State encoding ────────────────
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

// ──────────────── Blobs pending state ────────────────
let lastError = null;
function store() {
  const opts = { name: 'bot-pending', consistency: 'strong' };
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
  if (siteID && token) { opts.siteID = siteID; opts.token = token; }
  return getStore(opts);
}
async function setPending(chatId, data) {
  try { await store().setJSON('chat:' + chatId, { ...data, ts: Date.now() }); }
  catch (e) { lastError = 'setPending: ' + e.message; }
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
  try { await store().delete('chat:' + chatId); }
  catch (e) { lastError = 'clearPending: ' + e.message; }
}

// ──────────────── Навигация ────────────────
function nextAfter(s, cur) {
  if (cur === 'm') return 't';
  if (cur === 't') return 'q';
  if (cur === 'q') {
    if (s.t === 'e') return 'l';
    return 'p';
  }
  if (cur === 'l') return 'p';
  if (cur === 'p') return 'd';
  if (cur === 'd') return 'done';
}

// Соответствие типа упаковки → имя sub-step
const PACK_SUBSTEPS = { v:'pvpp', z:'pzip', b:'pbopp', u:'pbubble', k:'pcour', s:'psbox' };

function backFrom(s, cur) {
  if (cur === 't')    return { ...s, m:null, step:'m' };
  if (cur === 'q')    return { ...s, t:null, step:'t' };
  if (cur === 'l')    return { ...s, q:null, step:'q' };
  if (cur === 'p') {
    if (s.t === 'e')  return { ...s, l:null, step:'l' };
    return                    { ...s, q:null, step:'q' };
  }
  if (cur === 'pm')   return { ...s, p:null, step:'p' };
  if (['pvpp','pzip','pbopp','pbubble','pcour','psbox'].includes(cur)) {
    return                    { ...s, p:null, step:'p' };
  }
  if (cur === 'd') {
    // Конкретный вариант — назад в соответствующий sub-step
    if (s.p && /\d/.test(s.p)) {
      const sub = PACK_SUBSTEPS[s.p[0]];
      if (sub) return { ...s, step: sub };
    }
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
        text: '👋 <b>Здравствуйте!</b>\n\nЯ помогу рассчитать стоимость фулфилмента в GoPack за минуту.\n\n🎁 <b>Первым клиентам — скидка 15%</b> на первый заказ.\n\nВыберите <b>маркетплейс</b>:',
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
          [{ text: 'Эконом — от 7 ₽/шт',           callback_data: enc({...s, t:'e'}, 'q') }],
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
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\n<b>Тип упаковки</b>?` +
          (s.t === 'p' ? `\n<i>Премиум: до ${PREMIUM_PACK_LIMIT} ₽/шт включено, сверх — по разнице</i>` : ''),
        keyboard: [
          [{ text: 'Без упаковки',          callback_data: enc({...s, p:'n'}, 'd') }],
          [{ text: 'ВПП пакет →',           callback_data: enc({...s, p:null}, 'pvpp') }],
          [{ text: 'Zip-Lock пакет →',      callback_data: enc({...s, p:null}, 'pzip') }],
          [{ text: 'БОПП пакет →',          callback_data: enc({...s, p:null}, 'pbopp') }],
          [{ text: 'Пупырчатая плёнка →',   callback_data: enc({...s, p:null}, 'pbubble') }],
          [{ text: 'Курьерский пакет →',    callback_data: enc({...s, p:null}, 'pcour') }],
          [{ text: '📦 Самосборная коробка →', callback_data: enc({...s, p:null}, 'psbox') }],
          [{ text: '➕ Несколько типов упаковки', callback_data: enc({...s, p:null}, 'pm') }],
          navRow(s, 'p')
        ]
      };

    case 'pvpp':
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\nВПП пакет — <b>выберите вариант</b>:`,
        keyboard: [
          [{ text: 'Материал заказчика (+3 ₽)',  callback_data: enc({...s, p:'v1'}, 'd') }],
          [{ text: 'Материал включён (+8 ₽)',    callback_data: enc({...s, p:'v2'}, 'd') }],
          navRow(s, 'pvpp')
        ]
      };

    case 'pzip':
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\nZip-Lock пакет — <b>выберите размер</b>:`,
        keyboard: [
          [{ text: '80×120 мм, 45 мкм (+15 ₽)',  callback_data: enc({...s, p:'z1'},  'd') }],
          [{ text: '100×100 мм, 45 мкм (+15 ₽)', callback_data: enc({...s, p:'z2'},  'd') }],
          [{ text: '100×150 мм, 45 мкм (+15 ₽)', callback_data: enc({...s, p:'z3'},  'd') }],
          [{ text: '70×100 мм, 60 мкм (+17 ₽)',  callback_data: enc({...s, p:'z4'},  'd') }],
          [{ text: '150×200 мм, 45 мкм (+17 ₽)', callback_data: enc({...s, p:'z5'},  'd') }],
          [{ text: '120×180 мм, 60 мкм (+20 ₽)', callback_data: enc({...s, p:'z6'},  'd') }],
          [{ text: '150×200 мм, 60 мкм (+23 ₽)', callback_data: enc({...s, p:'z7'},  'd') }],
          [{ text: '180×250 мм, 70 мкм (+30 ₽)', callback_data: enc({...s, p:'z8'},  'd') }],
          [{ text: '300×400 мм, 45 мкм (+30 ₽)', callback_data: enc({...s, p:'z9'},  'd') }],
          [{ text: '200×300 мм, 80 мкм (+38 ₽)', callback_data: enc({...s, p:'z10'}, 'd') }],
          navRow(s, 'pzip')
        ]
      };

    case 'pbopp':
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\nБОПП пакет — <b>выберите размер</b>:`,
        keyboard: [
          [{ text: '10×8 см (+18 ₽)',  callback_data: enc({...s, p:'b1'}, 'd') }],
          [{ text: '15×12 см (+20 ₽)', callback_data: enc({...s, p:'b2'}, 'd') }],
          [{ text: '27×12 см (+20 ₽)', callback_data: enc({...s, p:'b3'}, 'd') }],
          [{ text: '38×15 см (+21 ₽)', callback_data: enc({...s, p:'b4'}, 'd') }],
          navRow(s, 'pbopp')
        ]
      };

    case 'pbubble':
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\nПупырчатая плёнка — <b>выберите вариант</b>:`,
        keyboard: [
          [{ text: 'Пупырка (+15 ₽)',         callback_data: enc({...s, p:'u1'}, 'd') }],
          [{ text: 'Пупырка + пакет (+30 ₽)', callback_data: enc({...s, p:'u2'}, 'd') }],
          navRow(s, 'pbubble')
        ]
      };

    case 'pcour':
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\nКурьерский пакет — <b>выберите размер</b>:`,
        keyboard: [
          [{ text: '100×150+40 мм (+15 ₽)', callback_data: enc({...s, p:'k1'}, 'd') }],
          [{ text: '150×210+40 мм (+18 ₽)', callback_data: enc({...s, p:'k2'}, 'd') }],
          [{ text: '165×240+40 мм (+19 ₽)', callback_data: enc({...s, p:'k3'}, 'd') }],
          [{ text: '190×240+40 мм (+20 ₽)', callback_data: enc({...s, p:'k4'}, 'd') }],
          [{ text: '240×320+40 мм (+22 ₽)', callback_data: enc({...s, p:'k5'}, 'd') }],
          [{ text: '300×400+40 мм (+26 ₽)', callback_data: enc({...s, p:'k6'}, 'd') }],
          [{ text: '340×460+40 мм (+31 ₽)', callback_data: enc({...s, p:'k7'}, 'd') }],
          [{ text: '360×500+40 мм (+34 ₽)', callback_data: enc({...s, p:'k8'}, 'd') }],
          navRow(s, 'pcour')
        ]
      };

    case 'psbox':
      return {
        text: `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\nСамосборная коробка — <b>выберите размер</b>:`,
        keyboard: [
          [{ text: '130×90×40 мм (+14 ₽)',   callback_data: enc({...s, p:'s1'}, 'd') }],
          [{ text: '170×90×50 мм (+20 ₽)',   callback_data: enc({...s, p:'s2'}, 'd') }],
          [{ text: '200×100×50 мм (+19 ₽)',  callback_data: enc({...s, p:'s3'}, 'd') }],
          [{ text: '110×110×110 мм (+23 ₽)', callback_data: enc({...s, p:'s4'}, 'd') }],
          [{ text: '170×120×100 мм (+26 ₽)', callback_data: enc({...s, p:'s5'}, 'd') }],
          [{ text: '270×165×50 мм (+33 ₽)',  callback_data: enc({...s, p:'s6'}, 'd') }],
          [{ text: '220×165×100 мм (+38 ₽)', callback_data: enc({...s, p:'s7'}, 'd') }],
          navRow(s, 'psbox')
        ]
      };

    case 'pm': {
      const current = (s.p && s.p !== 'n' && !/\d/.test(s.p)) ? s.p : '';
      const items = [
        { ch:'v', name:'ВПП (+3 ₽)' },
        { ch:'z', name:'Zip-Lock (+15 ₽)' },
        { ch:'b', name:'БОПП (+18 ₽)' },
        { ch:'u', name:'Пупырка (+15 ₽)' },
        { ch:'k', name:'Курьерский (+15 ₽)' },
        { ch:'s', name:'Самосборная (+15 ₽)' }
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
        for (const ch of current) sum += (basicPackPrices[ch] || 0);
        rows.push([{
          text: `✓ Готово (упаковка: +${sum} ₽/шт)`,
          callback_data: enc(s, 'd')
        }]);
      }
      rows.push(navRow(s, 'pm'));
      const sel = current ? [...current].map(c => typeNames[c]).join(' + ') : 'пока ничего не выбрано';
      return {
        text:
          `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]} · ${s.q} шт.\n\n` +
          '<b>Несколько типов упаковки</b>\n' +
          'Клик по варианту — добавить/убрать. Цены складываются (базовые).\n\n' +
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
          `Подытог: ${c.subtotalStr}\n` +
          `🎁 Скидка первым клиентам −15%: ${c.discountStr}\n` +
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

async function sendPhonePrompt(chatId) {
  await tg('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
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

async function removeReplyKeyboard(chatId, text) {
  await tg('sendMessage', {
    chat_id: chatId, text: text || '⬅️',
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
      `Подытог: ${c.subtotalStr}\n` +
      `🎁 Скидка первым клиентам −15%: ${c.discountStr}\n` +
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
  try { connectLambda(event); } catch (e) { lastError = 'connectLambda: ' + e.message; }

  if (event.httpMethod !== 'POST') return { statusCode: 200, body: 'ok' };
  if (!TOKEN || !MANAGER_CHAT)     return { statusCode: 200, body: 'not configured' };

  let upd;
  try { upd = JSON.parse(event.body); }
  catch { return { statusCode: 200, body: 'bad json' }; }

  try {
    // ────── КОНТАКТ ──────
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

      // Команды старта
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

      // Диагностика
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
        report += '\n\n📦 pending: ' + (pending ? JSON.stringify(pending) : 'нет');
        await tg('sendMessage', { chat_id: chatId, text: report, parse_mode: 'HTML' });
        return { statusCode: 200, body: 'ok' };
      }

      const pending = await getPending(chatId);

      // Универсальное «назад»
      if (pending && (lc === 'назад' || lc === 'back')) {
        if (pending.step === 'qresp') {
          await clearPending(chatId);
          await sendStep(chatId, { ...pending.s, step: 'q' });
        } else if (pending.step === 'phoneresp') {
          await clearPending(chatId);
          await removeReplyKeyboard(chatId, '⬅️ Возврат к расчёту');
          await sendStep(chatId, { ...pending.s, step: 'done' });
        } else if (pending.step === 'commentresp') {
          await setPending(chatId, { step: 'phoneresp', s: { ...pending.s, phone: null } });
          await sendPhonePrompt(chatId);
        }
        return { statusCode: 200, body: 'ok' };
      }

      if (pending) {
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

        if (pending.step === 'phoneresp') {
          const phoneDigits = normalizePhone(text);
          if (!phoneDigits) {
            await sendPrompt(chatId,
              '⚠️ Не похоже на телефон. Введите номер в формате +7 (999) 123-45-67 или 9991234567.\n<i>(или отправьте «назад» чтобы вернуться)</i>',
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

        if (pending.step === 'commentresp') {
          const skipWords = ['-', '—', '–', 'нет', 'no', 'skip', 'пропустить', 'пропуск', 'нету', 'без'];
          const comment = skipWords.includes(lc) ? '' : text;
          await clearPending(chatId);
          await sendToManager(chatId, pending.s, comment, upd.message.from);
          return { statusCode: 200, body: 'ok' };
        }
      }

      await tg('sendMessage', {
        chat_id: chatId,
        text: '👋 Чтобы рассчитать стоимость фулфилмента, отправьте /calc'
      });
      return { statusCode: 200, body: 'ok' };
    }

    // ────── INLINE-КНОПКИ ──────
    else if (upd.callback_query) {
      const cq    = upd.callback_query;
      const data  = cq.data || '';
      const chatId= cq.message.chat.id;
      const msgId = cq.message.message_id;

      await tg('answerCallbackQuery', { callback_query_id: cq.id });

      if (data.startsWith('S|')) {
        const s = parse(data);
        await clearPending(chatId);

        if (s.step === 'qask') {
          await setPending(chatId, { step: 'qresp', s });
          await sendPrompt(chatId,
            `🛒 ${mpNames[s.m]} · 📦 ${tariffNames[s.t]}\n\n` +
            '✏️ Введите <b>количество товара</b> числом (от 1 до 100 000):\n' +
            '<i>(или отправьте «назад», чтобы вернуться)</i>',
            'Например: 750');
          return { statusCode: 200, body: 'ok' };
        }

        if (s.step === 'phoneask' || s.step === 'send') {
          await setPending(chatId, { step: 'phoneresp', s });
          await sendPhonePrompt(chatId);
          return { statusCode: 200, body: 'ok' };
        }

        const step = buildStep(s);
        await tg('editMessageText', {
          chat_id: chatId, message_id: msgId, text: step.text, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: step.keyboard }
        });
      }
    }
  } catch (e) {
    // глотаем ошибки чтобы Telegram не ретраил
  }

  return { statusCode: 200, body: 'ok' };
};
