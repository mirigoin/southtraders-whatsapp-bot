// dashboard-routes.js
//
// Módulo aislado con:
// - Basic auth para todas las rutas administrativas
// - Editar nombre/datos de contactos
// - Subir CSV de clientes
// - Listar templates aprobados de Meta
// - Crear y disparar campañas de outbound masivo (rate-limited)
// - Status de campañas en vivo
//
// Uso desde index.js:
//   const setupDashboardRoutes = require('./dashboard-routes');
//   setupDashboardRoutes(app, pool);
//
// Variables de entorno requeridas (todas ya existen excepto las primeras 3):
//   DASHBOARD_USER         (nuevo)
//   DASHBOARD_PASS         (nuevo)
//   WHATSAPP_BUSINESS_ACCOUNT_ID  (nuevo, para listar templates)
//   WHATSAPP_TOKEN         (existente)
//   PHONE_NUMBER_ID        (existente)

const path = require('path');
const fs = require('fs');
const basicAuth = require('express-basic-auth');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const axios = require('axios');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const META_VERSION = 'v19.0';
const META_URL = `https://graph.facebook.com/${META_VERSION}`;
const RATE_LIMIT_MS = 10_000; // 10 segundos entre mensajes (decisión de Marcelo)
const MAX_CSV_SIZE = 2 * 1024 * 1024; // 2MB

// Multer en memoria (no necesitamos archivos en disco)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_CSV_SIZE }
});

// Cache de templates de Meta (5 min)
let templatesCache = { data: null, ts: 0 };
const TEMPLATES_CACHE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Normalizar número a formato E.164 sin '+', solo dígitos.
// Acepta: "+5491145301832", "5491145301832", "54 9 11 4530-1832", etc.
function normalizePhone(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return null;
    return digits;
}

// Sleep helper para rate limiting
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Render un template body con variables.
// templateBody = "Hola {{1}}, ofertamos {{2}}"
// vars = ["Marcelo", "iPhone 15"]
function renderTemplatePreview(templateBody, vars) {
    let out = templateBody;
    vars.forEach((v, i) => {
        out = out.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), v);
    });
    return out;
}

// Mandar un template message via Meta API.
// Usa axios (mismo patrón que /send existente).
async function sendTemplateMessage({ to, templateName, languageCode, components }) {
    const url = `${META_URL}/${process.env.PHONE_NUMBER_ID}/messages`;
    const body = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
            name: templateName,
            language: { code: languageCode },
            ...(components && components.length ? { components } : {})
        }
    };
    const res = await axios.post(url, body, {
        headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        },
        timeout: 15_000
    });
    return res.data;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

module.exports = function setupDashboardRoutes(app, pool) {

    // -----------------------------------------------------------------------
    // BASIC AUTH MIDDLEWARE
    // -----------------------------------------------------------------------
    // Solo se aplica a las rutas admin. Webhook de Meta queda libre.
    if (!process.env.DASHBOARD_USER || !process.env.DASHBOARD_PASS) {
        console.warn('[dashboard] WARNING: DASHBOARD_USER o DASHBOARD_PASS no seteados. Las rutas admin estarán SIN PROTECCIÓN.');
    }

    const auth = basicAuth({
        users: process.env.DASHBOARD_USER && process.env.DASHBOARD_PASS
            ? { [process.env.DASHBOARD_USER]: process.env.DASHBOARD_PASS }
            : {},
        challenge: true,
        realm: 'South Traders Dashboard',
        unauthorizedResponse: () => 'Unauthorized'
    });

    // Aplicar auth a todas las rutas admin existentes Y nuevas
    const protectedPaths = [
        '/dashboard',
        '/conversations',
        '/conversations/clear',
        '/crm',
        '/send',
        '/daily-list.pdf',
        '/daily-list.html',
        '/templates',
        '/upload-contacts',
        '/campaigns',
        '/campaign'
    ];
    protectedPaths.forEach(p => app.use(p, auth));

    // -----------------------------------------------------------------------
    // GET /crm/contacts/full - lista enriquecida con conteo de mensajes
    // -----------------------------------------------------------------------
    // Endpoint nuevo (el viejo /crm/contacts queda intacto en index.js).
    app.get('/crm/contacts/full', async function (req, res) {
        try {
            const { rows } = await pool.query(`
                SELECT 
                    c.phone, c.name, c.country, c.company, c.interest,
                    c.tier, c.status, c.notes, c.last_contact,
                    c.registered, c.logistics, c.pending_order,
                    COALESCE(m.msg_count, 0) AS msg_count,
                    m.last_msg_ts
                FROM crm_contacts c
                LEFT JOIN (
                    SELECT phone, COUNT(*) AS msg_count, MAX(ts) AS last_msg_ts
                    FROM conversations
                    GROUP BY phone
                ) m ON m.phone = c.phone
                ORDER BY COALESCE(m.last_msg_ts, c.last_contact) DESC NULLS LAST
            `);
            res.json({ ok: true, contacts: rows });
        } catch (e) {
            console.error('[/crm/contacts/full]', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // -----------------------------------------------------------------------
    // PATCH /crm/contacts/:phone - editar campos del contacto
    // -----------------------------------------------------------------------
    // Body: { name?, country?, company?, interest?, tier?, status?, notes? }
    app.patch('/crm/contacts/:phone', async function (req, res) {
        const phone = normalizePhone(req.params.phone);
        if (!phone) return res.status(400).json({ ok: false, error: 'phone inválido' });

        const allowed = ['name', 'country', 'company', 'interest', 'tier', 'status', 'notes'];
        const fields = [];
        const values = [];
        allowed.forEach(k => {
            if (req.body[k] !== undefined) {
                fields.push(`${k} = $${values.length + 1}`);
                values.push(req.body[k]);
            }
        });
        if (!fields.length) return res.status(400).json({ ok: false, error: 'sin campos para actualizar' });
        values.push(phone);

        try {
            const q = `UPDATE crm_contacts SET ${fields.join(', ')} WHERE phone = $${values.length} RETURNING *`;
            const { rows } = await pool.query(q, values);
            if (!rows.length) return res.status(404).json({ ok: false, error: 'contacto no encontrado' });
            res.json({ ok: true, contact: rows[0] });
        } catch (e) {
            console.error('[PATCH /crm/contacts]', e.message);
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // -----------------------------------------------------------------------
    // GET /templates - lista templates aprobados de Meta (cached 5min)
    // -----------------------------------------------------------------------
    app.get('/templates', async function (req, res) {
        const now = Date.now();
        if (templatesCache.data && now - templatesCache.ts < TEMPLATES_CACHE_MS) {
            return res.json({ ok: true, cached: true, templates: templatesCache.data });
        }

        const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        if (!wabaId) {
            return res.status(500).json({
                ok: false,
                error: 'WHATSAPP_BUSINESS_ACCOUNT_ID no configurado en env'
            });
        }

        try {
            const url = `${META_URL}/${wabaId}/message_templates`;
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
                params: { fields: 'name,language,status,category,components', limit: 100 },
                timeout: 10_000
            });
            const all = response.data.data || [];
            const approved = all.filter(t => t.status === 'APPROVED');
            templatesCache = { data: approved, ts: now };
            res.json({ ok: true, cached: false, templates: approved });
        } catch (e) {
            console.error('[/templates]', e.response?.data || e.message);
            res.status(500).json({ ok: false, error: e.response?.data?.error?.message || e.message });
        }
    });

    // -----------------------------------------------------------------------
    // POST /upload-contacts - parsea CSV y devuelve preview
    // -----------------------------------------------------------------------
    // Form data: file=<csv>
    // CSV columnas esperadas: phone, name (otras opcionales: company, country, tier, notes)
    // Devuelve: { valid: [...], invalid: [...], duplicates: [...] }
    app.post('/upload-contacts', upload.single('file'), async function (req, res) {
        if (!req.file) return res.status(400).json({ ok: false, error: 'falta archivo' });

        let records;
        try {
            records = parse(req.file.buffer.toString('utf8'), {
                columns: true,
                trim: true,
                skip_empty_lines: true,
                relax_column_count: true
            });
        } catch (e) {
            return res.status(400).json({ ok: false, error: 'CSV mal formateado: ' + e.message });
        }

        // Detectar nombre de columnas (case-insensitive)
        const sample = records[0] || {};
        const findCol = (...names) => {
            for (const n of names) {
                const k = Object.keys(sample).find(k => k.toLowerCase().trim() === n.toLowerCase());
                if (k) return k;
            }
            return null;
        };
        const phoneCol = findCol('phone', 'telefono', 'teléfono', 'numero', 'número', 'whatsapp');
        const nameCol = findCol('name', 'nombre');
        const companyCol = findCol('company', 'empresa', 'compañia', 'compania');
        const countryCol = findCol('country', 'pais', 'país');

        if (!phoneCol) {
            return res.status(400).json({
                ok: false,
                error: 'CSV no tiene columna de teléfono. Esperaba: phone/telefono/numero/whatsapp'
            });
        }

        // Sacar la lista de phones existentes en la DB de una sola query
        let existing = new Set();
        try {
            const { rows } = await pool.query('SELECT phone FROM crm_contacts');
            existing = new Set(rows.map(r => r.phone));
        } catch (e) {
            return res.status(500).json({ ok: false, error: 'error consultando DB: ' + e.message });
        }

        const valid = [];
        const invalid = [];
        const duplicates = [];
        const seen = new Set();

        records.forEach((row, idx) => {
            const phone = normalizePhone(row[phoneCol]);
            const name = nameCol ? (row[nameCol] || '').trim() : '';

            if (!phone) {
                invalid.push({ row: idx + 2, raw: row[phoneCol], reason: 'teléfono inválido' });
                return;
            }
            if (seen.has(phone)) {
                duplicates.push({ row: idx + 2, phone, reason: 'duplicado dentro del CSV' });
                return;
            }
            seen.add(phone);
            if (existing.has(phone)) {
                duplicates.push({ row: idx + 2, phone, name, reason: 'ya existe en crm_contacts' });
                return;
            }
            valid.push({
                phone,
                name,
                company: companyCol ? (row[companyCol] || '').trim() : '',
                country: countryCol ? (row[countryCol] || '').trim() : ''
            });
        });

        res.json({
            ok: true,
            stats: { total: records.length, valid: valid.length, invalid: invalid.length, duplicates: duplicates.length },
            valid,
            invalid,
            duplicates
        });
    });

    // -----------------------------------------------------------------------
    // POST /campaigns - crear campaña + insertar contactos nuevos + arrancar envío
    // -----------------------------------------------------------------------
    // Body: {
    //   name: string,
    //   templateName: string,
    //   languageCode: string,         (e.g. "es_AR" o "en")
    //   variables: string[],          (variables del template body, ej ["Promo Mayo"])
    //   contacts: [{phone, name, company?, country?}, ...]   (ya validados por /upload-contacts)
    //   confirm: true                 (debe estar explícito)
    // }
    app.post('/campaigns', async function (req, res) {
        const { name, templateName, languageCode, variables = [], contacts = [], confirm } = req.body || {};
        if (!confirm) return res.status(400).json({ ok: false, error: 'falta confirm: true' });
        if (!name || !templateName || !languageCode) {
            return res.status(400).json({ ok: false, error: 'faltan campos: name, templateName, languageCode' });
        }
        if (!Array.isArray(contacts) || contacts.length === 0) {
            return res.status(400).json({ ok: false, error: 'lista de contactos vacía' });
        }
        if (contacts.length > 1000) {
            return res.status(400).json({ ok: false, error: 'máximo 1000 contactos por campaña (cuidado con quality rating)' });
        }

        // Construir el message text para guardar en la campaña (como referencia)
        const messageRef = `template:${templateName}@${languageCode}` +
            (variables.length ? ` vars=[${variables.join('|')}]` : '');

        const client = await pool.connect();
        let campaignId;
        try {
            await client.query('BEGIN');

            // Crear campaña
            const campRes = await client.query(`
                INSERT INTO outbound_campaigns (name, message, status, created_at, total_sent, total_failed)
                VALUES ($1, $2, 'pending', NOW(), 0, 0)
                RETURNING id
            `, [name, messageRef]);
            campaignId = campRes.rows[0].id;

            // Insertar contactos nuevos en crm_contacts (los que no existían)
            for (const c of contacts) {
                await client.query(`
                    INSERT INTO crm_contacts (phone, name, company, country, status, last_contact)
                    VALUES ($1, $2, $3, $4, 'cold', NOW())
                    ON CONFLICT (phone) DO NOTHING
                `, [c.phone, c.name || '', c.company || '', c.country || '']);
            }

            // Pre-loggear cada envío como pending en outbound_logs
            for (const c of contacts) {
                await client.query(`
                    INSERT INTO outbound_logs (campaign_id, phone, status)
                    VALUES ($1, $2, 'pending')
                `, [campaignId, c.phone]);
            }

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            client.release();
            console.error('[POST /campaigns]', e.message);
            return res.status(500).json({ ok: false, error: 'error creando campaña: ' + e.message });
        }
        client.release();

        // Responder ya, y disparar envío en background con rate limit
        res.json({
            ok: true,
            campaignId,
            queued: contacts.length,
            estimatedSeconds: Math.ceil(contacts.length * RATE_LIMIT_MS / 1000),
            statusUrl: `/campaign/${campaignId}/status`
        });

        // Envío async (no esperamos)
        runCampaign(pool, campaignId, contacts, templateName, languageCode, variables)
            .catch(e => console.error(`[campaign ${campaignId}] FATAL:`, e));
    });

    // -----------------------------------------------------------------------
    // GET /campaign/:id/status - progreso live
    // -----------------------------------------------------------------------
    app.get('/campaign/:id/status', async function (req, res) {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
        try {
            const camp = await pool.query('SELECT * FROM outbound_campaigns WHERE id = $1', [id]);
            if (!camp.rows.length) return res.status(404).json({ ok: false, error: 'campaña no encontrada' });

            const counts = await pool.query(`
                SELECT status, COUNT(*) AS n
                FROM outbound_logs
                WHERE campaign_id = $1
                GROUP BY status
            `, [id]);
            const summary = {};
            counts.rows.forEach(r => { summary[r.status] = parseInt(r.n, 10); });

            res.json({ ok: true, campaign: camp.rows[0], counts: summary });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // -----------------------------------------------------------------------
    // GET /campaigns - lista de campañas (más recientes primero)
    // -----------------------------------------------------------------------
    app.get('/campaigns', async function (req, res) {
        try {
            const { rows } = await pool.query(`
                SELECT c.*,
                    (SELECT COUNT(*) FROM outbound_logs WHERE campaign_id = c.id AND status = 'sent') AS actually_sent,
                    (SELECT COUNT(*) FROM outbound_logs WHERE campaign_id = c.id AND status = 'failed') AS actually_failed,
                    (SELECT COUNT(*) FROM outbound_logs WHERE campaign_id = c.id AND status = 'pending') AS still_pending
                FROM outbound_campaigns c
                ORDER BY created_at DESC
                LIMIT 50
            `);
            res.json({ ok: true, campaigns: rows });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // -----------------------------------------------------------------------
    // Servir el dashboard nuevo en /dashboard/v2
    // -----------------------------------------------------------------------
    // El /dashboard original sigue funcionando.
    app.get('/dashboard/v2', function (req, res) {
        const filePath = path.join(__dirname, 'dashboard-v2.html');
        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            res.status(404).send('dashboard-v2.html no encontrado en el deploy');
        }
    });

    console.log('[dashboard-routes] Rutas registradas:');
    console.log('  GET    /crm/contacts/full');
    console.log('  PATCH  /crm/contacts/:phone');
    console.log('  GET    /templates');
    console.log('  POST   /upload-contacts');
    console.log('  GET    /campaigns');
    console.log('  POST   /campaigns');
    console.log('  GET    /campaign/:id/status');
    console.log('  GET    /dashboard/v2');
};

// ---------------------------------------------------------------------------
// Worker de envío en background con rate limiting
// ---------------------------------------------------------------------------
async function runCampaign(pool, campaignId, contacts, templateName, languageCode, variables) {
    console.log(`[campaign ${campaignId}] iniciando envío de ${contacts.length} mensajes (rate ${RATE_LIMIT_MS}ms)`);

    // Marcar campaña como running
    await pool.query(`UPDATE outbound_campaigns SET status = 'running' WHERE id = $1`, [campaignId]);

    let sent = 0;
    let failed = 0;

    for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];

        // Construir components si hay variables
        let components;
        if (variables && variables.length) {
            // Reemplazar {{NAME}} con el nombre del contacto si está
            const resolvedVars = variables.map(v => {
                if (v === '{{NAME}}') return c.name || 'Cliente';
                if (v === '{{COMPANY}}') return c.company || '';
                return v;
            });
            components = [{
                type: 'body',
                parameters: resolvedVars.map(v => ({ type: 'text', text: v }))
            }];
        }

        try {
            const result = await sendTemplateMessage({
                to: c.phone,
                templateName,
                languageCode,
                components
            });
            const messageId = result.messages?.[0]?.id || null;
            await pool.query(`
                UPDATE outbound_logs 
                SET status = 'sent', sent_at = NOW(), error = NULL
                WHERE campaign_id = $1 AND phone = $2
            `, [campaignId, c.phone]);
            sent++;
            console.log(`[campaign ${campaignId}] ✓ ${c.phone} (msgId=${messageId})`);
        } catch (e) {
            const errMsg = e.response?.data?.error?.message || e.message;
            failed++;
            await pool.query(`
                UPDATE outbound_logs 
                SET status = 'failed', sent_at = NOW(), error = $3
                WHERE campaign_id = $1 AND phone = $2
            `, [campaignId, c.phone, errMsg.substring(0, 500)]);
            console.error(`[campaign ${campaignId}] ✗ ${c.phone}: ${errMsg}`);

            // Si Meta nos rate-limit-ea, parar todo
            if (errMsg.includes('rate') || errMsg.includes('limit') || e.response?.status === 429) {
                console.error(`[campaign ${campaignId}] RATE LIMIT detectado, abortando`);
                await pool.query(`
                    UPDATE outbound_campaigns 
                    SET status = 'aborted_rate_limit', sent_at = NOW(), total_sent = $2, total_failed = $3
                    WHERE id = $1
                `, [campaignId, sent, failed]);
                return;
            }
        }

        // Update contadores en la campaña cada 10 mensajes
        if ((i + 1) % 10 === 0) {
            await pool.query(`
                UPDATE outbound_campaigns SET total_sent = $2, total_failed = $3 WHERE id = $1
            `, [campaignId, sent, failed]);
        }

        // Rate limit (excepto en el último)
        if (i < contacts.length - 1) {
            await sleep(RATE_LIMIT_MS);
        }
    }

    await pool.query(`
        UPDATE outbound_campaigns 
        SET status = 'completed', sent_at = NOW(), total_sent = $2, total_failed = $3
        WHERE id = $1
    `, [campaignId, sent, failed]);
    console.log(`[campaign ${campaignId}] FINALIZADA: ${sent} enviados, ${failed} fallaron`);
}
