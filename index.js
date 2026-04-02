const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// ============================================================
// CONFIG
// ============================================================
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// ============================================================
// STOCK EN MEMORIA
// Se carga via POST /update-stock desde el script local
// ============================================================
let stockData = [];
let stockLastUpdated = null;

const CONDITION_LABELS = {
  'GA+':      { emoji: '⭐', label: 'GA+',      desc: 'Like new' },
  'GA':       { emoji: '✅', label: 'GA',       desc: 'Grade A' },
  'GA-':      { emoji: '🔵', label: 'GA-',      desc: 'Grade A-' },
  'GAB':      { emoji: '🟡', label: 'GAB',      desc: 'Grade A/B' },
  'GB':       { emoji: '🟠', label: 'GB',       desc: 'Grade B' },
  'IND':      { emoji: '🆕', label: 'IND',      desc: 'India (SIM Card)' },
  'USA ESIM': { emoji: '🇺🇸', label: 'USA eSIM', desc: 'USA eSIM' },
  'JP ESIM':  { emoji: '🇯🇵', label: 'JP eSIM',  desc: 'Japan eSIM' },
  'BES':      { emoji: '🌎', label: 'BES',      desc: 'BES SIM Card' },
};

function extractCondition(desc) {
  const d = desc.toUpperCase();
  if (d.includes('BES SIM'))                               return 'BES';
  if (d.includes('USA ESIM') || d.includes('USA - ESIM')) return 'USA ESIM';
  if (d.includes('JP ESIM')  || d.includes('JP- ESIM'))   return 'JP ESIM';
  if (d.includes('IND') && d.includes('SIM'))              return 'IND';
  if (d.includes('GA+'))                                   return 'GA+';
  if (d.includes('- GA-') || d.includes('-GA-'))           return 'GA-';
  if (d.includes('- GA')  || d.includes('-GA'))            return 'GA';
  if (d.includes('GAB'))                                   return 'GAB';
  if (d.includes('- GB')  || d.includes('-GB'))            return 'GB';
  return 'GA';
}

function parseStockFromRows(rows) {
  const result = [];
  for (const row of rows) {
    const [mfr, desc, qty, transit] = row;
    if (!mfr || mfr === 'MFR') continue;
    result.push({
      mfr: String(mfr).trim(),
      desc: String(desc || '').trim(),
      qty: Number(qty) || 0,
      transit: Number(transit) || 0,
      condition: extractCondition(String(desc || '')),
    });
  }
  return result;
}

function searchStock(query) {
  if (stockData.length === 0) return null;
  const q = query.toUpperCase();

  const modelMap = [
    { kws: ['IPHONE 17 PRO MAX'] },
    { kws: ['IPHONE 17 PRO'] },
    { kws: ['IPHONE 17'] },
    { kws: ['IPHONE 16 PRO MAX'] },
    { kws: ['IPHONE 16 PRO'] },
    { kws: ['IPHONE 16'] },
    { kws: ['IPHONE 15 PRO MAX'] },
    { kws: ['IPHONE 15 PRO'] },
    { kws: ['IPHONE 15'] },
    { kws: ['IPHONE 14'] },
    { kws: ['IPHONE 13'] },
    { kws: ['S26 ULTRA'] },
    { kws: ['S25 ULTRA'] },
    { kws: ['SAMSUNG', 'GALAXY'] },
    { kws: ['MACBOOK'] },
    { kws: ['AIRPODS PRO'] },
    { kws: ['AIRPODS'] },
    { kws: ['IPAD'] },
    { kws: ['APPLE WATCH', 'WATCH ULTRA'] },
  ];

  let matched = [];
  for (const { kws } of modelMap) {
    if (kws.some(k => q.includes(k))) {
      matched = stockData.filter(item => kws.some(k => item.desc.toUpperCase().includes(k)));
      break;
    }
  }

  if (matched.length === 0) {
    const words = q.split(/\s+/).filter(w => w.length > 2);
    matched = stockData.filter(item => words.some(w => item.desc.toUpperCase().includes(w)));
  }

  // Filtro storage
  const storageMatch = q.match(/(\d{2,4})\s*GB/);
  if (storageMatch) {
    const gb = storageMatch[1];
    const filtered = matched.filter(item => item.desc.toUpperCase().includes(gb + 'GB'));
    if (filtered.length > 0) matched = filtered;
  }

  // Filtro color
  const COLORS = ['BLACK','WHITE','BLUE','SILVER','NATURAL','DESERT','STARLIGHT',
                  'MIDNIGHT','PURPLE','RED','PINK','TEAL','YELLOW','ULTRAMARINE',
                  'ORANGE','COSMIC ORANGE','DEEP BLUE','MIST BLUE','VIOLET','GRAY'];
  for (const color of COLORS) {
    if (q.includes(color)) {
      const filtered = matched.filter(item => item.desc.toUpperCase().includes(color));
      if (filtered.length > 0) matched = filtered;
    }
  }

  // Filtro condicion
  const condMap = {
    'GA+': ['GA+'], 'GA-': ['GA-'], 'GAB': ['GAB'], ' GB': ['GB'],
    'USA ESIM': ['USA ESIM'], 'JP ESIM': ['JP ESIM'], 'BES': ['BES'], 'IND': ['IND'],
  };
  for (const [keyword, conds] of Object.entries(condMap)) {
    if (q.includes(keyword)) {
      const filtered = matched.filter(item => conds.includes(item.condition));
      if (filtered.length > 0) matched = filtered;
    }
  }

  return matched;
}

function formatStockResponse(items, query) {
  if (items === null) {
    return '⚠️ El stock no está cargado todavía. Escribime directamente y te ayudo.';
  }

  const available = items.filter(item => item.qty > 0 || item.transit > 0);

  if (available.length === 0) {
    return '❌ *Sin stock* para ese modelo en este momento.\n\nDejame tu contacto y te aviso cuando entre 📲';
  }

  const date = stockLastUpdated
    ? stockLastUpdated.toLocaleDateString('es-AR')
    : new Date().toLocaleDateString('es-AR');

  const lines = ['📦 *STOCK DISPONIBLE*\n'];
  const shown = available.slice(0, 12);

  for (const item of shown) {
    const cond = CONDITION_LABELS[item.condition] || { emoji: '•', label: item.condition };
    const stockTxt = item.qty > 0 ? item.qty + ' u' : 'Sin stock';
    const transitTxt = item.transit > 0 ? ' _(' + item.transit + ' en tránsito)_' : '';
    lines.push(cond.emoji + ' *' + item.desc + '*');
    lines.push('   ' + cond.label + ' — ' + stockTxt + transitTxt + '\n');
  }

  if (available.length > 12) {
    lines.push('_...' + (available.length - 12) + ' variantes más. Especificá color o storage para filtrar._');
  }

  lines.push('\n📅 _Stock al ' + date + '_');
  return lines.join('\n');
}

// ============================================================
// PRECIOS
// ============================================================
const PRICE_LIST = `💰 *LISTA DE PRECIOS - SOUTH TRADERS*

── 📱 IPHONE 17 ──
• iPhone Air 256GB US Specs: $850
• iPhone 17e 256GB US Specs: $545
• iPhone 17 256GB: $780
• iPhone 17 Pro 256GB: $1,050
• iPhone 17 Pro 512GB: $1,160
• iPhone 17 Pro Max 256GB: $1,150
• iPhone 17 Pro Max 512GB: $1,260
• iPhone 17 Pro Max 1TB: $1,420

── 📱 IPHONE 16 ──
• iPhone 16 128GB: $640
• iPhone 16 Pro 128GB: $850
• iPhone 16 Pro 256GB: $960

── 📱 IPHONE 15 ──
• iPhone 15 128GB: $530
• iPhone 15 Pro 128GB: $720

── 🤖 SAMSUNG ──
• Galaxy S25 Ultra 512GB: $1,070
• Galaxy S26 Ultra 512GB: $1,170

── 💻 MACBOOK ──
• MacBook Air 13" M5 16GB/512GB: $1,060
• MacBook Air 15" M4: $1,200

── 🎧 ACCESORIOS ──
• AirPods 4: $145
• AirPods Pro 3: $210
• Apple Watch Ultra 3: consultar

_Precios en USD · Mínimo 5 unidades_`;

// ============================================================
// SESIONES
// ============================================================
const sessions = {};
function getSession(from) {
  if (!sessions[from]) sessions[from] = { step: 'init' };
  return sessions[from];
}

// ============================================================
// MENSAJERIA
// ============================================================
async function sendMessage(to, text) {
  try {
    await axios.post(
      'https://graph.facebook.com/v19.0/' + PHONE_NUMBER_ID + '/messages',
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Error enviando mensaje:', err.response?.data || err.message);
  }
}

// ============================================================
// MENU
// ============================================================
const MENU = `🏪 *SOUTH TRADERS*
Mayorista de electrónica — Miami, FL

¿En qué te puedo ayudar?

1️⃣ Precios
2️⃣ Stock disponible
3️⃣ Modelos y especificaciones
4️⃣ Cómo comprar / mínimos
5️⃣ Ubicación
6️⃣ Contacto directo

_Respondé con el número de opción o preguntame directamente_`;

const HOW_TO_BUY = `🛒 *CÓMO COMPRAR*

📦 *Mínimo:* 5 unidades por modelo
💵 *Pago:* Wire transfer / Zelle / Crypto
🚚 *Envío:* Desde Miami — coordinamos logística
✅ *Garantía:* Según condición del equipo

Para hacer un pedido, decime:
• Modelo
• Cantidad
• Destino de envío`;

const LOCATION = `📍 *SOUTH TRADERS*
10850 NW 21st St, Suite 140
Miami, FL 33172, USA

🕐 Lunes a Viernes: 9am – 6pm ET
📞 +1 786 909 0198`;

// ============================================================
// PROCESAMIENTO
// ============================================================
async function handleMessage(from, text) {
  const msg = text.trim().toLowerCase();

  // Saludos
  const greetings = ['hola','hello','hi','hey','buenos dias','buenas','good morning','start','inicio','menu'];
  if (greetings.some(g => msg === g || msg.startsWith(g + ' '))) {
    await sendMessage(from, MENU);
    return;
  }

  // Opcion 1 - Precios
  if (msg === '1' || msg.includes('precio') || msg.includes('price') || msg.includes('lista')) {
    await sendMessage(from, PRICE_LIST);
    return;
  }

  // Opcion 2 - Stock general
  if (msg === '2' || msg === 'stock' || msg === 'disponible') {
    if (stockData.length === 0) {
      await sendMessage(from, '📦 El stock se actualiza diariamente.\nEscribime qué modelo buscás y te confirmo disponibilidad 👍');
    } else {
      await sendMessage(from, '📦 *STOCK*\n\n¿Qué modelo buscás? Ejemplos:\n\n• _"stock iphone 17 pro max"_\n• _"hay samsung s26 ultra"_\n• _"macbook m5"_\n\nPreguntame directamente 👇');
    }
    return;
  }

  // Busqueda de stock por modelo (deteccion automatica)
  const stockKeywords = ['iphone','samsung','galaxy','macbook','airpods','ipad','apple watch','s26','s25','i17','i16','i15','i14'];
  const isStockQuery = stockKeywords.some(k => msg.includes(k));

  if (isStockQuery) {
    if (stockData.length === 0) {
      await sendMessage(from, '📦 Consultame directamente por disponibilidad, actualizamos el stock a diario.');
    } else {
      const results = searchStock(msg);
      await sendMessage(from, formatStockResponse(results, text));
    }
    return;
  }

  // Opcion 3 - Modelos
  if (msg === '3' || msg.includes('modelo') || msg.includes('spec')) {
    await sendMessage(from, `📱 *MODELOS DISPONIBLES*

*iPhone 17 Series* (2025)
• Air · 17e · 17 · 17 Pro · 17 Pro Max

*iPhone 16 Series*
• 16 · 16 Plus · 16 Pro · 16 Pro Max

*iPhone 15 Series*
• 15 · 15 Plus · 15 Pro · 15 Pro Max

*Samsung Galaxy*
• S25 Ultra · S26 Ultra (2025)

*MacBook*
• Air 13" M5 · Air 15" M4

*Accesorios*
• AirPods 4 · AirPods Pro 3 · Apple Watch Ultra 3`);
    return;
  }

  // Opcion 4 - Como comprar
  if (msg === '4' || msg.includes('comprar') || msg.includes('pedido') || msg.includes('minimo')) {
    await sendMessage(from, HOW_TO_BUY);
    return;
  }

  // Opcion 5 - Ubicacion
  if (msg === '5' || msg.includes('ubicacion') || msg.includes('direccion') || msg.includes('address')) {
    await sendMessage(from, LOCATION);
    return;
  }

  // Opcion 6 - Contacto
  if (msg === '6' || msg.includes('contacto') || msg.includes('hablar') || msg.includes('asesor')) {
    await sendMessage(from, '📲 *CONTACTO DIRECTO*\n\nWhatsApp: +1 786 909 0198\nEmail: info@southtraders.com\n\nPara pedidos grandes, comunicate directamente con nuestro equipo.');
    return;
  }

  // Fallback
  await sendMessage(from, '🤔 No entendí bien.\n\nPodés preguntar por:\n• _"stock iphone 17 pro max"_\n• _"precio samsung s26"_\n\nO escribí *menu* para ver todas las opciones.');
}

// ============================================================
// WEBHOOK
// ============================================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
  if (!messages || messages.length === 0) return;
  const message = messages[0];
  if (message.type === 'text') {
    console.log('[MSG] ' + message.from + ': ' + message.text?.body);
    await handleMessage(message.from, message.text?.body || '');
  }
});

// ============================================================
// ENDPOINT ACTUALIZAR STOCK
// POST /update-stock  body: { rows: [[mfr, desc, qty, transit], ...] }
// ============================================================
app.post('/update-stock', (req, res) => {
  const secret = req.headers['x-secret'];
  if (process.env.UPDATE_SECRET && secret !== process.env.UPDATE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { rows } = req.body;
  if (!rows || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'rows array required' });
  }
  stockData = parseStockFromRows(rows);
  stockLastUpdated = new Date();
  console.log('Stock actualizado: ' + stockData.length + ' items');
  res.json({ ok: true, items: stockData.length, updated: stockLastUpdated });
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'South Traders WhatsApp Bot',
    stock: { loaded: stockData.length > 0, items: stockData.length, lastUpdated: stockLastUpdated }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('South Traders WhatsApp Bot running on port ' + PORT));
