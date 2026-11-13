/**
 * ============================================================================
 * Proyecto: Conversor de YouTube a MP3 y Uploader para Supabase Chat
 * Archivo: server.js
 * Versión: 1.9.12
 * Descripción: Servidor Express optimizado y enfocado en YouTube:
 *              - Soporte de certificados SSL universales (--no-check-certificates)
 *              - Prevención de bloqueos por validación de certificado en Windows/Linux
 *              - Descarga y transcodificación acelerada con Node runtime y rotación de clientes
 *              - Búsqueda extendida en YouTube (hasta 50 resultados por consulta)
 *              - Barra interactiva de previsualización y pre-escucha antes de descargar
 *              - Pipeline de conversión YouTube a MP3 de alta fidelidad (yt-dlp + FFmpeg)
 *              - Soporte nativo de JS runtime (--js-runtimes node) para n-tokens
 *              - Reintentos automáticos con rotación de clientes contra HTTP 403 Forbidden
 *              - Deduplicación por hash SHA-256 en Cloudflare R2 y gestión de álbumes
 *              - Soporte multiplataforma nativo (Windows y Linux para Render.com)
 *              - Prevención y manejo amigable de errores de puerto ocupado (EADDRINUSE)
 * ============================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const https = require('https');

// --- Fix SSL para fetch nativo en Node 24 con certificados intermedios en Windows ---
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * fetchInsecure — igual que fetch() pero con rejectUnauthorized:false
 * Usar sólo para llamadas internas a Cloudflare Workers / Supabase en entorno local Windows.
 */
function fetchInsecure(url, options = {}) {
    return fetch(url, { ...options, agent: insecureAgent });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Supabase y Media API (Cloudflare Worker R2)
const SUPABASE_URL = "https://avdklsfhaoznpzqlxapc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2ZGtsc2ZoYW96bnB6cWx4YXBjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM4OTc2MTgsImV4cCI6MjEwOTQ3MzYxOH0.8piH_mC0qvfyka3Vrcc00Ij6DLSZxPFRuwkg5HkX9-Y";
const MEDIA_API_URL = "https://chat-media.latamdia4.workers.dev";

// Rutas de directorios y ejecutables multiplataforma (Windows vs Linux)
const ROOT_DIR = __dirname;
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const TEMP_DIR = path.join(ROOT_DIR, 'temp_audio');

const isWin = process.platform === 'win32';
const YTDLP_BIN = path.join(BIN_DIR, isWin ? 'yt-dlp.exe' : 'yt-dlp');
const FFMPEG_BIN = path.join(BIN_DIR, isWin ? 'ffmpeg.exe' : 'ffmpeg');

// Asegurar existencia de carpetas requeridas
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}
if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
}

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Confiar en cabeceras de proxy inverso (necesario en Render para HTTPS correcto)
app.enable('trust proxy');

// Servir frontend y recursos estáticos
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use('/js', express.static(path.join(ROOT_DIR, 'js')));

/**
 * Función auxiliar para limpiar nombres de archivo de caracteres no permitidos
 */
function sanitizeFileName(name) {
    if (!name) return 'cancion';
    return name
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Función de pausa asíncrona para retroceso exponencial en reintentos
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Ejecutar procesos de forma asíncrona mediante promesas
 */
function runProcess(cmdPath, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmdPath, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', data => { stdout += data.toString(); });
        proc.stderr.on('data', data => { stderr += data.toString(); });

        proc.on('close', code => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`El proceso falló con código ${code}: ${stderr || stdout}`));
            }
        });

        proc.on('error', err => {
            reject(err);
        });
    });
}

/**
 * Formatear segundos a cadena MM:SS o HH:MM:SS
 */
function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// ─── Soporte de Cookies y Proxy de YouTube (Protección Anti-Bot y Anti-429 en Render/VPS) ───
const COOKIES_FILE = path.join(ROOT_DIR, 'cookies.txt');
const TEMP_COOKIES_FILE = path.join(TEMP_DIR, 'yt_cookies.txt');

// ─── Probador automático de cookies [v1.9.13] ───
// Prueba cada archivo de cookies (cookies_test/*.txt + cookies.txt) contra YouTube con yt-dlp,
// reporta cuál funcionó y cuál falló (y por qué), y activa automáticamente la primera que sirva.
const COOKIE_CANDIDATES_DIR = path.join(ROOT_DIR, 'cookies_test');
const ACTIVE_COOKIES_FILE = path.join(TEMP_DIR, 'yt_cookies_active.txt');
const COOKIE_TEST_VIDEO_ID = 'jNQXAC9IVRw'; // "Me at the zoo": video público y estable
const COOKIE_TEST_TIMEOUT_MS = 30000;
let proxyMarkedDead = false;

const cookieTestState = {
    running: false,
    startedAt: null,
    finishedAt: null,
    proxyConfigured: false,
    cookies: [],      // [{ name, ok, converted, attempts: [{ via, ok, ms, error }] }]
    baseline: [],     // pruebas SIN cookies para distinguir "IP bloqueada" de "cookie mala"
    winner: null,     // { name, via }
    summary: ''
};

/** Devuelve el proxy configurado (o null). Con ignoreDead=true ignora la marca de "proxy caído". */
function getConfiguredProxy(ignoreDead = false) {
    if (proxyMarkedDead && !ignoreDead) return null;
    const p = process.env.YOUTUBE_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    return p && p.trim() ? p.trim() : null;
}

/**
 * Normaliza un archivo Netscape. Si viene de un web-proxy (ej. elgatobypasses.org) con cookies
 * de dominio ajeno y nombres tipo "PREF@youtube.com" / "__-YNID@youtube.com", las convierte a
 * dominio .youtube.com y restaura el prefijo __Secure-.
 */
function normalizeCookieContent(raw) {
    const out = ['# Netscape HTTP Cookie File'];
    let converted = false;
    let kept = 0;
    for (const line of String(raw).replace(/\r/g, '').split('\n')) {
        if (!line.trim()) continue;
        if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
        const p = line.split('\t');
        if (p.length !== 7) continue;
        let [domain, sub, cpath, secure, exp, name, value] = p;
        if (!/youtube\.com$/i.test(domain)) {
            if (!name.endsWith('@youtube.com')) continue; // cookies propias del web-proxy: se descartan
            domain = '.youtube.com';
            name = name.slice(0, -'@youtube.com'.length).replace(/^__-/, '__Secure-');
            converted = true;
        }
        out.push([domain, sub, cpath, secure, exp, name, value].join('\t'));
        kept++;
    }
    return { content: out.join('\n') + '\n', kept, converted };
}

/** Traduce errores crudos de yt-dlp a una causa corta y legible. */
function classifyYtError(msg) {
    const m = String(msg || '');
    if (/cookies/i.test(m) && /no longer valid|rotated/i.test(m)) return 'YouTube invalidó/rotó estas cookies';
    if (/Sign in to confirm|not a bot/i.test(m)) return 'YouTube pidió verificación anti-bot (IP o sesión marcada)';
    if (/HTTP Error 429|Too Many Requests/i.test(m)) return 'YouTube limitó la IP (HTTP 429)';
    if (/ENOENT/i.test(m)) return 'No se encontró yt-dlp en la carpeta bin/';
    if (/timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|Unable to connect|Tunnel connection failed|Proxy/i.test(m)) {
        return 'Sin respuesta de la conexión (timeout / proxy caído)';
    }
    const errLine = m.split('\n').reverse().find(l => /ERROR/i.test(l)) || m.split('\n')[0] || 'Error desconocido';
    return errLine.replace(/^.*ERROR:\s*/i, '').slice(0, 160);
}

/** Ejecuta un proceso con tiempo límite duro (mata el proceso si se cuelga). */
function runProcessTimeout(cmdPath, args, ms) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmdPath, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, ms);
        proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
            clearTimeout(timer);
            if (timedOut) return reject(new Error(`timeout tras ${Math.round(ms / 1000)}s`));
            if (code === 0) return resolve({ stdout, stderr });
            reject(new Error(`código ${code}: ${stderr || stdout}`));
        });
        proc.on('error', err => { clearTimeout(timer); reject(err); });
    });
}

/** Un intento: extrae info del video de prueba con (o sin) cookies, por proxy o directo. */
async function testCookieAttempt(cookiePath, proxy) {
    const args = [
        '--no-check-certificates',
        '--socket-timeout', '10',
        '--js-runtimes', 'node',
        '--extractor-args', 'youtube:player_client=mweb,web',
        '--skip-download', '--no-playlist', '--no-warnings',
        '--print', '%(id)s'
    ];
    if (cookiePath) args.push('--cookies', cookiePath);
    if (proxy) args.push('--proxy', proxy);
    args.push(`https://www.youtube.com/watch?v=${COOKIE_TEST_VIDEO_ID}`);

    const t0 = Date.now();
    try {
        const { stdout } = await runProcessTimeout(YTDLP_BIN, args, COOKIE_TEST_TIMEOUT_MS);
        const ok = stdout.includes(COOKIE_TEST_VIDEO_ID);
        return { ok, ms: Date.now() - t0, error: ok ? null : 'yt-dlp no devolvió datos del video' };
    } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: classifyYtError(e.message) };
    }
}

/** Lista los archivos candidatos: cookies_test/*.txt, Secret Files de Render (/etc/secrets) y el cookies.txt de la raíz. */
function listCookieCandidates() {
    const list = [];
    const seen = new Set();
    const addDir = (dir, filter, prefix) => {
        try {
            for (const f of fs.readdirSync(dir).sort()) {
                if (!/\.txt$/i.test(f) || !filter(f) || seen.has(f)) continue;
                const full = path.join(dir, f);
                if (!fs.statSync(full).isFile()) continue;
                seen.add(f);
                list.push({ name: prefix + f, file: full });
            }
        } catch (e) { /* carpeta inexistente: se ignora */ }
    };
    addDir(COOKIE_CANDIDATES_DIR, () => true, '');
    addDir('/etc/secrets', f => /cookie/i.test(f), '[secret] '); // Render > Environment > Secret Files
    if (fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 10) {
        list.push({ name: 'cookies.txt (actual)', file: COOKIES_FILE });
    }
    return list;
}

function buildCookieSummary(st) {
    const okNames = st.cookies.filter(c => c.ok).map(c => c.name);
    const bad = st.cookies.filter(c => !c.ok).map(c => {
        const reasons = [...new Set(c.attempts.map(a => a.error).filter(Boolean))];
        return `${c.name} (${reasons.join(' / ') || 'falló'})`;
    });
    const lines = [];
    if (!st.cookies.length) return 'No hay archivos de cookies para probar (coloca .txt en cookies_test/).';
    lines.push(okNames.length ? `FUNCIONÓ: ${okNames.join(', ')}` : 'NINGUNA cookie funcionó.');
    if (bad.length) lines.push(`FALLÓ: ${bad.join('; ')}`);
    const baseOk = st.baseline.filter(b => b.ok).map(b => b.via);
    if (!okNames.length) {
        lines.push(baseOk.length
            ? `Sin cookies SÍ conecta (${baseOk.join(', ')}): el problema son las cookies, no la IP.`
            : 'Tampoco conecta sin cookies: el bloqueo es de la IP/proxy, no de las cookies.');
    }
    return lines.join('\n');
}

async function runCookieTests() {
    if (cookieTestState.running) return cookieTestState;

    // Reiniciar estado y revertir activaciones anteriores
    proxyMarkedDead = false;
    try { fs.unlinkSync(ACTIVE_COOKIES_FILE); } catch (e) { /* no existía */ }
    Object.assign(cookieTestState, {
        running: true, startedAt: Date.now(), finishedAt: null,
        cookies: [], baseline: [], winner: null, summary: '',
        proxyConfigured: !!getConfiguredProxy(true)
    });

    try {
        const rawProxy = getConfiguredProxy(true);
        const connections = rawProxy
            ? [{ via: 'proxy', proxy: rawProxy }, { via: 'directo', proxy: null }]
            : [{ via: 'directo', proxy: null }];
        const candidates = listCookieCandidates();
        const prepared = [];

        for (const [i, cand] of candidates.entries()) {
            const norm = normalizeCookieContent(fs.readFileSync(cand.file, 'utf8'));
            const tmp = path.join(TEMP_DIR, `cktest_${i}.txt`);
            fs.writeFileSync(tmp, norm.content, 'utf8');
            prepared.push({ ...cand, tmp, norm });
            cookieTestState.cookies.push({ name: cand.name, ok: false, converted: norm.converted, cookiesCount: norm.kept, attempts: [] });
        }

        // Pruebas base SIN cookies (aíslan problemas de IP/proxy)
        for (const conn of connections) {
            const r = await testCookieAttempt(null, conn.proxy);
            cookieTestState.baseline.push({ via: conn.via, ok: r.ok, ms: r.ms, error: r.error });
            console.log(`[CookieTest] Sin cookies (${conn.via}): ${r.ok ? 'OK' : 'FALLÓ - ' + r.error}`);
        }

        // Pruebas con cada archivo de cookies
        for (const [i, p] of prepared.entries()) {
            const entry = cookieTestState.cookies[i];
            for (const conn of connections) {
                const r = await testCookieAttempt(p.tmp, conn.proxy);
                entry.attempts.push({ via: conn.via, ok: r.ok, ms: r.ms, error: r.error });
                if (r.ok) entry.ok = true;
                console.log(`[CookieTest] ${p.name} (${conn.via}): ${r.ok ? 'OK' : 'FALLÓ - ' + r.error}`);
            }
            try { fs.unlinkSync(p.tmp); } catch (e) { /* ignorar */ }
        }

        // Si TODO lo que pasó por el proxy falló por conexión, marcarlo caído para no perder 10 s por intento
        if (rawProxy) {
            const viaProxy = [...cookieTestState.baseline, ...cookieTestState.cookies.flatMap(c => c.attempts)].filter(a => a.via === 'proxy');
            if (viaProxy.length && viaProxy.every(a => !a.ok && /Sin respuesta/.test(a.error || ''))) {
                proxyMarkedDead = true;
                console.warn('[CookieTest] El proxy no responde: se omitirá hasta la próxima prueba.');
            }
        }

        // Activar la primera cookie que funcionó (preferencia: la que pasa por el proxy configurado)
        const rank = c => (c.attempts.find(a => a.ok && a.via === 'proxy') ? 0 : 1);
        const winnerEntry = cookieTestState.cookies.filter(c => c.ok).sort((a, b) => rank(a) - rank(b))[0];
        if (winnerEntry) {
            const idx = cookieTestState.cookies.indexOf(winnerEntry);
            fs.writeFileSync(ACTIVE_COOKIES_FILE, prepared[idx].norm.content, 'utf8');
            const via = winnerEntry.attempts.filter(a => a.ok).map(a => a.via).join('+');
            cookieTestState.winner = { name: winnerEntry.name, via };
            console.log(`[CookieTest] Cookie activada: ${winnerEntry.name} (${via})`);
        }

        cookieTestState.summary = buildCookieSummary(cookieTestState);
    } catch (e) {
        cookieTestState.summary = `Error ejecutando la prueba de cookies: ${e.message}`;
        console.error('[CookieTest]', e);
    } finally {
        cookieTestState.running = false;
        cookieTestState.finishedAt = Date.now();
        console.log('[CookieTest] Resultado:\n' + cookieTestState.summary);
    }
    return cookieTestState;
}

/**
 * Resuelve la ruta al archivo de cookies de YouTube si existe:
 * 1. Archivo físico cookies.txt en la raíz del proyecto
 * 2. Variable de entorno YOUTUBE_COOKIES (o COOKIES_CONTENT / YT_COOKIES)
 * 3. Variable de entorno YOUTUBE_COOKIES_BASE64 (base64 sin saltos de línea rotos)
 */
function resolveCookiesPath() {
    if (fs.existsSync(ACTIVE_COOKIES_FILE) && fs.statSync(ACTIVE_COOKIES_FILE).size > 10) {
        return ACTIVE_COOKIES_FILE;
    }
    if (fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 10) {
        return COOKIES_FILE;
    }
    const rawCookies = process.env.YOUTUBE_COOKIES || process.env.COOKIES_CONTENT || process.env.YT_COOKIES;
    if (rawCookies && rawCookies.trim().length > 10) {
        try {
            let content = rawCookies.trim();
            // Des-escapar saltos de línea \n y tabs \t si fueron ingresados como caracteres literales en Render
            if (content.includes('\\n')) content = content.replace(/\\n/g, '\n');
            if (content.includes('\\t')) content = content.replace(/\\t/g, '\t');
            if (content.includes('\\r')) content = content.replace(/\\r/g, '\r');
            // Asegurar cabecera Netscape obligatoria para yt-dlp
            if (!content.startsWith('# Netscape HTTP Cookie File')) {
                content = '# Netscape HTTP Cookie File\n' + content;
            }
            fs.writeFileSync(TEMP_COOKIES_FILE, content, 'utf8');
            return TEMP_COOKIES_FILE;
        } catch (e) {
            console.warn('[Cookies] Error escribiendo TEMP_COOKIES_FILE:', e.message);
        }
    }
    if (process.env.YOUTUBE_COOKIES_BASE64 && process.env.YOUTUBE_COOKIES_BASE64.trim().length > 10) {
        try {
            let decoded = Buffer.from(process.env.YOUTUBE_COOKIES_BASE64.trim(), 'base64').toString('utf8');
            if (decoded.includes('\\n')) decoded = decoded.replace(/\\n/g, '\n');
            if (decoded.includes('\\t')) decoded = decoded.replace(/\\t/g, '\t');
            if (!decoded.startsWith('# Netscape HTTP Cookie File')) {
                decoded = '# Netscape HTTP Cookie File\n' + decoded;
            }
            fs.writeFileSync(TEMP_COOKIES_FILE, decoded, 'utf8');
            return TEMP_COOKIES_FILE;
        } catch (e) {
            console.warn('[Cookies] Error decodificando YOUTUBE_COOKIES_BASE64:', e.message);
        }
    }
    return null;
}

/**
 * Genera el arreglo base de argumentos para yt-dlp con bypass de certificados SSL,
 * soporte de JavaScript runtime, cookies automáticas y cliente seleccionado.
 */
function buildBaseYtDlpArgs(clientStrategy, extraArgs = [], useProxy = true, useCookies = true) {
    const args = [
        '--no-check-certificates',
        '--prefer-insecure',
        '--socket-timeout', useProxy ? '10' : '15',
        '--js-runtimes', 'node'
    ];

    if (clientStrategy) {
        args.push('--extractor-args', clientStrategy);
    }

    if (useCookies) {
        const cookiesPath = resolveCookiesPath();
        if (cookiesPath) {
            args.push('--cookies', cookiesPath);
        }
    }

    if (useProxy) {
        const proxy = getConfiguredProxy();
        if (proxy && proxy.trim()) {
            args.push('--proxy', proxy.trim());
        }
    }

    return args.concat(extraArgs);
}

/**
 * Formatea errores comunes de YouTube (como HTTP 429 Too Many Requests y Bot Detection)
 * para que el usuario reciba una explicación clara y la solución directa en Render.
 */
function formatYtDlpError(rawError) {
    const msg = String(rawError || '');
    if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('Sign in to confirm you’re not a bot') || msg.includes('bot')) {
        return 'YouTube bloqueó temporalmente la IP del servidor en la nube (Error 429: Bot Detection). Para solucionarlo en Render: ve a tu panel de Render -> Environment -> añade la variable "YOUTUBE_COOKIES" pegando el texto de tu cookies.txt de YouTube (exportado con la extensión "Get cookies.txt LOCALLY").';
    }
    return msg;
}


// ══════════════════════════════════════════════════════════════════════
// ENDPOINTS DE YOUTUBE (BÚSQUEDA EXTENDIDA, ANÁLISIS, CONVERSIÓN)
// ══════════════════════════════════════════════════════════════════════

/**
 * Endpoint: POST /api/youtube-search
 * Busca canciones en YouTube devolviendo una lista amplia (hasta 50 resultados)
 */
app.post('/api/youtube-search', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { query, limit = 20 } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'Debes ingresar un término de búsqueda.' });
    }

    const count = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    // Estrategias escalonadas: primero con proxy (si existe), luego conexión directa de rescate [v1.9.8]
    const strategies = [
        { client: 'youtube:player_client=visionos,android_vr', useProxy: true },
        { client: 'youtube:player_client=android_vr,visionos', useProxy: true },
        { client: 'youtube:player_client=ios,android', useProxy: false },
        { client: null, useProxy: false } // Fallback sin extractor-args ni proxy
    ];

    let lastError = null;
    for (let attempt = 1; attempt <= strategies.length; attempt++) {
        try {
            const strat = strategies[attempt - 1];
            const args = buildBaseYtDlpArgs(strat.client, [
                `ytsearch${count}:${query.trim()}`,
                '--dump-single-json',
                '--no-warnings',
                '--skip-download',
                '--flat-playlist'
            ], strat.useProxy);

            const { stdout } = await runProcess(YTDLP_BIN, args);
            const data = JSON.parse(stdout);
            const entries = data.entries || [];

            const results = entries.map(item => {
                const thumb = item.thumbnails && item.thumbnails.length > 0 
                    ? item.thumbnails[item.thumbnails.length - 1].url 
                    : (item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`);

                return {
                    id: item.id,
                    url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
                    title: item.title,
                    cleanTitle: sanitizeFileName(item.title.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s*\[[^\]]*\]\s*/g, ' ')),
                    uploader: item.uploader || item.channel || 'YouTube',
                    duration: item.duration || 0,
                    durationString: formatDuration(item.duration),
                    thumbnail: thumb
                };
            });

            return res.json({ query: query.trim(), total: results.length, results });
        } catch (err) {
            lastError = err;
            console.warn(`[YouTube Search] Intento ${attempt} falló para "${query}": ${err.message}. Reintentando con siguiente estrategia...`);
            if (attempt < strategies.length) await sleep(800);
        }
    }

    return res.status(500).json({
        error: `Error al buscar en YouTube: ${formatYtDlpError(lastError ? lastError.message : 'Error desconocido')}`
    });
});

/**
 * Endpoint: POST /api/playlist-info
 * Detecta y extrae todas las canciones de una lista de reproducción (Playlist) de YouTube
 */
app.post('/api/playlist-info', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'Debes proporcionar una URL válida de playlist.' });
    }

    try {
        const args = [
            '--no-check-certificates',
            '--js-runtimes', 'node',
            '--extractor-args', 'youtube:player_client=android,web',
            '--dump-single-json',
            '--no-warnings',
            '--flat-playlist',
            '--skip-download',
            url.trim()
        ];

        const { stdout } = await runProcess(YTDLP_BIN, args);
        const data = JSON.parse(stdout);

        const isPlaylist = Array.isArray(data.entries) && data.entries.length > 0;
        if (!isPlaylist) {
            return res.json({ isPlaylist: false });
        }

        const tracks = data.entries.map((item, index) => {
            const thumb = item.thumbnails && item.thumbnails.length > 0 
                ? item.thumbnails[item.thumbnails.length - 1].url 
                : (item.thumbnail || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`);

            return {
                index: index + 1,
                id: item.id,
                url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
                title: item.title,
                cleanTitle: sanitizeFileName(item.title.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s*\[[^\]]*\]\s*/g, ' ')),
                uploader: item.uploader || item.channel || '',
                duration: item.duration || 0,
                durationString: formatDuration(item.duration),
                thumbnail: thumb
            };
        });

        return res.json({
            isPlaylist: true,
            playlistTitle: sanitizeFileName(data.title || 'Playlist de YouTube'),
            trackCount: tracks.length,
            tracks
        });
    } catch (err) {
        console.error('Error al obtener playlist:', err);
        return res.status(500).json({ error: 'No se pudo leer la lista de reproducción. Verifica que sea pública.' });
    }
});

/**
 * Endpoint: POST /api/video-info
 * Extrae metadatos previos de un video individual con reintentos
 */
app.post('/api/video-info', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'Debes proporcionar una URL válida de YouTube.' });
    }

    const clientOptions = [
        'youtube:player_client=visionos,android_vr',
        'youtube:player_client=android_vr,visionos',
        'youtube:player_client=ios,android',
        'youtube:player_client=android,web'
    ];

    let lastError = null;
    for (let attempt = 1; attempt <= clientOptions.length; attempt++) {
        try {
            const clientArg = clientOptions[attempt - 1];
            const args = buildBaseYtDlpArgs(clientArg, [
                '--dump-single-json',
                '--no-warnings',
                '--no-playlist',
                '--skip-download',
                url.trim()
            ]);

            const { stdout } = await runProcess(YTDLP_BIN, args);
            const data = JSON.parse(stdout);

            return res.json({
                id: data.id,
                title: data.title,
                cleanTitle: sanitizeFileName(data.title.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s*\[[^\]]*\]\s*/g, ' ')),
                duration: data.duration,
                durationString: data.duration_string || formatDuration(data.duration),
                uploader: data.uploader || data.channel,
                thumbnail: data.thumbnail
            });
        } catch (err) {
            lastError = err;
            console.warn(`[Video Info] Intento ${attempt} falló para "${url}": ${err.message}`);
            if (attempt < clientOptions.length) await sleep(1000 * attempt);
        }
    }

    return res.status(500).json({
        error: `No se pudo obtener la información del video: ${formatYtDlpError(lastError ? lastError.message : 'Error desconocido')}`
    });
});

/**
 * Endpoint: POST /api/convert-and-upload
 * Orquesta la descarga de audio de YouTube con REINTENTOS AUTOMÁTICOS ante errores 403 Forbidden,
 * transcodificación a MP3, hash SHA-256, subida a R2 y registro en Supabase.
 */
app.post('/api/convert-and-upload', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { url, album, customTitle, accessToken, userId } = req.body;

    if (!url || !accessToken || !userId) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos (url, accessToken, userId).' });
    }

    const tempId = crypto.randomUUID();
    const tempFileTemplate = path.join(TEMP_DIR, `${tempId}.%(ext)s`);
    const expectedMp3Path = path.join(TEMP_DIR, `${tempId}.mp3`);

    const hasCookies = !!resolveCookiesPath();
    const hasProxy = !!getConfiguredProxy();

    // Matriz de estrategias escalonadas [v1.9.12]:
    // 1. Con cookies y con proxy (si están configurados)
    // 2. Con cookies y SIN proxy (por si el proxy se cayó o da timeout como 51.158.54.223)
    // 3. SIN cookies y SIN proxy con VisionOS (rescatador universal ante "Sign in to confirm you're not a bot")
    // 4. SIN cookies y con proxy (android,web)
    // 5. Conexión nativa de rescate
    const clientStrategies = [];

    if (hasCookies && hasProxy) {
        clientStrategies.push({ client: 'youtube:player_client=mweb,web', useProxy: true, useCookies: true, label: 'Cookies + Proxy (mweb,web)' });
        clientStrategies.push({ client: 'youtube:player_client=web,mweb', useProxy: false, useCookies: true, label: 'Cookies Directo Sin Proxy (Rescate por proxy caído)' });
    } else if (hasCookies) {
        clientStrategies.push({ client: 'youtube:player_client=mweb,web', useProxy: false, useCookies: true, label: 'Cookies Directo (mweb,web)' });
        clientStrategies.push({ client: 'youtube:player_client=web,mweb', useProxy: false, useCookies: true, label: 'Cookies Directo (web,mweb)' });
    }

    // Estrategias de rescate universal SIN COOKIES (eluden el bloqueo de bot detection)
    clientStrategies.push({ client: 'youtube:player_client=visionos,android_vr', useProxy: false, useCookies: false, label: 'Bypass Bot VisionOS Sin Cookies (Directo)' });
    if (hasProxy) {
        clientStrategies.push({ client: 'youtube:player_client=android_vr,visionos', useProxy: true, useCookies: false, label: 'Bypass AndroidVR Con Proxy Sin Cookies' });
    }
    clientStrategies.push({ client: 'youtube:player_client=ios,android', useProxy: false, useCookies: false, label: 'Bypass iOS Sin Cookies (Directo)' });
    clientStrategies.push({ client: null, useProxy: false, useCookies: false, label: 'Nativo Limpio Sin Extractor Args' });

    try {
        console.log(`[YouTube Convert] Iniciando pipeline de conversión para: ${url}`);
        console.log(`[YouTube Convert] Estado: Cookies=${hasCookies}, Proxy=${hasProxy}, Estrategias=${clientStrategies.length}`);

        let downloadSuccess = false;
        let lastDownloadError = null;

        for (let attempt = 1; attempt <= clientStrategies.length; attempt++) {
            const strat = clientStrategies[attempt - 1];
            try {
                console.log(`[YouTube Convert] Intento ${attempt}/${clientStrategies.length}: ${strat.label}`);

                const ytdlArgs = buildBaseYtDlpArgs(strat.client, [
                    '--retries', '2',
                    '--fragment-retries', '2',
                    '--ffmpeg-location', FFMPEG_BIN,
                    '-x',
                    '--audio-format', 'mp3',
                    '--audio-quality', '0',
                    '-o', tempFileTemplate,
                    '--no-playlist',
                    url.trim()
                ], strat.useProxy, strat.useCookies);

                await runProcess(YTDLP_BIN, ytdlArgs);

                if (fs.existsSync(expectedMp3Path)) {
                    downloadSuccess = true;
                    console.log(`[YouTube Convert] Descarga y transcodificación completadas con éxito en el intento ${attempt} (${strat.label}).`);
                    break;
                }
            } catch (dlErr) {
                lastDownloadError = dlErr;
                const errSnippet = (dlErr.message || '').split('\n')[0];
                console.warn(`[YouTube Convert] Intento ${attempt} falló: ${errSnippet}. Saltando al siguiente intento...`);
                if (fs.existsSync(expectedMp3Path)) {
                    try { fs.unlinkSync(expectedMp3Path); } catch (e) {}
                }
                if (attempt < clientStrategies.length) {
                    await sleep(600);
                }
            }
        }

        if (!downloadSuccess || !fs.existsSync(expectedMp3Path)) {
            const friendlyErr = formatYtDlpError(lastDownloadError ? lastDownloadError.message : 'Error desconocido');
            throw new Error(`No se pudo descargar el audio tras ${clientStrategies.length} intentos: ${friendlyErr}`);
        }

        const mp3Buffer = fs.readFileSync(expectedMp3Path);

        // 2. Calcular SHA-256 del archivo de audio para deduplicación
        const fileHash = crypto.createHash('sha256').update(mp3Buffer).digest('hex');
        console.log(`[YouTube Convert] Hash SHA-256 calculado: ${fileHash}`);

        // 3. Determinar el nombre final de la pista
        let displayName = sanitizeFileName(customTitle);
        if (!displayName) {
            displayName = `YouTube_${Date.now()}`;
        }

        // 4. Deduplicación por hash: llamar RPC find_active_track_by_hash en Supabase
        let fileName = null;
        try {
            const rpcRes = await fetchInsecure(`${SUPABASE_URL}/rest/v1/rpc/find_active_track_by_hash`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${accessToken}`
                },
                body: JSON.stringify({ p_hash: fileHash })
            });

            if (rpcRes.ok) {
                const sharedKey = await rpcRes.json();
                if (sharedKey && typeof sharedKey === 'string' && sharedKey.startsWith('music/')) {
                    fileName = sharedKey;
                    console.log(`[YouTube Convert] Archivo deduplicado encontrado en Storage R2: ${fileName}`);
                }
            }
        } catch (rpcErr) {
            console.warn('[YouTube Convert] Aviso en verificación de RPC de hash:', rpcErr);
        }

        // 5. Si no existe previamente en R2, subir el MP3 a Cloudflare R2 Worker con reintentos
        if (!fileName) {
            console.log(`[YouTube Convert] Subiendo nuevo archivo a Cloudflare R2 Worker (${mp3Buffer.length} bytes)...`);
            let uploadRes = null;
            let uploadPayload = null;

            for (let upAttempt = 1; upAttempt <= 3; upAttempt++) {
                try {
                    uploadRes = await fetchInsecure(`${MEDIA_API_URL}/upload/music`, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'audio/mpeg',
                            'X-File-Name': encodeURIComponent(`${displayName}.mp3`)
                        },
                        body: mp3Buffer
                    });

                    try { uploadPayload = await uploadRes.json(); } catch (jsonErr) {}

                    if (uploadRes.ok && uploadPayload && uploadPayload.key) {
                        fileName = uploadPayload.key;
                        break;
                    }
                } catch (upErr) {
                    console.warn(`[YouTube Convert] Intento de subida a R2 ${upAttempt} falló:`, upErr);
                    if (upAttempt < 3) await sleep(1000 * upAttempt);
                }
            }

            if (!fileName) {
                throw new Error((uploadPayload && uploadPayload.error) || `Error al subir audio a R2 tras varios intentos.`);
            }

            console.log(`[YouTube Convert] Subida a R2 exitosa. Clave asignada: ${fileName}`);
        }

        // 6. Guardar fila en tabla music_tracks de Supabase vinculada al perfil del usuario
        const finalAlbum = album && album.trim() ? album.trim() : null;
        const insertRes = await fetchInsecure(`${SUPABASE_URL}/rest/v1/music_tracks`, {
            method: 'POST',
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                Prefer: 'return=representation'
            },
            body: JSON.stringify([{
                user_id: userId,
                file_name: fileName,
                file_hash: fileHash,
                display_name: displayName,
                is_public: false,
                album: finalAlbum
            }])
        });

        if (!insertRes.ok) {
            const errData = await insertRes.json().catch(() => ({}));
            throw new Error(errData.message || `Error ${insertRes.status} al registrar pista en Supabase.`);
        }

        const insertedRecords = await insertRes.json();
        const createdTrack = Array.isArray(insertedRecords) ? insertedRecords[0] : insertedRecords;

        console.log(`[YouTube Convert] Pista registrada exitosamente en Supabase: "${displayName}"`);

        return res.json({
            success: true,
            track: createdTrack,
            message: `Canción "${displayName}" convertida y agregada a tu perfil exitosamente.`
        });

    } catch (err) {
        console.error('[YouTube Convert] Error en proceso:', err);
        return res.status(500).json({
            error: err.message || 'Error interno al procesar el video de YouTube.'
        });
    } finally {
        try {
            if (fs.existsSync(expectedMp3Path)) {
                fs.unlinkSync(expectedMp3Path);
            }
        } catch (cleanErr) {
            console.error('Error al eliminar archivo temporal:', cleanErr);
        }
    }
});

// ─── Endpoints del probador de cookies [v1.9.13] ───
function publicCookieState() {
    const s = cookieTestState;
    return {
        running: s.running,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        proxyConfigured: s.proxyConfigured,
        winner: s.winner,
        summary: s.summary,
        baseline: s.baseline,
        cookies: s.cookies.map(c => ({
            name: c.name,
            ok: c.ok,
            converted: c.converted,
            attempts: c.attempts
        }))
    };
}

app.get('/api/cookies/status', (req, res) => {
    res.json(publicCookieState());
});

app.post('/api/cookies/test', (req, res) => {
    if (cookieTestState.running) {
        return res.status(202).json(publicCookieState());
    }
    // Anti-abuso: no relanzar si la última prueba terminó hace menos de 60 s
    if (cookieTestState.finishedAt && Date.now() - cookieTestState.finishedAt < 60000) {
        return res.status(429).json({ ...publicCookieState(), error: 'Espera un minuto antes de volver a probar las cookies.' });
    }
    runCookieTests().catch(e => console.error('[CookieTest]', e.message));
    res.status(202).json(publicCookieState());
});

// Manejador global de 404 para responder siempre en JSON
app.use((req, res) => {
    res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.url}` });
});

// Inicializar el servidor en 0.0.0.0 con captura de error EADDRINUSE amigable
const server = app.listen(PORT, '0.0.0.0', () => {
    const cookiesResolved = resolveCookiesPath();
    console.log(`=======================================================`);
    console.log(` Servidor Conversor de YouTube a MP3 v1.9.12 activo:`);
    console.log(` Local:      http://localhost:${PORT}`);
    console.log(` Plataforma activa: ${process.platform} (${process.arch})`);
    console.log(` yt-dlp:     ${YTDLP_BIN}`);
    console.log(` ffmpeg:     ${FFMPEG_BIN}`);
    console.log(` Supabase:   ${SUPABASE_URL}`);
    console.log(` Media API:  ${MEDIA_API_URL}`);
    console.log(` Cookies YT: ${cookiesResolved ? 'Detectadas y activas' : 'No configuradas (Modo visión bypass)'}`);
    console.log(`=======================================================`);
    // Probar cookies automáticamente al arrancar [v1.9.13]
    setTimeout(() => runCookieTests().catch(e => console.error('[CookieTest]', e.message)), 3000);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n[ERROR CRÍTICO] El puerto ${PORT} ya está en uso.`);
        console.error(`Si tienes otra terminal abierta corriendo el servidor, ciérrala.`);
        console.error(`O para liberar el puerto en PowerShell, ejecuta:`);
        console.error(`Stop-Process -Name node -Force\n`);
        process.exit(1);
    } else {
        console.error('[ERROR]', err);
    }
});
