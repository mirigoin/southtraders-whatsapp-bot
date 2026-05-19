# Claudia — Memoria del proyecto

Este archivo es la memoria persistente para trabajar sobre el bot. Claude lo lee
automáticamente al iniciar cada sesión sobre este repo.

## Qué es

WhatsApp Bot de **South Traders Corp** — distribuidor oficial Apple en Miami,
ventas mayoristas (iPhone, MacBook, iPad, AirPods, Samsung, accesorios) para
LATAM, Caribe y el mundo.

- **Sophia** = la persona del bot (lo que ve el cliente en WhatsApp).
- **Claudia** = nombre interno del proyecto / cómo nos referimos a este sistema
  cuando hablamos entre nosotros.

## Arquitectura (alto nivel)

- `index.js` — servidor principal del bot. Webhook de WhatsApp, lógica de
  conversación, llamadas a Claude (modelo `claude-haiku-4-5`), system prompt
  de Sophia (función `buildPrompt`), integración con stock de Pangea.
- `dashboard-routes.js` + `dashboard-v2.html` + `dashboard.html` — panel de
  administración (vista de conversaciones, leads, métricas).
- `package.json` / `render.yaml` — deploy en Render.
- Stock real-time desde Pangea (cache en memoria `stockData`, ya no lee de
  Northtraders).

## Reglas de trabajo

- **Idioma**: respondeme en español rioplatense, directo, sin vueltas.
- **Estilo de cambios**: ediciones quirúrgicas. No refactorizar de paso, no
  agregar abstracciones "por si acaso", no tocar lo que no me pediste.
- **Antes de tocar el system prompt de Sophia** (`buildPrompt` en `index.js`):
  avisame qué vas a cambiar y por qué, ese prompt es delicado y afecta cómo
  Sophia trata a clientes reales.
- **Deploy**: Render auto-deploya desde `main`. Las ramas `claude/*` son de
  trabajo, no se mergean automático.
- **Commits**: mensajes claros en español, una línea de "qué" + opcional "por
  qué". Nunca push directo a `main` sin confirmación explícita.

## Decisiones tomadas

(Acá vamos guardando decisiones importantes para no re-discutirlas. Vacío por
ahora — agregar a medida que aparezcan.)

## Pendientes / ideas

(Lista viva. Agregar acá cosas que mencionemos pero no implementemos en el
momento.)

## Notas operativas

- Horario comercial: Lun-Vie 9am-5pm ET.
- Email de ventas: sales@south-traders.com
- Stock público (sin precios): https://south-traders.pangea.ar/n6/stock_disp
- Warehouse: Doral, Miami (dirección exacta NO se comparte en chat).
