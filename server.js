'use strict';
/*
 * Print&Play — мини-сервер лендинга.
 * Только встроенные модули Node.js. Никаких npm-зависимостей.
 *
 * Что делает:
 *   1. Отдаёт статический сайт (index.html, /assets).
 *   2. Принимает заявку POST /api/lead (JSON) и отправляет письмо через
 *      Unisender Go (транзакционная почта) с фото-вложениями.
 *   3. Текст каждой заявки дублирует в leads.log — на случай сбоя почты.
 *
 * Фото по умолчанию НЕ сохраняются на диск (экономия места): они улетают
 * вложением в письме. Если нужен бэкап фото на сервере — в config.json
 * выставьте "saveUploads": true.
 *
 * Запуск:  node server.js
 * Настройка: создайте config.json (см. config.example.json) ИЛИ задайте
 *            переменные окружения. Переменные окружения важнее config.json.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const LEADS_LOG = path.join(ROOT, 'leads.log');

// ---------- Конфигурация ----------
function loadConfig() {
  let fromFile = {};
  const cfgPath = path.join(ROOT, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { fromFile = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (e) { console.error('[config] Не удалось прочитать config.json:', e.message); }
  }
  const env = process.env;
  return {
    port:           Number(env.PORT || fromFile.port || 8080),
    host:           env.HOST || fromFile.host || '0.0.0.0',
    apiKey:         env.UNISENDER_API_KEY || fromFile.apiKey || '',
    senderName:     env.SENDER_NAME      || fromFile.senderName || 'Print&Play',
    senderEmail:    env.SENDER_EMAIL     || fromFile.senderEmail || '',   // адрес на подтверждённом домене
    recipientEmail: env.RECIPIENT_EMAIL  || fromFile.recipientEmail || '', // куда слать заявки (можно через запятую)
    subjectPrefix:  env.SUBJECT_PREFIX   || fromFile.subjectPrefix || 'Заявка с сайта Print&Play',
    // фото на диск не сохраняем по умолчанию — экономим место на сервере
    saveUploads:    String(env.SAVE_UPLOADS ?? fromFile.saveUploads ?? 'false') === 'true',
  };
}
const CONFIG = loadConfig();

// Endpoint Unisender Go (RU). Запасные: go1.unisender.ru / go2.unisender.ru
const UG_HOST = 'goapi.unisender.ru';
const UG_PATH = '/ru/transactional/api/v1/email/send.json';

const MAX_BODY = 12 * 1024 * 1024; // 12 МБ на запрос (лимит письма Unisender Go — 10 МБ)
const MAX_FILES = 6;
const MAX_FILE_BYTES = 7 * 1024 * 1024; // один файл

// ---------- Утилиты ----------
function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function nl2br(s) { return escapeHtml(s).replace(/\n/g, '<br>'); }

const CT = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
};

// Простейший анти-флуд: не больше N заявок с одного IP за окно
const rate = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 60 * 60 * 1000, limit = 20;
  const rec = rate.get(ip) || { n: 0, t: now };
  if (now - rec.t > win) { rec.n = 0; rec.t = now; }
  rec.n++; rate.set(ip, rec);
  return rec.n > limit;
}

// ---------- Разбор приложенных фото ----------
// Возвращает { attachments:[{type,name,content}], saved:[имена файлов] }
// На диск пишем только если CONFIG.saveUploads === true.
function parseFiles(files) {
  const attachments = [], saved = [];
  if (CONFIG.saveUploads) ensureUploadDir();
  (files || []).slice(0, MAX_FILES).forEach((f, i) => {
    if (!f || typeof f.dataUrl !== 'string') return;
    const m = f.dataUrl.match(/^data:(image\/(png|jpe?g|webp|gif));base64,(.+)$/);
    if (!m) return;
    const mime = m[1];
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    const b64 = m[3];
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > MAX_FILE_BYTES) return;
    attachments.push({ type: mime, name: `foto-${i + 1}.${ext}`, content: b64 });
    if (CONFIG.saveUploads) {
      try {
        const disk = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${i}.${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, disk), buf);
        saved.push(disk);
      } catch (e) { console.error('[upload]', e.message); }
    }
  });
  return { attachments, saved };
}

// ---------- Тело письма ----------
function buildEmailBody(lead, attachCount) {
  const rows = [
    ['Имя', escapeHtml(lead.name)],
    ['Контакт', escapeHtml(lead.contact)],
    ['Описание', nl2br(lead.desc) || '<i>не указано</i>'],
    ['Страница', escapeHtml(lead.page || '')],
    ['Время', new Date().toLocaleString('ru-RU')],
  ].map(([k, v]) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#888;vertical-align:top;white-space:nowrap">${k}</td>` +
    `<td style="padding:6px 0;color:#15171C">${v}</td></tr>`).join('');

  const photos = attachCount
    ? `<p style="font-family:sans-serif;color:#444;margin-top:18px">📎 Фото к заявке: <b>${attachCount}</b> шт. — см. вложения.</p>`
    : `<p style="font-family:sans-serif;color:#888;margin-top:18px">Фото не приложены.</p>`;

  return `<div style="font-family:sans-serif;max-width:640px">
    <h2 style="margin:0 0 14px">🖨️ Новая заявка с сайта Print&amp;Play</h2>
    <table style="border-collapse:collapse;font-size:15px">${rows}</table>
    ${photos}
  </div>`;
}

// ---------- Отправка через Unisender Go ----------
function sendMail({ recipients, subject, html, attachments }) {
  return new Promise((resolve, reject) => {
    const message = {
      recipients: recipients.map((e) => ({ email: e })),
      body: { html },
      subject,
      from_email: CONFIG.senderEmail,
      from_name: CONFIG.senderName,
      track_links: 0,
      track_read: 0,
    };
    if (attachments && attachments.length) message.attachments = attachments;
    const payload = JSON.stringify({ message });

    const req = https.request({
      method: 'POST',
      hostname: UG_HOST,
      path: UG_PATH,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-API-KEY': CONFIG.apiKey,
        'User-Agent': 'PrintPlay-Landing/1.0',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300 && json && json.status === 'success') {
          const failed = json.failed_emails && Object.keys(json.failed_emails);
          if (failed && failed.length) return reject(new Error('Адреса отклонены: ' + JSON.stringify(json.failed_emails)));
          return resolve(json);
        }
        const msg = (json && (json.message || json.error)) ? (json.message || json.error) : ('HTTP ' + res.statusCode + ' ' + String(data).slice(0, 200));
        return reject(new Error('Unisender Go: ' + msg + (json && json.code ? ' [code ' + json.code + ']' : '')));
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Таймаут запроса к Unisender Go')));
    req.write(payload);
    req.end();
  });
}

// ---------- Обработка заявки ----------
function handleLead(req, res, ip) {
  if (rateLimited(ip)) return sendJson(res, 429, { ok: false, error: 'Слишком много заявок. Попробуйте позже.' });

  let raw = '', tooBig = false;
  req.on('data', (c) => {
    raw += c;
    if (raw.length > MAX_BODY) { tooBig = true; req.destroy(); }
  });
  req.on('end', async () => {
    if (tooBig) return sendJson(res, 413, { ok: false, error: 'Слишком большой объём данных. Уменьшите число или размер фото.' });
    let lead;
    try { lead = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { ok: false, error: 'Некорректный запрос.' }); }

    lead.name = String(lead.name || '').trim().slice(0, 200);
    lead.contact = String(lead.contact || '').trim().slice(0, 200);
    lead.desc = String(lead.desc || '').trim().slice(0, 4000);
    if (!lead.name || !lead.contact) return sendJson(res, 400, { ok: false, error: 'Заполните имя и контакт.' });

    // 1) фото: вложения (+ опц. бэкап на диск)
    let attachments = [], saved = [];
    try { ({ attachments, saved } = parseFiles(lead.files)); } catch (e) { console.error('[files]', e.message); }

    // 2) бэкап текста заявки в leads.log (всегда; фото в логе — только имена, если сохранялись)
    try {
      fs.appendFileSync(LEADS_LOG, JSON.stringify({
        ts: new Date().toISOString(), ip, name: lead.name, contact: lead.contact,
        desc: lead.desc, photos: saved.length || attachments.length, files: saved, page: lead.page || '',
      }) + '\n');
    } catch (e) { console.error('[leads.log]', e.message); }

    // 3) проверка настроек
    if (!CONFIG.apiKey || !CONFIG.senderEmail || !CONFIG.recipientEmail) {
      console.warn('[lead] Unisender Go не настроен — заявка записана только в leads.log.');
      console.warn('       Заполните config.json: apiKey, senderEmail, recipientEmail.');
      console.log('[lead]', lead.name, '|', lead.contact, '|', attachments.length, 'фото');
      return sendJson(res, 200, { ok: true, mail: false, mailError: 'not-configured' });
    }

    // 4) письмо. Заявка уже сохранена, поэтому посетителю в любом случае
    //    показываем успех; статус письма — внутреннее дело студии (поле mail).
    const subject = `${CONFIG.subjectPrefix}: ${lead.name}`;
    const html = buildEmailBody(lead, attachments.length);
    const recipients = CONFIG.recipientEmail.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      await sendMail({ recipients, subject, html, attachments });
      console.log('[lead] письмо отправлено:', lead.name, '|', lead.contact, '|', attachments.length, 'фото');
      return sendJson(res, 200, { ok: true, mail: true });
    } catch (e) {
      console.error('[unisender] письмо НЕ отправлено:', e.message, '— заявка в leads.log сохранена');
      try {
        fs.appendFileSync(LEADS_LOG, JSON.stringify({
          ts: new Date().toISOString(), mailError: e.message, name: lead.name, contact: lead.contact,
        }) + '\n');
      } catch (_) {}
      return sendJson(res, 200, { ok: true, mail: false, mailError: e.message });
    }
  });
}

// ---------- Статика ----------
function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch (e) { return sendText(res, 400, 'Bad request'); }
  if (pathname === '/') pathname = '/index.html';

  // Наружу отдаём ТОЛЬКО страницу и /assets. Никаких config.json (с API-ключом),
  // server.js, leads.log или uploads/ с фото клиентов.
  const allowed = pathname === '/index.html' || pathname.startsWith('/assets/');
  if (!allowed) return sendText(res, 404, 'Не найдено');

  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) return sendText(res, 403, 'Forbidden'); // защита от ../

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Не найдено');
    res.writeHead(200, {
      'Content-Type': CT[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- Хелперы ответа ----------
function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// ---------- Сервер ----------
const server = http.createServer((req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'POST' && req.url === '/api/lead') return handleLead(req, res, ip);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  return sendText(res, 405, 'Method not allowed');
});

if (CONFIG.saveUploads) ensureUploadDir();
server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`Print&Play сервер запущен:  http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`Фото на диск: ${CONFIG.saveUploads ? 'СОХРАНЯЮТСЯ (uploads/)' : 'не сохраняются (только вложением в письме)'}`);
  if (!CONFIG.apiKey) console.warn('⚠  Unisender Go не настроен — заявки пишутся только в leads.log. Создайте config.json.');
});
