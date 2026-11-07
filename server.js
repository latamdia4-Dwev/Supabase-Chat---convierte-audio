/**
 * ============================================================================
 * Proyecto: Conversor de YouTube a MP3 y Uploader para Supabase Chat
 * Archivo: server.js
 * Versión: 1.9.0
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
 *              - [v1.9.0] Timeout por proceso con señal SIGTERM para evitar cuelgues en 504
 *              - [v1.9.0] Endpoint proxy /api/yt-proxy para previsualización en redes restringidas
 *              - [v1.9.0] Propagación automática de YOUTUBE_PROXY a yt-dlp con --socket-timeout
 *              - [v1.9.0] Mensajes de error descriptivos para timeouts y red bloqueada
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
const http = require('http');

// --- Fix SSL para fetch nativo en Node 24 con certificados intermedios en Windows ---
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
 * Ejecutar procesos de forma asíncrona mediante promesas con timeout configurable.
 * @param {string} cmdPath   - Ruta al ejecutable
 * @param {string[]} args    - Argumentos del proceso
 * @param {number} timeoutMs - Tiempo máximo en ms (default: 5 minutos).
 *                             Si se supera, el proceso se mata con SIGTERM y se rechaza.
 *                             Evita que el proxy upstream devuelva 504 silenciosamente.
 * [v1.9.0] Timeout añadido para cortar yt-dlp si la red bloquea la conexión.
 */
function runProcess(cmdPath, args, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmdPath, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        let killed = false;

        // Matar el proceso si excede el tiempo límite
        const timer = setTimeout(() => {
            if (!killed) {
                killed = true;
                try { proc.kill('SIGTERM'); } catch (e) {}
                reject(new Error(
                    `El proceso yt-dlp excedio el tiempo limite de ${Math.round(timeoutMs / 1000)}s. ` +
                    `La red puede estar bloqueando YouTube. Configura YOUTUBE_PROXY en el .env y reinicia.`
                ));
            }
        }, timeoutMs);

        proc.stdout.on('data', data => { stdout += data.toString(); });
        proc.stderr.on('data', data => { stderr += data.toString(); });

        proc.on('close', code => {
            clearTimeout(timer);
            if (killed) return;
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`El proceso fallo con codigo ${code}: ${stderr || stdout}`));
            }
        });

        proc.on('error', err => {
            clearTimeout(timer);
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

/**
 * Resuelve la ruta al archivo de cookies de YouTube si existe:
 * 1. Archivo físico cookies.txt en la raíz del proyecto
 * 2. Variable de entorno YOUTUBE_COOKIES (o COOKIES_CONTENT / YT_COOKIES)
 * 3. Variable de entorno YOUTUBE_COOKIES_BASE64 (base64 sin saltos de línea rotos)
 */
function resolveCookiesPath() {
    if (fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 10) {
        return COOKIES_FILE;
    }
    const rawCookies = process.env.YOUTUBE_COOKIES || process.env.COOKIES_CONTENT || process.env.YT_COOKIES;
    if (rawCookies && rawCookies.trim().length > 10) {
        try {
            fs.writeFileSync(TEMP_COOKIES_FILE, rawCookies.trim(), 'utf8');
            return TEMP_COOKIES_FILE;
        } catch (e) {
            console.warn('[Cookies] Error escribiendo TEMP_COOKIES_FILE:', e.message);
        }
    }
    if (process.env.YOUTUBE_COOKIES_BASE64 && process.env.YOUTUBE_COOKIES_BASE64.trim().length > 10) {
        try {
            const decoded = Buffer.from(process.env.YOUTUBE_COOKIES_BASE64.trim(), 'base64').toString('utf8');
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
function buildBaseYtDlpArgs(clientStrategy, extraArgs = []) {
    const args = [
        '--no-check-certificates',
        '--socket-timeout', '15',
        '--js-runtimes', 'node'
    ];

    if (clientStrategy) {
        args.push('--extractor-args', clientStrategy);
    }

    const cookiesPath = resolveCookiesPath();
    if (cookiesPath) {
        args.push('--cookies', cookiesPath);
    }

    // Proxy: usar getConfiguredProxy() centralizado para yt-dlp
    // [v1.9.0] Soporta YOUTUBE_PROXY, HTTP_PROXY y HTTPS_PROXY con log de diagnóstico
    const proxy = getConfiguredProxy();
    if (proxy) {
        args.push('--proxy', proxy);
        console.log('[yt-dlp] Usando proxy configurado:', proxy.replace(/:[^:@]*@/, ':***@'));
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
// ══════════════════════════════════════════════════════════════════════
// ENDPOINTS DE STREAMING Y PROXY DE YOUTUBE [v1.9.0]
// Permite reproducir audio y previsualizar YouTube a través del servidor
// utilizando las MISMAS cookies y proxy que se usan para descargar.
// Resuelve bloqueos en redes restringidas corporativas donde youtube.com está bloqueado.
// ══════════════════════════════════════════════════════════════════════

/**
 * Endpoint: GET /api/yt-stream?videoId=XXXX
 * Hace streaming directo de audio en tiempo real a través del servidor Node.js
 * utilizando yt-dlp con las cookies y proxy configurados.
 * El navegador del cliente solo se conecta a localhost:3000, evitando los bloqueos de red.
 */
app.get('/api/yt-stream', (req, res) => {
    const { videoId } = req.query;
    if (!videoId || !/^[a-zA-Z0-9_-]{5,20}$/.test(videoId)) {
        return res.status(400).send('Video ID inválido.');
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[yt-stream] Iniciando streaming proxy para video: ${videoId}`);

    // Argumentos de yt-dlp para extraer audio y enviarlo a stdout (-o -)
    const ytdlArgs = buildBaseYtDlpArgs('youtube:player_client=android_vr,visionos', [
        '-f', 'ba/b',
        '-o', '-',
        '--no-playlist',
        '--quiet',
        '--no-warnings',
        videoUrl
    ]);

    // Cabeceras HTTP para streaming de audio sin buffer
    res.setHeader('Content-Type', 'audio/webm');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Accel-Buffering', 'no'); // Anti-buffering en proxies Nginx/Render

    const ytdlProcess = spawn(YTDLP_BIN, ytdlArgs, { windowsHide: true });

    // Pipe de datos directo de yt-dlp al cliente HTTP
    ytdlProcess.stdout.pipe(res);

    ytdlProcess.stderr.on('data', (errData) => {
        const msg = errData.toString();
        // Solo loguear errores reales, no avisos informativos
        if (msg.includes('ERROR:')) {
            console.warn(`[yt-stream] Aviso de proceso: ${msg.trim()}`);
        }
    });

    // Si el usuario cierra el reproductor o desconecta la pestaña, matar el proceso de inmediato
    req.on('close', () => {
        try {
            ytdlProcess.kill('SIGTERM');
        } catch (e) {}
    });

    ytdlProcess.on('error', (err) => {
        console.error('[yt-stream] Error en proceso de streaming:', err.message);
        if (!res.headersSent) {
            res.status(500).send('Error iniciando stream de audio.');
        }
    });
});

/**
 * Endpoint: GET /api/yt-proxy?videoId=XXXX
 * Página de previsualización con reproductor dual:
 * 1) Stream nativo por servidor local (utilizando proxy y cookies de YouTube)
 * 2) Embed oficial de YouTube (si el cliente tiene acceso o prefiere ver el video)
 */
app.get('/api/yt-proxy', (req, res) => {
    const { videoId } = req.query;
    if (!videoId || !/^[a-zA-Z0-9_-]{5,20}$/.test(videoId)) {
        return res.status(400).send('Video ID inválido.');
    }

    const streamUrl = `/api/yt-stream?videoId=${videoId}`;
    const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&enablejsapi=1&rel=0`;

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Previsualización de YouTube (Proxy)</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%; height: 100%;
      background: #0f172a;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      overflow: hidden;
    }
    .player-card {
      width: 100%; height: 100%;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      position: relative;
    }
    .stream-player {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 12px; width: 90%; max-width: 480px;
      padding: 16px; background: rgba(30, 41, 59, 0.8);
      border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }
    .stream-title {
      font-size: 13px; font-weight: 600; color: #38bdf8;
      display: flex; align-items: center; gap: 6px;
    }
    audio { width: 100%; height: 40px; outline: none; }
    .toggle-bar {
      margin-top: 6px; display: flex; gap: 8px; font-size: 11px;
    }
    .btn-toggle {
      background: #334155; color: #cbd5e1; border: 1px solid rgba(255, 255, 255, 0.15);
      padding: 4px 10px; border-radius: 6px; cursor: pointer; transition: all 0.2s;
    }
    .btn-toggle:hover { background: #475569; color: #fff; }
    .btn-toggle.active { background: #0284c7; color: #fff; }
    iframe {
      width: 100%; height: 100%; border: none; display: none;
    }
    .active-frame { display: block !important; }
  </style>
</head>
<body>
  <div class="player-card">
    <!-- Reproductor nativo por proxy (funciona en redes restringidas) -->
    <div class="stream-player" id="streamPlayerBox">
      <div class="stream-title">
        <span>🔒 Audio por Proxy Seguro (Red Restringida)</span>
      </div>
      <audio id="audioStreamEl" controls autoplay preload="auto" src="${streamUrl}"></audio>
      <div class="toggle-bar">
        <button type="button" class="btn-toggle active" id="btnModeProxy">🎧 Audio Proxy</button>
        <button type="button" class="btn-toggle" id="btnModeEmbed">📺 Video Original</button>
      </div>
    </div>

    <!-- Iframe oficial de YouTube -->
    <iframe
      id="ytIframeEl"
      src=""
      data-src="${embedUrl}"
      allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
      allowfullscreen
      title="YouTube Video">
    </iframe>
  </div>

  <script>
    const streamBox = document.getElementById('streamPlayerBox');
    const audioEl = document.getElementById('audioStreamEl');
    const iframeEl = document.getElementById('ytIframeEl');
    const btnProxy = document.getElementById('btnModeProxy');
    const btnEmbed = document.getElementById('btnModeEmbed');

    btnProxy.onclick = () => {
      btnProxy.classList.add('active');
      btnEmbed.classList.remove('active');
      iframeEl.classList.remove('active-frame');
      iframeEl.src = '';
      streamBox.style.display = 'flex';
      audioEl.play().catch(() => {});
    };

    btnEmbed.onclick = () => {
      btnEmbed.classList.add('active');
      btnProxy.classList.remove('active');
      audioEl.pause();
      streamBox.style.display = 'none';
      iframeEl.src = iframeEl.dataset.src;
      iframeEl.classList.add('active-frame');
    };
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.send(html);
});

app.post('/api/youtube-search', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { query, limit = 20 } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'Debes ingresar un término de búsqueda.' });
    }

    const count = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
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
                `ytsearch${count}:${query.trim()}`,
                '--dump-single-json',
                '--no-warnings',
                '--skip-download',
                '--flat-playlist'
            ]);

            const { stdout } = await runProcess(YTDLP_BIN, args, 25000); // [v1.9.0] Timeout 25s anti-504
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
            console.warn(`[YouTube Search] Intento ${attempt} falló para "${query}": ${err.message}. Reintentando...`);
            if (attempt < clientOptions.length) await sleep(1000 * attempt);
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
        // [v1.9.0] buildBaseYtDlpArgs asegura soporte de cookies y proxy en playlists
        const args = buildBaseYtDlpArgs('youtube:player_client=android,web', [
            '--dump-single-json',
            '--no-warnings',
            '--flat-playlist',
            '--skip-download',
            url.trim()
        ]);

        const { stdout } = await runProcess(YTDLP_BIN, args, 35000); // [v1.9.0] Timeout 35s anti-504
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

            const { stdout } = await runProcess(YTDLP_BIN, args, 20000); // [v1.9.0] Timeout 20s anti-504
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

    const clientStrategies = [
        'youtube:player_client=visionos,android_vr',
        'youtube:player_client=android_vr,visionos',
        'youtube:player_client=ios,android',
        'youtube:player_client=android,web',
        'youtube:player_client=mweb,web'
    ];

    try {
        console.log(`[YouTube Convert] Iniciando pipeline de conversión para: ${url}`);

        let downloadSuccess = false;
        let lastDownloadError = null;

        for (let attempt = 1; attempt <= clientStrategies.length; attempt++) {
            try {
                const clientArg = clientStrategies[attempt - 1];
                console.log(`[YouTube Convert] Intento ${attempt}/${clientStrategies.length} usando estrategia: ${clientArg}`);

                const ytdlArgs = buildBaseYtDlpArgs(clientArg, [
                    '--retries', '3',
                    '--fragment-retries', '3',
                    '--ffmpeg-location', FFMPEG_BIN,
                    '-x',
                    '--audio-format', 'mp3',
                    '--audio-quality', '0',
                    '-o', tempFileTemplate,
                    '--no-playlist',
                    url.trim()
                ]);

                await runProcess(YTDLP_BIN, ytdlArgs, 120000); // [v1.9.0] Timeout 120s para conversión completa

                if (fs.existsSync(expectedMp3Path)) {
                    downloadSuccess = true;
                    console.log(`[YouTube Convert] Descarga y transcodificación completadas en el intento ${attempt}.`);
                    break;
                }
            } catch (dlErr) {
                lastDownloadError = dlErr;
                console.warn(`[YouTube Convert] Intento ${attempt} no exitoso: ${dlErr.message}`);
                if (fs.existsSync(expectedMp3Path)) {
                    try { fs.unlinkSync(expectedMp3Path); } catch (e) {}
                }
                if (attempt < clientStrategies.length) {
                    await sleep(1200 * attempt);
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
            console.log(`[YouTube Convert] Subiendo nuevo archivo a Cloudflare R2 Worker...`);
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

// Manejador global de 404 para responder siempre en JSON
app.use((req, res) => {
    res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.url}` });
});

// Inicializar el servidor en 0.0.0.0 con captura de error EADDRINUSE amigable
const server = app.listen(PORT, '0.0.0.0', () => {
    const cookiesResolved = resolveCookiesPath();
    console.log(`=======================================================`);
    console.log(` Servidor Conversor de YouTube a MP3 v1.9.0 activo:`);
    console.log(` Local:      http://localhost:${PORT}`);
    console.log(` Plataforma activa: ${process.platform} (${process.arch})`);
    console.log(` yt-dlp:     ${YTDLP_BIN}`);
    console.log(` ffmpeg:     ${FFMPEG_BIN}`);
    console.log(` Supabase:   ${SUPABASE_URL}`);
    console.log(` Media API:  ${MEDIA_API_URL}`);
    console.log(` Cookies YT: ${cookiesResolved ? 'Detectadas y activas' : 'No configuradas (Modo visión bypass)'}`);
    console.log(`=======================================================`);
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
