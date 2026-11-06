/**
 * ============================================================================
 * Proyecto: Conversor de YouTube a MP3 y Uploader para Supabase Chat
 * Archivo: server.js
 * VersiÃ³n: 1.8.5
 * DescripciÃ³n: Servidor Express optimizado y enfocado en YouTube:
 *              - Soporte de certificados SSL universales (--no-check-certificates)
 *              - PrevenciÃ³n de bloqueos por validaciÃ³n de certificado en Windows/Linux
 *              - Descarga y transcodificaciÃ³n acelerada con Node runtime y rotaciÃ³n de clientes
 *              - BÃºsqueda extendida en YouTube (hasta 50 resultados por consulta)
 *              - Barra interactiva de previsualizaciÃ³n y pre-escucha antes de descargar
 *              - Pipeline de conversiÃ³n YouTube a MP3 de alta fidelidad (yt-dlp + FFmpeg)
 *              - Soporte nativo de JS runtime (--js-runtimes node) para n-tokens
 *              - Reintentos automÃ¡ticos con rotaciÃ³n de clientes contra HTTP 403 Forbidden
 *              - DeduplicaciÃ³n por hash SHA-256 en Cloudflare R2 y gestiÃ³n de Ã¡lbumes
 *              - Soporte multiplataforma nativo (Windows y Linux para Render.com)
 *              - PrevenciÃ³n y manejo amigable de errores de puerto ocupado (EADDRINUSE)
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

// â”€â”€â”€ Fix SSL para fetch nativo en Node 24 con certificados intermedios en Windows â”€â”€â”€
// Permite que fetch() y https.request() acepten certificados autofirmados/intermedios
// sin exponer NODE_TLS_REJECT_UNAUTHORIZED=0 de forma global (sÃ³lo agente https)
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * fetchInsecure â€” igual que fetch() pero con rejectUnauthorized:false
 * Usar sÃ³lo para llamadas internas a Cloudflare Workers / Supabase en entorno local Windows.
 */
function fetchInsecure(url, options = {}) {
    return fetch(url, { ...options, agent: insecureAgent });
}

const app = express();
const PORT = process.env.PORT || 3000;

// ConfiguraciÃ³n de Supabase y Media API (Cloudflare Worker R2)
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

// Servir frontend y recursos estÃ¡ticos
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use('/js', express.static(path.join(ROOT_DIR, 'js')));

/**
 * FunciÃ³n auxiliar para limpiar nombres de archivo de caracteres no permitidos
 */
function sanitizeFileName(name) {
    if (!name) return 'cancion';
    return name
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * FunciÃ³n de pausa asÃ­ncrona para retroceso exponencial en reintentos
 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Ejecutar procesos de forma asÃ­ncrona mediante promesas
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
                reject(new Error(`El proceso fallÃ³ con cÃ³digo ${code}: ${stderr || stdout}`));
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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ENDPOINTS DE YOUTUBE (BÃšSQUEDA EXTENDIDA, ANÃLISIS, CONVERSIÃ“N)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * Endpoint: POST /api/youtube-search
 * Busca canciones en YouTube devolviendo una lista amplia (hasta 50 resultados)
 */
app.post('/api/youtube-search', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { query, limit = 20 } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'Debes ingresar un tÃ©rmino de bÃºsqueda.' });
    }

    const count = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
    const clientOptions = [
        'youtube:player_client=android,web',
        'youtube:player_client=web,android',
        'youtube:player_client=mweb'
    ];

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const clientArg = clientOptions[attempt - 1] || clientOptions[0];
            const args = [
                '--no-check-certificates',
                '--js-runtimes', 'node',
                '--extractor-args', clientArg,
                `ytsearch${count}:${query.trim()}`,
                '--dump-single-json',
                '--no-warnings',
                '--skip-download',
                '--flat-playlist'
            ];

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
            console.warn(`[YouTube Search] Intento ${attempt} fallÃ³ para "${query}": ${err.message}. Reintentando...`);
            if (attempt < 3) await sleep(1200 * attempt);
        }
    }

    return res.status(500).json({
        error: `Error al buscar en YouTube tras 3 intentos: ${lastError ? lastError.message : 'Error desconocido'}`
    });
});

/**
 * Endpoint: POST /api/playlist-info
 * Detecta y extrae todas las canciones de una lista de reproducciÃ³n (Playlist) de YouTube
 */
app.post('/api/playlist-info', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'Debes proporcionar una URL vÃ¡lida de playlist.' });
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
        return res.status(500).json({ error: 'No se pudo leer la lista de reproducciÃ³n. Verifica que sea pÃºblica.' });
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
        return res.status(400).json({ error: 'Debes proporcionar una URL vÃ¡lida de YouTube.' });
    }

    const clientOptions = [
        'youtube:player_client=android,web',
        'youtube:player_client=web,android',
        'youtube:player_client=mweb'
    ];

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const clientArg = clientOptions[attempt - 1] || clientOptions[0];
            const args = [
                '--no-check-certificates',
                '--js-runtimes', 'node',
                '--extractor-args', clientArg,
                '--dump-single-json',
                '--no-warnings',
                '--no-playlist',
                '--skip-download',
                url.trim()
            ];

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
            console.warn(`[Video Info] Intento ${attempt} fallÃ³ para "${url}": ${err.message}`);
            if (attempt < 3) await sleep(1200 * attempt);
        }
    }

    return res.status(500).json({
        error: `No se pudo obtener la informaciÃ³n del video tras 3 intentos: ${lastError ? lastError.message : 'Error desconocido'}`
    });
});

/**
 * Endpoint: POST /api/convert-and-upload
 * Orquesta la descarga de audio de YouTube con REINTENTOS AUTOMÃTICOS ante errores 403 Forbidden,
 * transcodificaciÃ³n a MP3, hash SHA-256, subida a R2 y registro en Supabase.
 */
app.post('/api/convert-and-upload', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { url, album, customTitle, accessToken, userId } = req.body;

    if (!url || !accessToken || !userId) {
        return res.status(400).json({ error: 'Faltan parÃ¡metros requeridos (url, accessToken, userId).' });
    }

    const tempId = crypto.randomUUID();
    const tempFileTemplate = path.join(TEMP_DIR, `${tempId}.%(ext)s`);
    const expectedMp3Path = path.join(TEMP_DIR, `${tempId}.mp3`);

    const clientStrategies = [
        'youtube:player_client=android,web',
        'youtube:player_client=web,android',
        'youtube:player_client=mweb'
    ];

    try {
        console.log(`[YouTube Convert] Iniciando pipeline de conversiÃ³n para: ${url}`);

        let downloadSuccess = false;
        let lastDownloadError = null;

        // BUCLE DE REINTENTOS AUTOMÃTICOS
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const clientArg = clientStrategies[attempt - 1] || clientStrategies[0];
                console.log(`[YouTube Convert] Intento ${attempt}/3 usando estrategia: ${clientArg}`);

                const ytdlArgs = [
                    '--no-check-certificates',
                    '--js-runtimes', 'node',
                    '--extractor-args', clientArg,
                    '--retries', '3',
                    '--fragment-retries', '3',
                    '--ffmpeg-location', FFMPEG_BIN,
                    '-x',
                    '--audio-format', 'mp3',
                    '--audio-quality', '0',
                    '-o', tempFileTemplate,
                    '--no-playlist',
                    url.trim()
                ];

                await runProcess(YTDLP_BIN, ytdlArgs);

                if (fs.existsSync(expectedMp3Path)) {
                    downloadSuccess = true;
                    console.log(`[YouTube Convert] Descarga y transcodificaciÃ³n completadas en el intento ${attempt}.`);
                    break;
                }
            } catch (dlErr) {
                lastDownloadError = dlErr;
                console.warn(`[YouTube Convert] Intento ${attempt} no exitoso: ${dlErr.message}`);
                if (fs.existsSync(expectedMp3Path)) {
                    try { fs.unlinkSync(expectedMp3Path); } catch (e) {}
                }
                if (attempt < 3) {
                    await sleep(1500 * attempt);
                }
            }
        }

        if (!downloadSuccess || !fs.existsSync(expectedMp3Path)) {
            throw new Error(`No se pudo descargar el audio tras 3 intentos automÃ¡ticos: ${lastDownloadError ? lastDownloadError.message : 'Error 403 Forbidden o restricciÃ³n'}`);
        }

        const mp3Buffer = fs.readFileSync(expectedMp3Path);

        // 2. Calcular SHA-256 del archivo de audio para deduplicaciÃ³n
        const fileHash = crypto.createHash('sha256').update(mp3Buffer).digest('hex');
        console.log(`[YouTube Convert] Hash SHA-256 calculado: ${fileHash}`);

        // 3. Determinar el nombre final de la pista
        let displayName = sanitizeFileName(customTitle);
        if (!displayName) {
            displayName = `YouTube_${Date.now()}`;
        }

        // 4. DeduplicaciÃ³n por hash: llamar RPC find_active_track_by_hash en Supabase
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
            console.warn('[YouTube Convert] Aviso en verificaciÃ³n de RPC de hash:', rpcErr);
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
                    console.warn(`[YouTube Convert] Intento de subida a R2 ${upAttempt} fallÃ³:`, upErr);
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
            message: `CanciÃ³n "${displayName}" convertida y agregada a tu perfil exitosamente.`
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
    console.log(`=======================================================`);
    console.log(` Servidor Conversor de YouTube a MP3 v1.8.0 activo:`);
    console.log(` Local:      http://localhost:${PORT}`);
    console.log(` Plataforma activa: ${process.platform} (${process.arch})`);
    console.log(` yt-dlp:     ${YTDLP_BIN}`);
    console.log(` ffmpeg:     ${FFMPEG_BIN}`);
    console.log(` Supabase:   ${SUPABASE_URL}`);
    console.log(` Media API:  ${MEDIA_API_URL}`);
    console.log(`=======================================================`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n[ERROR CRÃTICO] El puerto ${PORT} ya estÃ¡ en uso.`);
        console.error(`Si tienes otra terminal abierta corriendo el servidor, ciÃ©rrala.`);
        console.error(`O para liberar el puerto en PowerShell, ejecuta:`);
        console.error(`Stop-Process -Name node -Force\n`);
        process.exit(1);
    } else {
        console.error('[ERROR]', err);
    }
});

