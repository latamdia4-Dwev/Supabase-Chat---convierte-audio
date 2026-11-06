/**
 * ============================================================================
 * Proyecto: Conversor de YouTube a MP3 y Uploader para Supabase Chat
 * Archivo: server.js
 * Versión: 1.5.0
 * Descripción: Servidor Express optimizado con:
 *              - Integración completa con Spotify API (OAuth 2.0, biblioteca y playlists)
 *              - Soporte multiplataforma (Windows y Linux para Render.com)
 *              - Búsqueda extendida en YouTube (hasta 40 resultados por consulta)
 *              - Soporte para previsualización y pre-escucha antes de descargar
 *              - Pipeline de reintentos con rotación de clientes y soporte JS runtime
 *              - Deduplicación por hash SHA-256 en Cloudflare R2 y gestión de álbumes
 * ============================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

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

// Configuración de Spotify en memoria y variables de entorno
let spotifyCreds = {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    redirectUri: process.env.SPOTIFY_REDIRECT_URI || ''
};

// Almacén de sesión de Spotify
let spotifySession = {
    accessToken: null,
    refreshToken: null,
    expiresAt: 0,
    user: null
};

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

/**
 * Obtener la URL de redirección efectiva de Spotify
 */
function getEffectiveRedirectUri(req) {
    if (spotifyCreds.redirectUri && spotifyCreds.redirectUri.trim()) {
        return spotifyCreds.redirectUri.trim();
    }
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.get('host');
    return `${proto}://${host}/api/spotify/callback`;
}

/**
 * Refrescar token de Spotify si está próximo a expirar
 */
async function ensureValidSpotifyToken() {
    if (!spotifySession.accessToken) {
        throw new Error('No hay sesión activa con Spotify. Conecta tu cuenta primero.');
    }

    // Si aún tiene más de 60 segundos de validez, usar el actual
    if (Date.now() < (spotifySession.expiresAt - 60000)) {
        return spotifySession.accessToken;
    }

    if (!spotifySession.refreshToken) {
        throw new Error('La sesión de Spotify expiró. Vuelve a iniciar sesión.');
    }

    console.log('[Spotify] Renovando token de acceso...');
    const basicAuth = Buffer.from(`${spotifyCreds.clientId}:${spotifyCreds.clientSecret}`).toString('base64');
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: spotifySession.refreshToken
    });

    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
    });

    if (!res.ok) {
        spotifySession.accessToken = null;
        throw new Error('No se pudo renovar la sesión de Spotify. Inicia sesión de nuevo.');
    }

    const data = await res.json();
    spotifySession.accessToken = data.access_token;
    spotifySession.expiresAt = Date.now() + (data.expires_in * 1000);
    if (data.refresh_token) {
        spotifySession.refreshToken = data.refresh_token;
    }

    return spotifySession.accessToken;
}

// ══════════════════════════════════════════════════════════════════════
// ENDPOINTS DE SPOTIFY (OAUTH 2.0, BIBLIOTECA, PLAYLISTS)
// ══════════════════════════════════════════════════════════════════════

/**
 * Endpoint: GET /api/spotify/status
 * Estado de configuración y autenticación de Spotify
 */
app.get('/api/spotify/status', (req, res) => {
    const isConfigured = Boolean(spotifyCreds.clientId && spotifyCreds.clientSecret);
    const isAuthenticated = Boolean(spotifySession.accessToken && Date.now() < spotifySession.expiresAt);

    res.json({
        configured: isConfigured,
        clientIdMasked: spotifyCreds.clientId ? (spotifyCreds.clientId.slice(0, 6) + '...' + spotifyCreds.clientId.slice(-4)) : null,
        authenticated: isAuthenticated,
        user: isAuthenticated ? spotifySession.user : null,
        redirectUri: getEffectiveRedirectUri(req)
    });
});

/**
 * Endpoint: POST /api/spotify/save-credentials
 * Guarda las credenciales de Spotify en caliente y en el archivo .env
 */
app.post('/api/spotify/save-credentials', (req, res) => {
    const { clientId, clientSecret, redirectUri } = req.body;
    if (!clientId || !clientSecret) {
        return res.status(400).json({ error: 'Debes proporcionar Client ID y Client Secret.' });
    }

    spotifyCreds.clientId = clientId.trim();
    spotifyCreds.clientSecret = clientSecret.trim();
    if (redirectUri) spotifyCreds.redirectUri = redirectUri.trim();

    // Actualizar o crear archivo .env de forma segura
    try {
        const envPath = path.join(ROOT_DIR, '.env');
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }

        const updateEnvVar = (content, key, val) => {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(content)) {
                return content.replace(regex, `${key}=${val}`);
            } else {
                return content ? `${content}\n${key}=${val}` : `${key}=${val}`;
            }
        };

        envContent = updateEnvVar(envContent, 'SPOTIFY_CLIENT_ID', spotifyCreds.clientId);
        envContent = updateEnvVar(envContent, 'SPOTIFY_CLIENT_SECRET', spotifyCreds.clientSecret);
        if (spotifyCreds.redirectUri) {
            envContent = updateEnvVar(envContent, 'SPOTIFY_REDIRECT_URI', spotifyCreds.redirectUri);
        }

        fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
        console.log('[Spotify] Credenciales guardadas exitosamente en .env');
    } catch (fsErr) {
        console.warn('[Spotify] Aviso al escribir archivo .env:', fsErr.message);
    }

    return res.json({ success: true, message: 'Credenciales de Spotify guardadas correctamente.' });
});

/**
 * Endpoint: GET /api/spotify/login
 * Inicia el flujo OAuth 2.0 de Spotify redirigiendo a su página de autorización
 */
app.get('/api/spotify/login', (req, res) => {
    if (!spotifyCreds.clientId || !spotifyCreds.clientSecret) {
        return res.status(400).send('Debes configurar primero SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET.');
    }

    const redirectUri = getEffectiveRedirectUri(req);
    const scopes = [
        'user-library-read',
        'playlist-read-private',
        'playlist-read-collaborative',
        'user-read-private',
        'user-read-email'
    ].join(' ');

    const state = crypto.randomBytes(16).toString('hex');
    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', spotifyCreds.clientId);
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);

    res.redirect(authUrl.toString());
});

/**
 * Endpoint: GET /api/spotify/callback
 * Callback de Spotify que recibe el código y lo canjea por tokens
 */
app.get('/api/spotify/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        console.error('[Spotify Callback] Error de autorización:', error);
        return res.redirect('/#spotify_error=' + encodeURIComponent(error));
    }

    if (!code) {
        return res.redirect('/#spotify_error=no_code');
    }

    try {
        const redirectUri = getEffectiveRedirectUri(req);
        const basicAuth = Buffer.from(`${spotifyCreds.clientId}:${spotifyCreds.clientSecret}`).toString('base64');
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: code.toString(),
            redirect_uri: redirectUri
        });

        const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: body.toString()
        });

        if (!tokenRes.ok) {
            const errBody = await tokenRes.text();
            throw new Error(`Fallo en autenticación con Spotify (${tokenRes.status}): ${errBody}`);
        }

        const tokenData = await tokenRes.json();
        spotifySession.accessToken = tokenData.access_token;
        spotifySession.refreshToken = tokenData.refresh_token;
        spotifySession.expiresAt = Date.now() + (tokenData.expires_in * 1000);

        // Obtener perfil del usuario
        try {
            const userRes = await fetch('https://api.spotify.com/v1/me', {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });
            if (userRes.ok) {
                spotifySession.user = await userRes.json();
            }
        } catch (uErr) {
            console.warn('[Spotify Callback] No se pudo obtener el perfil de Spotify:', uErr);
        }

        console.log(`[Spotify] Usuario autenticado: ${spotifySession.user ? spotifySession.user.display_name : 'OK'}`);
        return res.redirect('/#spotify_success=1');
    } catch (err) {
        console.error('[Spotify Callback] Error:', err);
        return res.redirect('/#spotify_error=' + encodeURIComponent(err.message));
    }
});

/**
 * Endpoint: POST /api/spotify/disconnect
 * Cierra la sesión activa de Spotify
 */
app.post('/api/spotify/disconnect', (req, res) => {
    spotifySession = {
        accessToken: null,
        refreshToken: null,
        expiresAt: 0,
        user: null
    };
    res.json({ success: true, message: 'Sesión de Spotify desconectada.' });
});

/**
 * Endpoint: GET /api/spotify/saved-tracks
 * Obtiene las canciones guardadas (Liked Songs) del usuario de Spotify
 */
app.get('/api/spotify/saved-tracks', async (req, res) => {
    try {
        const token = await ensureValidSpotifyToken();
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 50);

        const apiRes = await fetch(`https://api.spotify.com/v1/me/tracks?limit=${limit}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!apiRes.ok) {
            const errData = await apiRes.json().catch(() => ({}));
            throw new Error(errData.error?.message || `Error ${apiRes.status} de la API de Spotify`);
        }

        const data = await apiRes.json();
        const tracks = (data.items || []).map(item => {
            const t = item.track;
            if (!t) return null;
            const artistNames = (t.artists || []).map(a => a.name).join(', ');
            const thumb = (t.album?.images && t.album.images.length > 0) ? t.album.images[0].url : '';
            const durationSec = Math.round((t.duration_ms || 0) / 1000);

            return {
                id: t.id,
                title: t.name,
                artist: artistNames,
                album: t.album?.name || '',
                duration: durationSec,
                durationString: formatDuration(durationSec),
                thumbnail: thumb,
                searchQuery: `${t.name} ${t.artists?.[0]?.name || ''}`.trim()
            };
        }).filter(Boolean);

        return res.json({ total: data.total, count: tracks.length, tracks });
    } catch (err) {
        console.error('[Spotify Tracks] Error:', err);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Endpoint: GET /api/spotify/playlists
 * Obtiene las listas de reproducción (Playlists) del usuario
 */
app.get('/api/spotify/playlists', async (req, res) => {
    try {
        const token = await ensureValidSpotifyToken();
        const apiRes = await fetch('https://api.spotify.com/v1/me/playlists?limit=50', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!apiRes.ok) {
            const errData = await apiRes.json().catch(() => ({}));
            throw new Error(errData.error?.message || `Error ${apiRes.status} de la API de Spotify`);
        }

        const data = await apiRes.json();
        const playlists = (data.items || []).map(pl => {
            if (!pl) return null;
            const thumb = (pl.images && pl.images.length > 0) ? pl.images[0].url : '';
            return {
                id: pl.id,
                name: pl.name,
                description: pl.description || '',
                trackCount: pl.tracks?.total || 0,
                thumbnail: thumb,
                owner: pl.owner?.display_name || 'Spotify'
            };
        }).filter(Boolean);

        return res.json({ total: data.total, playlists });
    } catch (err) {
        console.error('[Spotify Playlists] Error:', err);
        return res.status(500).json({ error: err.message });
    }
});

/**
 * Endpoint: GET /api/spotify/playlist/:id/tracks
 * Obtiene las canciones pertenecientes a una playlist específica de Spotify
 */
app.get('/api/spotify/playlist/:id/tracks', async (req, res) => {
    try {
        const token = await ensureValidSpotifyToken();
        const { id } = req.params;
        const apiRes = await fetch(`https://api.spotify.com/v1/playlists/${id}/tracks?limit=100`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!apiRes.ok) {
            const errData = await apiRes.json().catch(() => ({}));
            throw new Error(errData.error?.message || `Error ${apiRes.status} al consultar playlist`);
        }

        const data = await apiRes.json();
        const tracks = (data.items || []).map(item => {
            const t = item.track;
            if (!t) return null;
            const artistNames = (t.artists || []).map(a => a.name).join(', ');
            const thumb = (t.album?.images && t.album.images.length > 0) ? t.album.images[0].url : '';
            const durationSec = Math.round((t.duration_ms || 0) / 1000);

            return {
                id: t.id,
                title: t.name,
                artist: artistNames,
                album: t.album?.name || '',
                duration: durationSec,
                durationString: formatDuration(durationSec),
                thumbnail: thumb,
                searchQuery: `${t.name} ${t.artists?.[0]?.name || ''}`.trim()
            };
        }).filter(Boolean);

        return res.json({ total: data.total, count: tracks.length, tracks });
    } catch (err) {
        console.error('[Spotify Playlist Tracks] Error:', err);
        return res.status(500).json({ error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════════════
// ENDPOINTS DE YOUTUBE (BÚSQUEDA EXTENDIDA, ANÁLISIS, CONVERSIÓN)
// ══════════════════════════════════════════════════════════════════════

/**
 * Endpoint: POST /api/youtube-search
 * Busca canciones en YouTube devolviendo una lista amplia (por defecto 20 resultados)
 */
app.post('/api/youtube-search', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const { query, limit = 20 } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'Debes ingresar un término de búsqueda.' });
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
            console.warn(`[YouTube Search] Intento ${attempt} falló para "${query}": ${err.message}. Reintentando...`);
            if (attempt < 3) await sleep(1200 * attempt);
        }
    }

    return res.status(500).json({
        error: `Error al buscar en YouTube tras 3 intentos: ${lastError ? lastError.message : 'Error desconocido'}`
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
        'youtube:player_client=android,web',
        'youtube:player_client=web,android',
        'youtube:player_client=mweb'
    ];

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const clientArg = clientOptions[attempt - 1] || clientOptions[0];
            const args = [
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
            console.warn(`[Video Info] Intento ${attempt} falló para "${url}": ${err.message}`);
            if (attempt < 3) await sleep(1200 * attempt);
        }
    }

    return res.status(500).json({
        error: `No se pudo obtener la información del video tras 3 intentos: ${lastError ? lastError.message : 'Error desconocido'}`
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
        'youtube:player_client=android,web',
        'youtube:player_client=web,android',
        'youtube:player_client=mweb'
    ];

    try {
        console.log(`[YouTube Convert] Iniciando pipeline de conversión para: ${url}`);

        let downloadSuccess = false;
        let lastDownloadError = null;

        // BUCLE DE REINTENTOS AUTOMÁTICOS
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const clientArg = clientStrategies[attempt - 1] || clientStrategies[0];
                console.log(`[YouTube Convert] Intento ${attempt}/3 usando estrategia: ${clientArg}`);

                const ytdlArgs = [
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
                    console.log(`[YouTube Convert] Descarga y transcodificación completadas en el intento ${attempt}.`);
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
            throw new Error(`No se pudo descargar el audio tras 3 intentos automáticos: ${lastDownloadError ? lastDownloadError.message : 'Error 403 Forbidden o restricción'}`);
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
            const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/find_active_track_by_hash`, {
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
                    uploadRes = await fetch(`${MEDIA_API_URL}/upload/music`, {
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
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/music_tracks`, {
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

// Inicializar el servidor en 0.0.0.0 para compatibilidad completa con Docker / Render
app.listen(PORT, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(` Servidor de Conversión YouTube + Spotify -> MP3 v1.5.0:`);
    console.log(` http://localhost:${PORT}`);
    console.log(` Plataforma activa: ${process.platform} (${process.arch})`);
    console.log(` yt-dlp: ${YTDLP_BIN}`);
    console.log(` ffmpeg: ${FFMPEG_BIN}`);
    console.log(` Conectado a Supabase: ${SUPABASE_URL}`);
    console.log(` Conectado a Media API: ${MEDIA_API_URL}`);
    console.log(` Spotify Configurado: ${spotifyCreds.clientId ? 'SÍ' : 'NO'}`);
    console.log(`=======================================================`);
});
