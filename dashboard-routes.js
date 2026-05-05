// dashboard-routes.js
//
// Módulo aislado con todas las rutas del dashboard /v2.
// Sin tocar index.js: la firma sigue siendo setupDashboardRoutes(app, pool).
//
// Cambios v3 (CRM rebuild):
// - Multi-user basic auth: 3 usuarios (marcelo, nico, santiago) via DASHBOARD_USERS env
// - GET /crm/contacts/full ahora soporta filtros: ?tipo=&origen=&region=&vendedor=&estado=&q=
// - Nuevos endpoints:
//   * GET    /crm/interactions/:phone   - log de interacciones de un contacto
//   * POST   /crm/interactions          - crear interacción manual
//   * POST   /crm/contact/:phone/sofia  - dispara mensaje 1-a-1 vía Sofía bot
// - PATCH /crm/contacts/:phone ahora loguea el cambio en crm_interactions con autor
// - Logs de campañas también pasan por crm_interactions
// - Mantengo: /upload-contacts, /campaigns, /templates, /dashboard/v2

const fs = require('fs');
const path = require('path');
const basicAuth = require('express-basic-auth');
const axios = require('axios');

module.exports = function setupDashboardRoutes(app, pool) {

    // -----------------------------------------------------------------------
    // BASIC AUTH MIDDLEWARE (multi-user)
    // -----------------------------------------------------------------------
    // Formato env DASHBOARD_USERS: "marcelo:passA,nico:passB,santiago:passC"
    // Fallback retrocompatible: DASHBOARD_USER + DASHBOARD_PASS (un solo user)
    function buildUsers() {
        const out = {};
        if (process.env.DASHBOARD_USERS) {
            const pairs = process.env.DASHBOARD_USERS.split(',');
            for (const p of pairs) {
                const idx = p.indexOf(':');
                if (idx === -1) continue;
                const u = p.slice(0, idx).trim();
                const pw = p.slice(idx + 1).trim();
                if (u && pw) out[u] = pw;
            }
        }
        // Retrocompat: single-user
        if (process.env.DASHBOARD_USER && process.env.DASHBOARD_PASS) {
            out[process.env.DASHBOARD_USER] = process.env.DASHBOARD_PASS;
        }
        // Si no hay nada configurado, dejar default no-utilizable para no abrir todo
        if (Object.keys(out).length === 0) {
            out['__placeholder__'] = '__set_DASHBOARD_USERS__';
        }
        return out;
    }

    const users = buildUsers();
    const auth = basicAuth({
        users,
        challenge: true,
        realm: 'SouthTradersDashboard',
        unauthorizedResponse: () => 'Unauthorized'
    });

    // Helper: extraer username de req (basicAuth lo deja en req.auth.user)
    function whoami(req) {
        if (req && req.auth && req.auth.user) return req.auth.user;
        return 'anon';
    }

    // Helper: log de interacción
    async function logInteraction(phone, autor, tipo, detalle) {
        try {
            await pool.query(
                `INSERT INTO crm_interactions (contact_phone, autor, tipo, detalle) VALUES ($1, $2, $3, $4)`,
                [phone, autor, tipo, detalle || null]
            );
        } catch (e) {
            console.error('[crm_interactions] insert err:', e.message);
        }
    }

    // -----------------------------------------------------------------------
    // CACHÉ TEMPLATES META (1 hora)
    // -----------------------------------------------------------------------
    let templatesCache = { data: null, ts: 0 };
    const TEMPLATES_TTL = 60 * 60 * 1000;

    async function fetchTemplates() {
        const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
        const token = process.env.WHATSAPP_TOKEN;
        if (!wabaId || !token) {
            return { ok: false, error: 'WHATSAPP_BUSINESS_ACCOUNT_ID o WHATSAPP_TOKEN faltan' };
        }
        try {
            const url = `https://graph.facebook.com/v19.0/${wabaId}/message_templates?fields=name,language,status,components,category&limit=200`;
            const r = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 12000 });
            const list = (r.data && r.data.data) || [];
            const approved = list.filter(t => t.status === 'APPROVED');
            return { ok: true, templates: approved };
        } catch (e) {
            return { ok: false, error: (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message };
        }
    }

    // -----------------------------------------------------------------------
    // GET /dashboard/v2  - sirve el HTML
    // -----------------------------------------------------------------------
    app.get('/dashboard/v2', auth, function (req, res) {
        const htmlPath = path.join(__dirname, 'dashboard-v2.html');
        fs.readFile(htmlPath, 'utf8', function (err, data) {
            if (err) {
                res.status(500).send('Error cargando dashboard: ' + err.message);
                return;
            }
            // Inject username via meta tag for the frontend
            const injected = data.replace(
                '</head>',
                `<meta name="auth-user" content="${whoami(req)}"></head>`
            );
            res.set('Content-Type', 'text/html; charset=utf-8');
            res.send(injected);
        });
    });

    // -----------------------------------------------------------------------
    // GET /crm/contacts/full - lista con filtros
    // Query params: tipo, origen, region, vendedor, estado, q (texto libre)
    // -----------------------------------------------------------------------
    app.get('/crm/contacts/full', auth, async function (req, res) {
        try {
            const { tipo, origen, region, vendedor, estado, q } = req.query;
            const where = [];
            const params = [];

            if (tipo) { params.push(tipo); where.push(`tipo = $${params.length}`); }
            if (origen) {
                if (origen === '__null__') {
                    where.push(`origen IS NULL`);
                } else {
                    params.push(origen);
                    where.push(`origen = $${params.length}`);
                }
            }
            if (region) { params.push(region); where.push(`region = $${params.length}`); }
            if (vendedor) {
                if (vendedor === '__null__') {
                    where.push(`vendedor IS NULL`);
                } else {
                    params.push(vendedor);
                    where.push(`vendedor = $${params.length}`);
                }
            }
            if (estado) { params.push(estado); where.push(`status = $${params.length}`); }
            if (q && q.trim()) {
                params.push(`%${q.trim().toLowerCase()}%`);
                const i = params.length;
                where.push(`(LOWER(COALESCE(company,'')) LIKE $${i} OR LOWER(COALESCE(name,'')) LIKE $${i} OR LOWER(COALESCE(phone,'')) LIKE $${i} OR LOWER(COALESCE(email,'')) LIKE $${i} OR LOWER(COALESCE(ubicacion,'')) LIKE $${i})`);
            }

            const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

            const sql = `
                SELECT
                    c.id,
                    c.phone,
                    c.name,
                    c.company,
                    c.email,
                    c.country,
                    c.region,
                    c.ubicacion,
                    c.vendedor,
                    c.tipo,
                    c.origen,
                    c.fuente,
                    c.status,
                    c.tier,
                    c.notes,
                    c.respuesta,
                    c.feedback,
                    c.nota_compra,
                    c.last_contact,
                    c.created_at,
                    c.paused,
                    c.registered,
                    c.sheet_n,
                    (SELECT COUNT(*)::int FROM crm_interactions i WHERE i.contact_phone = c.phone) AS interactions_count,
                    (SELECT MAX(ts) FROM crm_interactions i WHERE i.contact_phone = c.phone) AS last_interaction_at
                FROM crm_contacts c
                ${whereSql}
                ORDER BY
                    CASE WHEN c.last_contact IS NULL THEN 1 ELSE 0 END,
                    c.last_contact DESC NULLS LAST,
                    c.id DESC
                LIMIT 1000
            `;

            const r = await pool.query(sql, params);
            res.json({ ok: true, count: r.rows.length, contacts: r.rows });
        } catch (e) {
            console.error('[contacts/full] err:', e);
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // -----------------------------------------------------------------------
    // GET /crm/contacts/facets - valores únicos para los filtros
    // -----------------------------------------------------------------------
    app.get('/crm/contacts/facets', auth, async function (req, res) {
        try {
            const r = await pool.query(`
                SELECT
                  (SELECT json_agg(t) FROM (SELECT DISTINCT tipo AS v, COUNT(*)::int AS n FROM crm_contacts WHERE tipo IS NOT NULL GROUP BY tipo ORDER BY n DESC) t) AS tipos,
                  (SELECT json_agg(t) FROM (SELECT DISTINCT origen AS v, COUNT(*)::int AS n FROM crm_contacts WHERE origen IS NOT NULL GROUP BY origen ORDER BY n DESC) t) AS origenes,
                  (SELECT json_agg(t) FROM (SELECT DISTINCT region AS v, COUNT(*)::int AS n FROM crm_contacts WHERE region IS NOT NULL GROUP BY region ORDER BY n DESC) t) AS regiones,
                  (SELECT json_agg(t) FROM (SELECT DISTINCT vendedor AS v, COUNT(*)::int AS n FROM crm_contacts WHERE vendedor IS NOT NULL GROUP BY vendedor ORDER BY n DESC) t) AS vendedores,
                  (SELECT json_agg(t) FROM (SELECT DISTINCT status AS v, COUNT(*)::int AS n FROM crm_contacts WHERE status IS NOT NULL GROUP BY status ORDER BY n DESC) t) AS estados,
                  (SELECT COUNT(*)::int FROM crm_contacts) AS total
            `);
            res.json({ ok: true, ...r.rows[0] });
        } catch (e) {
            console.error('[facets] err:', e);
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // -----------------------------------------------------------------------
    // PATCH /crm/contacts/:phone - editar contacto + log automático
    // -----------------------------------------------------------------------
    app.patch('/crm/contacts/:phone', auth, async function (req, res) {
        try {
            const phone = req.params.phone;
            const allowed = [
                'name', 'company', 'email', 'region', 'ubicacion', 'vendedor',
                'tipo', 'origen', 'fuente', 'status', 'tier',
                'notes', 'respuesta', 'feedback', 'nota_compra',
                'paused', 'registered'
            ];
            const sets = [];
            const params = [];
            const changed = {};
            for (const k of allowed) {
                if (Object.prototype.hasOwnProperty.call(req.body, k)) {
                    params.push(req.body[k]);
                    sets.push(`${k} = $${params.length}`);
                    changed[k] = req.body[k];
                }
            }
            if (sets.length === 0) {
                return res.status(400).json({ ok: false, error: 'no fields to update' });
            }
            params.push(phone);
            const sql = `UPDATE crm_contacts SET ${sets.join(', ')} WHERE phone = $${params.length} RETURNING *`;
            const r = await pool.query(sql, params);
            if (r.rowCount === 0) {
                return res.status(404).json({ ok: false, error: 'contact not found' });
            }
            // Log change
            await logInteraction(
                phone,
                whoami(req),
                'edit',
                'Cambios: ' + Object.entries(changed).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')
            );
            res.json({ ok: true, contact: r.rows[0] });
        } catch (e) {
            console.error('[patch contact] err:', e);
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // -----------------------------------------------------------------------
    // POST /crm/contacts - crear contacto manualmente
    // -----------------------------------------------------------------------
    app.post('/crm/contacts', auth, async function (req, res) {
        try {
            const b = req.body || {};
            if (!b.phone || !b.phone.trim()) {
                return res.status(400).json({ ok: false, error: 'phone required' });
            }
            const r = await pool.query(`
                INSERT INTO crm_contacts (phone, name, company, email, region, ubicacion, vendedor, tipo, origen, fuente, status, tier, notes)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                ON CONFLICT (phone) DO NOTHING
                RETURNING *
            `, [
                b.phone.trim(),
                b.name || null, b.company || null, b.email || null,
                b.region || null, b.ubicacion || null, b.vendedor || null,
                b.tipo || null, b.origen || null, b.fuente || null,
                b.status || 'Pendiente', b.tier || 'tier1', b.notes || null
            ]);
            if (r.rowCount === 0) {
                return res.status(409).json({ ok: false, error: 'phone ya existe' });
            }
            await logInteraction(b.phone.trim(), whoami(req), 'create', 'Contacto creado manualmente');
            res.json({ ok: true, contact: r.rows[0] });
        } catch (e) {
            console.error('[post contact] err:', e);
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // -----------------------------------------------------------------------
    // GET /crm/interactions/:phone - log de un contacto
    // -----------------------------------------------------------------------
    app.get('/crm/interactions/:phone', auth, async function (req, res) {
        try {
            const r = await pool.query(
                `SELECT id, autor, tipo, detalle, ts FROM crm_interactions WHERE contact_phone = $1 ORDER BY ts DESC LIMIT 200`,
                [req.params.phone]
            );
            res.json({ ok: true, interactions: r.rows });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // -----------------------------------------------------------------------
    // POST /crm/interactions - crear interacción manual (nota, llamada, etc)
    // body: { phone, tipo, detalle }
    // -----------------------------------------------------------------------
    app.post('/crm/interactions', auth, async function (req, res) {
        try {
            const { phone, tipo, detalle } = req.body || {};
            if (!phone || !tipo) {
                return res.status(400).json({ ok: false, error: 'phone y tipo son requeridos' });
            }
            await logInteraction(phone, whoami(req), tipo, detalle);
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // -----------------------------------------------------------------------
    // POST /crm/contact/:phone/sofia - dispara mensaje 1-a-1 via Sofía
    // body: { templateName, language, mode } | { text }
    // mode: 'template' (usa template aprobado) | 'free' (texto libre, solo si hay sesión 24h)
    // -----------------------------------------------------------------------
    app.post('/crm/contact/:phone/sofia', auth, async function (req, res) {
        const phone = req.params.phone;
        const phoneId = process.env.PHONE_NUMBER_ID;
        const token = process.env.WHATSAPP_TOKEN;
        if (!phoneId || !token) {
            return res.status(500).json({ ok: false, error: 'PHONE_NUMBER_ID o WHATSAPP_TOKEN faltan' });
        }

        const { mode = 'template', templateName, language = 'es_AR', text, parameters } = req.body || {};
        const targetPhone = phone.replace(/^\+/, '');

        try {
            let payload;
            if (mode === 'template') {
                if (!templateName) {
                    return res.status(400).json({ ok: false, error: 'templateName requerido en mode=template' });
                }
                const template = { name: templateName, language: { code: language } };
                // If template has placeholders, parameters must be passed as components
                if (Array.isArray(parameters) && parameters.length > 0) {
                    template.components = [{
                        type: 'body',
                        parameters: parameters.map(p => ({ type: 'text', text: String(p == null ? '' : p) }))
                    }];
                }
                payload = {
                    messaging_product: 'whatsapp',
                    to: targetPhone,
                    type: 'template',
                    template
                };
            } else if (mode === 'free') {
                if (!text) return res.status(400).json({ ok: false, error: 'text requerido en mode=free' });
                payload = {
                    messaging_product: 'whatsapp',
                    to: targetPhone,
                    type: 'text',
                    text: { body: text }
                };
            } else {
                return res.status(400).json({ ok: false, error: 'mode invalido' });
            }

            const url = `https://graph.facebook.com/v19.0/${phoneId}/messages`;
            const r = await axios.post(url, payload, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: 12000
            });

            await logInteraction(
                phone,
                whoami(req),
                mode === 'template' ? 'sofia_template' : 'sofia_text',
                mode === 'template'
                    ? `Template: ${templateName} (${language})${Array.isArray(parameters) && parameters.length ? ' · params: ' + parameters.map(p => '[' + String(p).slice(0,50) + ']').join(' ') : ''}`
                    : `Texto: ${text.slice(0, 200)}`
            );

            // Bump last_contact
            try {
                await pool.query(`UPDATE crm_contacts SET last_contact = NOW() WHERE phone = $1`, [phone]);
            } catch (e) { /* ignore */ }

            res.json({ ok: true, response: r.data });
        } catch (e) {
            const errMsg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
            await logInteraction(phone, whoami(req), 'sofia_error', errMsg.slice(0, 300));
            res.status(500).json({ ok: false, error: errMsg });
        }
    });

    // -----------------------------------------------------------------------
    // GET /templates  - templates aprobados (Meta) con caché 1h
    // -----------------------------------------------------------------------
    app.get('/templates', auth, async function (req, res) {
        if (templatesCache.data && (Date.now() - templatesCache.ts) < TEMPLATES_TTL) {
            return res.json({ ok: true, cached: true, templates: templatesCache.data });
        }
        const r = await fetchTemplates();
        if (r.ok) {
            templatesCache = { data: r.templates, ts: Date.now() };
            return res.json({ ok: true, cached: false, templates: r.templates });
        }
        res.status(500).json({ ok: false, error: r.error });
    });

    // -----------------------------------------------------------------------
    // POST /upload-contacts - bulk upload (CSV o JSON)
    // body: { contacts: [{phone, name, company, ...}] }
    // -----------------------------------------------------------------------
    app.post('/upload-contacts', auth, async function (req, res) {
        try {
            const list = (req.body && req.body.contacts) || [];
            if (!Array.isArray(list) || list.length === 0) {
                return res.status(400).json({ ok: false, error: 'contacts array requerido' });
            }
            let inserted = 0, skipped = 0;
            for (const c of list) {
                if (!c.phone) { skipped++; continue; }
                try {
                    const r = await pool.query(`
                        INSERT INTO crm_contacts (phone, name, company, email, region, ubicacion, vendedor, tipo, origen, fuente, status, tier, notes)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                        ON CONFLICT (phone) DO NOTHING
                    `, [
                        c.phone, c.name || null, c.company || null, c.email || null,
                        c.region || null, c.ubicacion || null, c.vendedor || null,
                        c.tipo || null, c.origen || null, c.fuente || null,
                        c.status || 'Pendiente', c.tier || 'tier1', c.notes || null
                    ]);
                    if (r.rowCount > 0) inserted++;
                    else skipped++;
                } catch (e) { skipped++; }
            }
            await logInteraction('__bulk__', whoami(req), 'bulk_upload', `Insertados: ${inserted}, omitidos: ${skipped}`);
            res.json({ ok: true, inserted, skipped, total: list.length });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // -----------------------------------------------------------------------
    // CAMPAÑAS OUTBOUND
    // -----------------------------------------------------------------------
    const RATE_LIMIT_MS = 10000; // 10s entre mensajes (no banearse)
    const campaigns = new Map(); // id -> { id, status, total, sent, failed, errors, createdBy, createdAt, finishedAt }

    function newCampaignId() {
        return 'camp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    async function runCampaign(campaignId, contacts, templateName, language, parametersTemplate) {
        const camp = campaigns.get(campaignId);
        const phoneId = process.env.PHONE_NUMBER_ID;
        const token = process.env.WHATSAPP_TOKEN;
        const url = `https://graph.facebook.com/v19.0/${phoneId}/messages`;

        for (const c of contacts) {
            const target = String(c.phone || '').replace(/^\+/, '');
            if (!target) {
                camp.failed++;
                continue;
            }
            try {
                const template = { name: templateName, language: { code: language } };
                if (Array.isArray(parametersTemplate) && parametersTemplate.length > 0) {
                    // Resolve placeholders per contact:
                    // - Empty string or null -> use contact name/company as fallback
                    // - Literal string "{nombre}" -> use contact name (explicit token)
                    // - Otherwise -> use literal value (same for all contacts)
                    const resolved = parametersTemplate.map(p => {
                        if (p === null || p === undefined || p === '') {
                            return c.name || c.company || 'cliente';
                        }
                        const s = String(p);
                        if (s === '{nombre}' || s === '{name}') return c.name || c.company || 'cliente';
                        if (s === '{empresa}' || s === '{company}') return c.company || c.name || 'cliente';
                        return s;
                    });
                    template.components = [{
                        type: 'body',
                        parameters: resolved.map(v => ({ type: 'text', text: String(v) }))
                    }];
                }
                await axios.post(url, {
                    messaging_product: 'whatsapp',
                    to: target,
                    type: 'template',
                    template
                }, {
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    timeout: 15000
                });
                camp.sent++;
                logInteraction(c.phone, camp.createdBy, 'campaign', `Campaña ${campaignId} (${templateName})`).catch(() => {});
                pool.query(`UPDATE crm_contacts SET last_contact = NOW() WHERE phone = $1`, [c.phone]).catch(() => {});
            } catch (e) {
                camp.failed++;
                const msg = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
                camp.errors.push({ phone: c.phone, error: msg.slice(0, 200) });
                logInteraction(c.phone, camp.createdBy, 'campaign_error', msg.slice(0, 200)).catch(() => {});
            }
            await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
        }
        camp.status = 'finished';
        camp.finishedAt = new Date().toISOString();
    }

    // POST /campaigns - dispara campaña
    // body: { templateName, language, parameters: [...], phones: [...] | filter: {...} }
    app.post('/campaigns', auth, async function (req, res) {
        try {
            const { templateName, language = 'es_AR', phones, filter, parameters } = req.body || {};
            if (!templateName) return res.status(400).json({ ok: false, error: 'templateName requerido' });

            let contacts = [];
            if (Array.isArray(phones) && phones.length > 0) {
                const r = await pool.query(`SELECT phone, name, company FROM crm_contacts WHERE phone = ANY($1::text[])`, [phones]);
                contacts = r.rows;
            } else if (filter && typeof filter === 'object') {
                const where = [];
                const params = [];
                for (const k of ['tipo', 'origen', 'region', 'vendedor']) {
                    if (filter[k]) { params.push(filter[k]); where.push(`${k} = $${params.length}`); }
                }
                if (filter.estado) { params.push(filter.estado); where.push(`status = $${params.length}`); }
                where.push(`paused IS NOT TRUE`);
                where.push(`phone NOT LIKE '__nophone%'`);
                const sql = `SELECT phone, name, company FROM crm_contacts WHERE ${where.join(' AND ')}`;
                const r = await pool.query(sql, params);
                contacts = r.rows;
            } else {
                return res.status(400).json({ ok: false, error: 'phones o filter requerido' });
            }

            if (contacts.length === 0) {
                return res.status(400).json({ ok: false, error: 'sin destinatarios' });
            }

            const id = newCampaignId();
            const camp = {
                id,
                status: 'running',
                templateName,
                language,
                total: contacts.length,
                sent: 0,
                failed: 0,
                errors: [],
                createdBy: whoami(req),
                createdAt: new Date().toISOString(),
                finishedAt: null
            };
            campaigns.set(id, camp);

            // Run async
            runCampaign(id, contacts, templateName, language, parameters).catch(e => {
                camp.status = 'errored';
                camp.errors.push({ phone: null, error: e.message });
            });

            res.json({
                ok: true,
                campaignId: id,
                queued: contacts.length,
                estimatedSeconds: Math.ceil(contacts.length * RATE_LIMIT_MS / 1000),
                statusUrl: `/campaign/${id}/status`
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // GET /campaign/:id/status
    app.get('/campaign/:id/status', auth, function (req, res) {
        const c = campaigns.get(req.params.id);
        if (!c) return res.status(404).json({ ok: false, error: 'campaign not found' });
        res.json({ ok: true, campaign: c });
    });

    // GET /campaigns - lista todas (en memoria)
    app.get('/campaigns', auth, function (req, res) {
        const arr = [...campaigns.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        res.json({ ok: true, campaigns: arr });
    });

    console.log('[dashboard-routes] mounted: ' + Object.keys(users).join(', '));
};
