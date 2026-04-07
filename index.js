const express = require('express');
const path = require('path');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_PHONE = process.env.OWNER_PHONE || '17865591119';
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL ? { rejectUnauthorized: false } : false });

async function initDB() {
  await pool.query('CREATE TABLE IF NOT EXISTS conversations (phone TEXT, role TEXT, content TEXT, ts TIMESTAMPTZ DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS crm_contacts (id SERIAL PRIMARY KEY, phone TEXT UNIQUE, name TEXT, country TEXT, company TEXT, interest TEXT, tier TEXT DEFAULT \'lead\', status TEXT DEFAULT \'new\', notes TEXT, last_contact TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT FALSE');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT \'tier1\'');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS registered BOOLEAN DEFAULT FALSE');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS logistics TEXT');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS pending_order BOOLEAN DEFAULT FALSE');
  await pool.query('CREATE TABLE IF NOT EXISTS outbound_campaigns (id SERIAL PRIMARY KEY, name TEXT, message TEXT, status TEXT DEFAULT \'pending\', created_at TIMESTAMPTZ DEFAULT NOW(), total_sent INT DEFAULT 0, total_failed INT DEFAULT 0)');
  await pool.query('CREATE TABLE IF NOT EXISTS outbound_logs (id SERIAL PRIMARY KEY, campaign_id INT, phone TEXT, status TEXT DEFAULT \'pending\', sent_at TIMESTAMPTZ, error TEXT)');
  console.log('DB OK');
}

async function loadConversation(phone) {
  try {
    const r = await pool.query('SELECT role, content, ts FROM conversations WHERE phone=$1 ORDER BY ts DESC LIMIT 10', [phone]);
    return r.rows.reverse();
  } catch(e) { return []; }
}

async function saveMessage(phone, role, content) {
  try { await pool.query('INSERT INTO conversations (phone, role, content) VALUES ($1,$2,$3)', [phone, role, content]); } catch(e) {}
}

async function upsertContact(phone) {
  try {
    const country = detectCountry(phone);
    await pool.query(
      'INSERT INTO crm_contacts (phone, country) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET last_contact=NOW()',
      [phone, country]
    );
  } catch(e) {}
}

// STOCK
let stockData = [];
let stockLastUpdated = null;

async function fetchStock() {
  try {
    const resp = await axios.get('https://south-traders.pangea.ar/n6/stock_disp', { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const rows = [];
    const trRe = /<tr[^>]*>([sS]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(resp.data)) !== null) {
      const cells = [];
      const tdRe = /<td[^>]*>([sS]*?)<\/td>/gi;
      let td;
      while ((td = tdRe.exec(tr[1])) !== null) cells.push(td[1].replace(/<[^>]+>/g,'').trim());
      if (cells.length >= 3 && cells[0] && cells[1]) rows.push({ desc: cells[1], qty: parseInt(cells[2])||0, transit: parseInt(cells[3])||0 });
    }
    if (rows.length > 0) { stockData = rows; stockLastUpdated = new Date(); console.log('Stock OK: ' + rows.length); }
  } catch(e) { console.error('Stock error:', e.message); }
}

fetchStock();
setInterval(fetchStock, 6 * 3600 * 1000);

function getStockSummary() {
  if (!stockData.length) return 'Stock actualizandose.';
  const nuevos = stockData.filter(function(i) { return i.qty > 0 && !/\s[-]\s*(GA\+?-?|GAB|GB|IND)$/i.test(i.desc); });
  const grupos = {};
  for (let i = 0; i < nuevos.length; i++) {
    const item = nuevos[i];
    const base = item.desc.replace(/\s+(BLACK|BLUE|PINK|WHITE|GREEN|YELLOW|RED|PURPLE|SILVER|GOLD|STARLIGHT|MIDNIGHT|NATURAL|DESERT|TEAL|CREAM|SAND|STORM|TITANIUM|ULTRAMARINE|BURGUNDY|GRAPHITE)(\s.*)?$/i,'').trim();
    if (!grupos[base]) grupos[base] = 0;
    grupos[base] += item.qty;
  }
  const lines = ['STOCK NUEVOS SIN ACTIVAR (distribuidor oficial Apple):'];
  const keys = Object.keys(grupos);
  for (let i = 0; i < keys.length; i++) {
    lines.push('- ' + keys[i] + ': ' + grupos[keys[i]] + 'u');
  }
  const totalRefu = stockData.filter(function(i) { return i.qty > 0 && /\s[-]\s*(GA\+?-?|GAB|GB)$/i.test(i.desc); }).reduce(function(s,i) { return s+i.qty; }, 0);
  if (totalRefu > 0) lines.push('REFU/USADOS: ' + totalRefu + 'u disponibles (precios a consultar)');
  lines.push('Ver stock completo: https://south-traders.pangea.ar/n6/stock_disp#');
  return lines.join('\n');
}

function buildPrompt() {
  return 'Sos Sophia, agente comercial de South Traders — distribuidor oficial Apple en Miami.\n\n' +
    'PERSONALIDAD:\n' +
    '- Mujer profesional, segura, con carisma y calidez genuina\n' +
    '- Nunca robotica. Haces sentir al cliente especial.\n\n' +
    'EMPRESA:\n' +
    '- Somos distribuidor oficial Apple. Tenemos iPhones, MacBooks, Samsung y accesorios.\n' +
    '- Mayoristas para LATAM, El Caribe y el mundo.\n' +
    '- Pago: Wire transfer in advance\n' +
    '- Horario: Lun-Vie 9am-6pm ET\n' +
    '- Contacto: +1 786 559 1119 | sales@south-traders.com\n' +
    '- Direccion: 10850 NW 21st St, Suite 140, Miami FL 33172\n\n' +
    'LOGISTICA:\n' +
    '- FOB Miami (el cliente coordina el flete)\n' +
    '- Delivery GRATIS en Doral para ordenes +$30,000 USD\n' +
    '- Pickup en warehouse disponible\n' +
    '- Pueden enviar a alguien a verificar mercaderia al warehouse si lo solicitan\n\n' +
    'PRODUCTOS:\n' +
    '- Articulos SIN sufijo de grado son nuevos. Solo aclararlo si preguntan.\n' +
    '- USADOS/REFU: sufijo GA, GA-, GAB, GB. Precios a consultar.\n' +
    '- Stock: https://south-traders.pangea.ar/n6/stock_disp#\n\n' +
    'PRECIOS USD - Lista cash para clientes nuevos:\n' +
    'iPhone Air 256GB $850 | 17e $545 | 17 256GB $780\n' +
    'iPhone 17 Pro: 256GB $1050 | 512GB $1160 | 1TB $1300\n' +
    'iPhone 17 Pro Max: 256GB $1150 | 512GB $1260 | 1TB $1420\n' +
    'iPhone 16 128GB $640 | 16 Pro 128GB $850 | 256GB $960\n' +
    'iPhone 15 128GB $530 | 15 Pro 128GB $720\n' +
    'Samsung S25 Ultra 512GB $1070 | S26 Ultra 512GB $1170\n' +
    'MacBook Air 13 M5 $1060 | 15 M4 $1200\n' +
    'AirPods 4 $145 | AirPods Pro 3 $210\n\n' +
    'CREDITO:\n' +
    '- Sin credito para clientes nuevos\n' +
    '- Luego de trabajar juntos pueden aplicar. Precios a credito son distintos.\n\n' +
    'PROCESO DE COMPRA:\n' +
    '- Minimo 10 unidades (solo decirlo si preguntan)\n' +
    '- Entender que busca, dar precio, confirmar logistica (pickup/inspeccion/delivery)\n' +
    '- Armar proforma con productos, cantidades, precios, total USD\n' +
    '  Condicion: Wire transfer in advance | Terminos: FOB Miami\n' +
    '- Avisar que un agente del equipo confirmara la orden\n\n' +
    'ESTILO:\n' +
    '- Habla siempre en plural: tenemos, manejamos, trabajamos\n' +
    '- NO menciones nuevos/sin activar ni minimos salvo que pregunten\n' +
    '- Mismo idioma que el cliente (espanol o ingles)\n' +
    '- Conciso y directo, con calidez\n' +
    '- Pedidos grandes o hablar con alguien: +1 786 559 1119 | sales@south-traders.com\n\n' +const express = require('express');
const path = require('path');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_PHONE = process.env.OWNER_PHONE || '17865591119';
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL ? { rejectUnauthorized: false } : false });

async function initDB() {
  await pool.query('CREATE TABLE IF NOT EXISTS conversations (phone TEXT, role TEXT, content TEXT, ts TIMESTAMPTZ DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS crm_contacts (id SERIAL PRIMARY KEY, phone TEXT UNIQUE, name TEXT, country TEXT, company TEXT, interest TEXT, tier TEXT DEFAULT \'lead\', status TEXT DEFAULT \'new\', notes TEXT, last_contact TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT FALSE');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT \'tier1\'');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS registered BOOLEAN DEFAULT FALSE');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS logistics TEXT');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS pending_order BOOLEAN DEFAULT FALSE');
  await pool.query('CREATE TABLE IF NOT EXISTS outbound_campaigns (id SERIAL PRIMARY KEY, name TEXT, message TEXT, status TEXT DEFAULT \'pending\', created_at TIMESTAMPTZ DEFAULT NOW(), total_sent INT DEFAULT 0, total_failed INT DEFAULT 0)');
  await pool.query('CREATE TABLE IF NOT EXISTS outbound_logs (id SERIAL PRIMARY KEY, campaign_id INT, phone TEXT, status TEXT DEFAULT \'pending\', sent_at TIMESTAMPTZ, error TEXT)');
  console.log('DB OK');
}

async function loadConversation(phone) {
  try {
    const r = await pool.query('SELECT role, content, ts FROM conversations WHERE phone=$1 ORDER BY ts DESC LIMIT 10', [phone]);
    return r.rows.reverse();
  } catch(e) { return []; }
}

async function saveMessage(phone, role, content) {
  try { await pool.query('INSERT INTO conversations (phone, role, content) VALUES ($1,$2,$3)', [phone, role, content]); } catch(e) {}
}

async function upsertContact(phone) {
  try {
    const country = detectCountry(phone);
    await pool.query(
      'INSERT INTO crm_contacts (phone, country) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET last_contact=NOW()',
      [phone, country]
    );
  } catch(e) {}
}

// STOCK
let stockData = [];
let stockLastUpdated = null;

async function fetchStock() {
  try {
    const resp = await axios.get('https://south-traders.pangea.ar/n6/stock_disp', { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const rows = [];
    const trRe = /<tr[^>]*>([sS]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(resp.data)) !== null) {
      const cells = [];
      const tdRe = /<td[^>]*>([sS]*?)<\/td>/gi;
      let td;
      while ((td = tdRe.exec(tr[1])) !== null) cells.push(td[1].replace(/<[^>]+>/g,'').trim());
      if (cells.length >= 3 && cells[0] && cells[1]) rows.push({ desc: cells[1], qty: parseInt(cells[2])||0, transit: parseInt(cells[3])||0 });
    }
    if (rows.length > 0) { stockData = rows; stockLastUpdated = new Date(); console.log('Stock OK: ' + rows.length); }
  } catch(e) { console.error('Stock error:', e.message); }
}

fetchStock();
setInterval(fetchStock, 6 * 3600 * 1000);

function getStockSummary() {
  if (!stockData.length) return 'Stock actualizandose.';
  const nuevos = stockData.filter(function(i) { return i.qty > 0 && !/\s[-]\s*(GA\+?-?|GAB|GB|IND)$/i.test(i.desc); });
  const grupos = {};
  for (let i = 0; i < nuevos.length; i++) {
    const item = nuevos[i];
    const base = item.desc.replace(/\s+(BLACK|BLUE|PINK|WHITE|GREEN|YELLOW|RED|PURPLE|SILVER|GOLD|STARLIGHT|MIDNIGHT|NATURAL|DESERT|TEAL|CREAM|SAND|STORM|TITANIUM|ULTRAMARINE|BURGUNDY|GRAPHITE)(\s.*)?$/i,'').trim();
    if (!grupos[base]) grupos[base] = 0;
    grupos[base] += item.qty;
  }
  const lines = ['STOCK NUEVOS SIN ACTIVAR (distribuidor oficial Apple):'];
  const keys = Object.keys(grupos);
  for (let i = 0; i < keys.length; i++) {
    lines.push('- ' + keys[i] + ': ' + grupos[keys[i]] + 'u');
  }
  const totalRefu = stockData.filter(function(i) { return i.qty > 0 && /\s[-]\s*(GA\+?-?|GAB|GB)$/i.test(i.desc); }).reduce(function(s,i) { return s+i.qty; }, 0);
  if (totalRefu > 0) lines.push('REFU/USADOS: ' + totalRefu + 'u disponibles (precios a consultar)');
  lines.push('Ver stock completo: https://south-traders.pangea.ar/n6/stock_disp#');
  return lines.join('\n');
}

function buildPrompt() {
  return 'Sos Sophia, agente comercial de South Traders — distribuidor oficial de Apple en Miami.\n\n' +
    'PERSONALIDAD:\n' +
    '- Mujer profesional, segura, con carisma y una chispa de seduccion sutil\n' +
    '- Encantadora pero sin pasarte. Calidez genuina, nunca robotica.\n' +
    '- Haces sentir al cliente especial. Cuando hace un buen pedido, se lo reconoces.\n\n' +
    'EMPRESA:\n' +
    '- Somos distribuidor oficial Apple. Tenemos iPhones, MacBooks, Samsung y accesorios.\n' +
    '- Mayoristas para LATAM, El Caribe y el mundo.\n' +
    '- Pago: Wire transfer in advance\n' +
    '- Horario: Lun-Vie 9am-6pm ET\n' +
    '- Contacto: +1 786 559 1119 | sales@south-traders.com\n' +
    '- Direccion: 10850 NW 21st St, Suite 140, Miami FL 33172\n\n' +
    'LOGISTICA:\n' +
    '- FOB Miami (el cliente coordina el flete)\n' +
    '- Delivery GRATIS en Doral para ordenes +$30,000 USD\n' +
    '- Pickup en warehouse disponible\n' +
    '- Pueden enviar alguien a verificar mercaderia al warehouse si lo solicitan\n\n' +
    'PRODUCTOS:\n' +
    '- Articulos SIN sufijo de grado son NUEVOS. Solo aclararlo si el cliente pregunta.\n' +
    '- USADOS/REFU: sufijo GA, GA-, GAB, GB. Precios a consultar.\n' +
    '- Ver stock: https://south-traders.pangea.ar/n6/stock_disp#\n\n' +
    'PRECIOS (USD) - Lista Cash Tier 1 para clientes nuevos:\n' +
    'iPhone Air 256GB $850 | 17e $545 | 17 256GB $780\n' +
    'iPhone 17 Pro: 256GB $1050 | 512GB $1160 | 1TB $1300\n' +
    'iPhone 17 Pro Max: 256GB $1150 | 512GB $1260 | 1TB $1420\n' +
    'iPhone 16 128GB $640 | 16 Pro 128GB $850 | 256GB $960\n' +
    'iPhone 15 128GB $530 | 15 Pro 128GB $720\n' +
    'Samsung S25 Ultra 512GB $1070 | S26 Ultra 512GB $1170\n' +
    'MacBook Air 13 M5 $1060 | 15 M4 $1200\n' +
    'AirPods 4 $145 | AirPods Pro 3 $210\n\n' +
    'CREDITO:\n' +
    '- No manejamos credito con clientes nuevos\n' +
    '- Luego de trabajar juntos pueden aplicar a credito\n' +
    '- Los precios a credito son distintos a los de contado\n\n' +
    'PROCESO DE COMPRA:\n' +
    '1. Entender que busca el cliente (modelo, cantidad)\n' +
    '2. Dar precio segun su tier (cash tier1 por defecto para clientes nuevos)\n' +
    '3. Minimo de compra: 10 unidades\n' +
    '4. Confirmar si el cliente esta registrado en nuestro sistema\n' +
    '5. Pedir datos de logistica: pickup / inspeccion / delivery\n' +
    '6. Armar proforma con los productos, cantidades y precios acordados\n' +
    '7. Notificar al equipo que hay una orden para confirmar\n\n' +
    'PROFORMA:\n' +
    '- Cuando el cliente confirme interes real, arma una proforma clara con:\n' +
    '  Detalle de productos | Cantidades | Precio unitario | Total USD\n' +
    '  Condicion de pago: Wire transfer in advance\n' +
    '  Terminos: FOB Miami\n' +
    '- Indica que un agente confirmara la orden al +1 786 559 1119 | sales@south-traders.com\n\n' +
    'ESTILO:\n' +
    '- Habla siempre en plural: "tenemos", "manejamos", "trabajamos"\n' +
    '- NO menciones que son nuevos/sin activar a menos que pregunten\n' +
    '- NO menciones minimos a menos que pregunten\n' +
    '- Mismo idioma que el cliente (espanol o ingles)\n' +
    '- Respuestas concisas y directas, con calidez\n' +
    '- Si piden hablar con alguien real: +1 786 559 1119 | sales@south-traders.com\n' +
    '- Pedidos grandes o consultas complejas: derivar al +1 786 559 1119 | sales@south-traders.com\n\n' +const express = require('express');
const path = require('path');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_PHONE = process.env.OWNER_PHONE || '17865591119';
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL ? { rejectUnauthorized: false } : false });

async function initDB() {
  await pool.query('CREATE TABLE IF NOT EXISTS conversations (phone TEXT, role TEXT, content TEXT, ts TIMESTAMPTZ DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS crm_contacts (id SERIAL PRIMARY KEY, phone TEXT UNIQUE, name TEXT, country TEXT, company TEXT, interest TEXT, tier TEXT DEFAULT \'lead\', status TEXT DEFAULT \'new\', notes TEXT, last_contact TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())');
  await pool.query('ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT FALSE');
  await pool.query('CREATE TABLE IF NOT EXISTS outbound_campaigns (id SERIAL PRIMARY KEY, name TEXT, message TEXT, status TEXT DEFAULT \'pending\', created_at TIMESTAMPTZ DEFAULT NOW(), total_sent INT DEFAULT 0, total_failed INT DEFAULT 0)');
  await pool.query('CREATE TABLE IF NOT EXISTS outbound_logs (id SERIAL PRIMARY KEY, campaign_id INT, phone TEXT, status TEXT DEFAULT \'pending\', sent_at TIMESTAMPTZ, error TEXT)');
  console.log('DB OK');
}

async function loadConversation(phone) {
  try {
    const r = await pool.query('SELECT role, content, ts FROM conversations WHERE phone=$1 ORDER BY ts DESC LIMIT 10', [phone]);
    return r.rows.reverse();
  } catch(e) { return []; }
}

async function saveMessage(phone, role, content) {
  try { await pool.query('INSERT INTO conversations (phone, role, content) VALUES ($1,$2,$3)', [phone, role, content]); } catch(e) {}
}

async function upsertContact(phone) {
  try { await pool.query('INSERT INTO crm_contacts (phone) VALUES ($1) ON CONFLICT (phone) DO UPDATE SET last_contact=NOW()', [phone]); } catch(e) {}
}

// STOCK
let stockData = [];
let stockLastUpdated = null;

async function fetchStock() {
  try {
    const resp = await axios.get('https://south-traders.pangea.ar/n6/stock_disp', { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const rows = [];
    const trRe = /<tr[^>]*>([sS]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(resp.data)) !== null) {
      const cells = [];
      const tdRe = /<td[^>]*>([sS]*?)<\/td>/gi;
      let td;
      while ((td = tdRe.exec(tr[1])) !== null) cells.push(td[1].replace(/<[^>]+>/g,'').trim());
      if (cells.length >= 3 && cells[0] && cells[1]) rows.push({ desc: cells[1], qty: parseInt(cells[2])||0, transit: parseInt(cells[3])||0 });
    }
    if (rows.length > 0) { stockData = rows; stockLastUpdated = new Date(); console.log('Stock OK: ' + rows.length); }
  } catch(e) { console.error('Stock error:', e.message); }
}

fetchStock();
setInterval(fetchStock, 6 * 3600 * 1000);

function getStockSummary() {
  if (!stockData.length) return 'Stock actualizandose.';
  const nuevos = stockData.filter(function(i) { return i.qty > 0 && !/\s[-]\s*(GA\+?-?|GAB|GB|IND)$/i.test(i.desc); });
  const grupos = {};
  for (let i = 0; i < nuevos.length; i++) {
    const item = nuevos[i];
    const base = item.desc.replace(/\s+(BLACK|BLUE|PINK|WHITE|GREEN|YELLOW|RED|PURPLE|SILVER|GOLD|STARLIGHT|MIDNIGHT|NATURAL|DESERT|TEAL|CREAM|SAND|STORM|TITANIUM|ULTRAMARINE|BURGUNDY|GRAPHITE)(\s.*)?$/i,'').trim();
    if (!grupos[base]) grupos[base] = 0;
    grupos[base] += item.qty;
  }
  const lines = ['STOCK NUEVOS SIN ACTIVAR (distribuidor oficial Apple):'];
  const keys = Object.keys(grupos);
  for (let i = 0; i < keys.length; i++) {
    lines.push('- ' + keys[i] + ': ' + grupos[keys[i]] + 'u');
  }
  const totalRefu = stockData.filter(function(i) { return i.qty > 0 && /\s[-]\s*(GA\+?-?|GAB|GB)$/i.test(i.desc); }).reduce(function(s,i) { return s+i.qty; }, 0);
  if (totalRefu > 0) lines.push('REFU/USADOS: ' + totalRefu + 'u disponibles (precios a consultar)');
  lines.push('Ver stock completo: https://south-traders.pangea.ar/n6/stock_disp#');
  return lines.join('\n');
}

function buildPrompt() {
  return 'Sos Sophia, agente comercial de South Traders — distribuidor oficial de Apple en Miami, Florida.\n\n' +
    'PERSONALIDAD:\n' +
    '- Mujer profesional, segura, con carisma y una chispa de seduccion sutil\n' +
    '- Encantadora pero sin pasarte. Calidez genuina, nunca robotica.\n' +
    '- Haces sentir al cliente especial. Cuando hace un buen pedido, se lo reconoces.\n\n' +
    'EMPRESA:\n' +
    '- Somos distribuidor oficial Apple. Tenemos iPhones, MacBooks, Samsung y accesorios.\n' +
    '- Mayoristas para LATAM, El Caribe y el mundo.\n' +
    '- Pagos: Wire transfer, Zelle, crypto\n' +
    '- Horario: Lun-Vie 9am-6pm ET\n' +
    '- Tel: +1 786 909 0198 | info@southtraders.com\n' +
    '- Direccion: 10850 NW 21st St, Suite 140, Miami FL 33172\n\n' +
    'LOGISTICA:\n' +
    '- FOB Miami (el cliente coordina el flete)\n' +
    '- Delivery GRATIS en Doral para ordenes +$30,000 USD\n' +
    '- Pickup en warehouse disponible\n\n' +
    'PRODUCTOS:\n' +
    '- Articulos SIN sufijo de grado son NUEVOS. Solo aclararlo si el cliente pregunta especificamente.\n' +
    '- USADOS/REFU: articulos con sufijo GA, GA-, GAB, GB al final. Precios a consultar.\n' +
    '- Si preguntan por stock, comparti el portal: https://south-traders.pangea.ar/n6/stock_disp#\n\n' +
    'PRECIOS (USD):\n' +
    'iPhone Air 256GB $850 | 17e $545 | 17 256GB $780\n' +
    'iPhone 17 Pro: 256GB $1050 | 512GB $1160 | 1TB $1300\n' +
    'iPhone 17 Pro Max: 256GB $1150 | 512GB $1260 | 1TB $1420\n' +
    'iPhone 16 128GB $640 | 16 Pro 128GB $850 | 256GB $960\n' +
    'iPhone 15 128GB $530 | 15 Pro 128GB $720\n' +
    'Samsung S25 Ultra 512GB $1070 | S26 Ultra 512GB $1170\n' +
    'MacBook Air 13 M5 $1060 | 15 M4 $1200\n' +
    'AirPods 4 $145 | AirPods Pro 3 $210\n\n' +
    'ESTILO:\n' +
    '- Habla siempre en plural: "tenemos", "manejamos", "trabajamos"\n' +
    '- NO menciones que los productos son nuevos o sin activar a menos que te pregunten\n' +
    '- NO menciones minimos de compra a menos que te pregunten\n' +
    '- Mismo idioma que el cliente (espanol o ingles)\n' +
    '- Respuestas concisas y directas, con calidez\n' +
    '- Para cerrar pedido pedi: modelo, cantidad, pais destino, datos de contacto\n' +
    '- Pedidos grandes: invitalos a llamar al +1 786 909 0198\n\n' +
    getStockSummary();
}

async function askClaude(phone, userText) {
  await saveMessage(phone, 'user', userText);
  const history = await loadConversation(phone);
  const messages = history.map(function(m) { return { role: m.role, content: m.content }; });
  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5', max_tokens: 1024, system: buildPrompt(), messages: messages },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const text = resp.data && resp.data.content && resp.data.content[0] && resp.data.content[0].text;
    if (!text) { console.error('Claude empty:', JSON.stringify(resp.data && resp.data.usage)); return null; }
    await saveMessage(phone, 'assistant', text);
    return text;
  } catch(e) {
    console.error('Claude error:', e.response && e.response.data || e.message);
    return null;
  }
}

async function sendWA(to, text) {
  await axios.post(
    'https://graph.facebook.com/v19.0/' + PHONE_NUMBER_ID + '/messages',
    { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: text } },
    { headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json' } }
  );
}

async function handleMessage(phone, text) {
  console.log('[IN] ' + phone + ': ' + text);
  await upsertContact(phone);
  // Respuesta automatica a audios
  if (text === '__AUDIO__') {
    await sendWA(phone, 'Hola! Recib\u00ed tu audio pero no puedo escucharlo. \u00bfPod\u00e9s escribirme tu consulta? Con gusto te ayudo \uD83D\uDE0A');
    return;
  }
  // Chequear si el contacto está pausado (Chelo toma el control)
  try {
    const pauseCheck = await pool.query('SELECT paused FROM crm_contacts WHERE phone=$1', [phone]);
    if (pauseCheck.rows.length > 0 && pauseCheck.rows[0].paused) {
      console.log('[PAUSED] ' + phone + ' - Sophia en pausa, Chelo maneja');
      return;
    }
  } catch(e) {}
  const history = await loadConversation(phone);
  if (history.length === 0) {
    sendWA(OWNER_PHONE, '\uD83D\uDD14 Nuevo mensaje\nDe: +' + phone + '\n"' + text.slice(0,80) + '"').catch(function(){});
  }
  const reply = await askClaude(phone, text);
  if (!reply) {
    await sendWA(phone, 'Disculpa la demora! Escribinos al +1 786 909 0198 y te atendemos enseguida');
    return;
  }
  await sendWA(phone, reply);
  console.log('[OUT] ' + phone + ': ' + reply.slice(0,80));
  // Notificar si Sophia armo una proforma
  const isProforma = reply.toLowerCase().includes('proforma') || reply.toLowerCase().includes('wire transfer') || reply.toLowerCase().includes('total usd');
  if (isProforma && phone !== OWNER_PHONE) {
    sendWA(OWNER_PHONE, '\uD83D\uDCCB ORDEN PENDIENTE\nCliente: +' + phone + '\nRevisar y confirmar:\n' + reply.slice(0, 500)).catch(function(){});
  }
}

// WEBHOOK
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN)
    return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});

app.post('/webhook', function(req, res) {
  res.sendStatus(200);
  const msgs = req.body && req.body.entry && req.body.entry[0] && req.body.entry[0].changes && req.body.entry[0].changes[0] && req.body.entry[0].changes[0].value && req.body.entry[0].changes[0].value.messages;
  if (!msgs || !msgs.length) return;
  const m = msgs[0];
  if (m.type === 'text') handleMessage(m.from, m.text && m.text.body || '').catch(console.error);
  if (m.type === 'audio' || m.type === 'voice') {
    handleMessage(m.from, '__AUDIO__').catch(console.error);
  }
});

// DASHBOARD
function detectCountry(phone) {
  if (phone.startsWith('549') || phone.startsWith('54')) return 'Argentina';
  if (phone.startsWith('521') || phone.startsWith('52')) return 'Mexico';
  if (phone.startsWith('571') || phone.startsWith('57')) return 'Colombia';
  if (phone.startsWith('511') || phone.startsWith('51')) return 'Peru';
  if (phone.startsWith('593')) return 'Ecuador';
  if (phone.startsWith('56')) return 'Chile';
  if (phone.startsWith('598')) return 'Uruguay';
  if (phone.startsWith('595')) return 'Paraguay';
  if (phone.startsWith('591')) return 'Bolivia';
  if (phone.startsWith('507')) return 'Panama';
  if (phone.startsWith('502')) return 'Guatemala';
  if (phone.startsWith('503')) return 'El Salvador';
  if (phone.startsWith('504')) return 'Honduras';
  if (phone.startsWith('505')) return 'Nicaragua';
  if (phone.startsWith('506')) return 'Costa Rica';
  if (phone.startsWith('1')) return 'EEUU/Canada';
  if (phone.startsWith('55')) return 'Brasil';
  if (phone.startsWith('58')) return 'Venezuela';
  return 'Otro';
}

app.post('/send', async function(req, res) {
  const b = req.body;
  if (!b.phone || !b.message) return res.status(400).json({error: 'faltan datos'});
  try {
    await sendWA(b.phone, b.message);
    await saveMessage(b.phone, 'assistant', '[Chelo] ' + b.message);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/dashboard', function(req, res) {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// CONVERSACIONES
app.get('/conversations', async function(req, res) {
  try {
    const r = await pool.query('SELECT phone, role, content, ts FROM conversations ORDER BY phone, ts ASC');
    const grouped = {};
    for (let i = 0; i < r.rows.length; i++) {
      const row = r.rows[i];
      if (!grouped[row.phone]) grouped[row.phone] = { messages: [] };
      grouped[row.phone].messages.push({ role: row.role, content: row.content, ts: row.ts });
    }
    res.json({ ok: true, conversations: grouped, total: Object.keys(grouped).length });
  } catch(e) { res.json({ ok: true, conversations: {}, total: 0 }); }
});

// BORRAR HISTORIAL
app.post('/conversations/clear', async function(req, res) {
  const phone = req.body && req.body.phone;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await pool.query('DELETE FROM conversations WHERE phone=$1', [phone]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CRM
app.get('/crm/contacts', async function(req, res) {
  try {
    const r = await pool.query('SELECT c.*, (SELECT COUNT(*) FROM conversations WHERE phone=c.phone) as msg_count FROM crm_contacts c ORDER BY last_contact DESC');
    res.json({ ok: true, contacts: r.rows, total: r.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/crm/contacts', async function(req, res) {
  const b = req.body;
  if (!b.phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await pool.query(
      'INSERT INTO crm_contacts (phone,name,country,company,interest,tier,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (phone) DO UPDATE SET name=COALESCE($2,crm_contacts.name), country=COALESCE($3,crm_contacts.country), company=COALESCE($4,crm_contacts.company), interest=COALESCE($5,crm_contacts.interest), tier=COALESCE($6,crm_contacts.tier), status=COALESCE($7,crm_contacts.status), notes=COALESCE($8,crm_contacts.notes), last_contact=NOW() RETURNING *',
      [b.phone, b.name, b.country, b.company, b.interest, b.tier||'lead', b.status||'new', b.notes]
    );
    res.json({ ok: true, contact: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// OUTBOUND
app.post('/outbound/campaign', async function(req, res) {
  const b = req.body;
  if (!b.name || !b.message || !b.phones || !b.phones.length) return res.status(400).json({ error: 'name, message, phones[] requeridos' });
  try {
    const c = await pool.query('INSERT INTO outbound_campaigns (name,message) VALUES ($1,$2) RETURNING *', [b.name, b.message]);
    const campId = c.rows[0].id;
    for (let i = 0; i < b.phones.length; i++) await pool.query('INSERT INTO outbound_logs (campaign_id,phone) VALUES ($1,$2)', [campId, b.phones[i]]);
    res.json({ ok: true, campaign_id: campId, total: b.phones.length });
    runCampaign(campId, b.message, b.phones);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function runCampaign(campId, message, phones) {
  let sent = 0, failed = 0;
  for (let i = 0; i < phones.length; i++) {
    await new Promise(function(r) { setTimeout(r, 1200); });
    try { await sendWA(phones[i], message); await upsertContact(phones[i]); sent++; }
    catch(e) { failed++; }
  }
  await pool.query('UPDATE outbound_campaigns SET status=$1,total_sent=$2,total_failed=$3 WHERE id=$4', ['done', sent, failed, campId]);
  console.log('Campaign ' + campId + ': ' + sent + ' sent, ' + failed + ' failed');
}

app.get('/outbound/campaigns', async function(req, res) {
  try { const r = await pool.query('SELECT * FROM outbound_campaigns ORDER BY created_at DESC'); res.json({ ok: true, campaigns: r.rows }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// LEGAL
app.get('/privacy', function(req, res) { res.send('<h1>Privacy Policy</h1><p>South Traders Bot collects phone numbers and messages to provide wholesale sales assistance. Data is never sold. Contact: info@southtraders.com</p>'); });
app.get('/terms', function(req, res) { res.send('<h1>Terms of Service</h1><p>By messaging this bot you agree to receive wholesale electronics information. Min order 5 units. Contact: info@southtraders.com</p>'); });

// HEALTH
app.post('/crm/pause', async function(req, res) {
  const { phone, paused } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    await pool.query('UPDATE crm_contacts SET paused=$1 WHERE phone=$2', [paused, phone]);
    res.json({ ok: true, phone, paused });
    console.log('[' + (paused ? 'PAUSED' : 'RESUMED') + '] ' + phone);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/', function(req, res) { res.json({ status: 'ok', stock: { items: stockData.length, updated: stockLastUpdated } }); });

const PORT = process.env.PORT || 3000;
initDB().then(function() { app.listen(PORT, function() { console.log('Sophia online port ' + PORT); }); }).catch(console.error);
