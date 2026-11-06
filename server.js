/**
 * ============================================================================
 * Proyecto: Conversor de YouTube a MP3 y Uploader para Supabase Chat
 * Archivo: server.js
 * Versión: 1.7.0
 * Descripción: Servidor Express optimizado con:
 *              - Control de acceso por roles: Spotify exclusivo para Marko y administradores
 *              - Bloqueo y protección de endpoints de Spotify contra accesos no autorizados
 *              - Corrección crítica de Redirect URI y detección de IP Wi-Fi para Código QR
 *              - Soporte de Spotify personal con persistencia de sesiones en temp_audio/
 *              - Prevención y manejo amigable de errores de puerto ocupado (EADDRINUSE)
 *              - Soporte multiplataforma (Windows y Linux para Render.com)
 *              - Búsqueda extendida en YouTube (hasta 40 resultados por consulta)
 *              - Barra interactiva de pre-escucha antes de descargar
 *              - Pipeline de reintentos con rotación de clientes y soporte JS runtime
 *              - Deduplicación por hash SHA-256 en Cloudflare R2 y gestión de álbumes
 * ============================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

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
const SESSIONS_FILE = path.join(TEMP_DIR, 'spotify_sessions.json');

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

// Configuración de credenciales de Spotify Developer API
let spotifyCreds = {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    redirectUri: process.env.SPOTIFY_REDIRECT_URI || ''
};

// Almacén multi-usuario de sesiones de Spotify: { [userId]: { accessToken, refreshToken, expiresAt, user, username } }
let userSpotifySessions = {};

// Cargar sesiones persistidas si existen
try {
    if (fs.existsSync(SESSIONS_FILE)) {
        const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
        userSpotifySessions = JSON.parse(raw);
        console.log(`[Spotify] ${Object.keys(userSpotifySessions).length} sesiones de usuario cargadas desde almacenamiento.`);
    }
} catch (e) {
    userSpotifySessions = {};
}

function persistSpotifySessions() {
    try {
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(userSpotifySessions, null, 2), 'utf8');
    } catch (e) {
        console.warn('[Spotify] Aviso al persistir sesiones:', e.message);
    }
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
 * Obtener la IP de red local real (filtrando interfaces virtuales o APIPA 169.254.x.x)
 */
function getLocalNetworkIp() {
    const interfaces = os.networkInterfaces();
    let fallback = 'localhost';

    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && !alias.internal) {
                // Descartar direcciones APIPA (169.254.*.*)
                if (!alias.address.startsWith('169.254.')) {
                    // Priorizar subredes privadas locales clásicas
                    if (alias.address.startsWith('192.168.') || alias.address.startsWith('10.') || alias.address.startsWith('172.')) {
                        return alias.address;
                    }
                    fallback = alias.address;
                }
            }
        }
    }
    return fallback;
}

/**
 * Verificar si el usuario es Marko o administrador en Supabase
 */
async function isMarkoOrAdmin(userId, username) {
    if (username && username.trim().toLowerCase() === 'marko') return true;
    if (!userId) return false;

    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=username,is_admin`, {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`
            }
        });

        if (res.ok) {
            const rows = await res.json();
            if (Array.isArray(rows) && rows.length > 0) {
                const p = rows[0];
                return (p.username && p.username.toLowerCase() === 'marko') || p.is_admin === true;
            }
        }
    } catch (err) {
        console.warn('[Auth Check] Aviso al verificar perfil de usuario:', err.message);
    }
    return false;
}

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
 * Obtener la URL de redirección efectiva de Spotify, blindada contra URLs externas erróneas
 */
function getEffectiveRedirectUri(req) {
    let rawUri = (spotifyCreds.redirectUri || '').trim();

    // Si la URI contiene github.io u otro dominio que no procese este backend, ignorarla
    if (rawUri && !rawUri.includes('github.io') && (rawUri.startsWith('http://') || rawUri.startsWith('https://'))) {
        if (!rawUri.endsWith('/api/spotify/callback')) {
            rawUri = rawUri.replace(/\/+$/, '') + '/api/spotify/callback';
        }
        return rawUri;
    }

    // Por defecto: basada en la petición actual que llega a este servidor
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.get('host');
    return `${proto}://${host}/api/spotify/callback`;
}

/**
 * Refrescar token de Spotify para un usuario específico
 */
async function ensureValidSpotifyToken(userId) {
    const userSession = userSpotifySessions[userId];
    if (!userSession || !userSession.accessToken) {
        throw new Error('No hay sesión de Spotify activa para este perfil. Conecta tu cuenta primero.');
    }

    // Si aún tiene más de 60 segundos de validez, usar el actual
    if (Date.now() < (userSession.expiresAt - 60000)) {
        return userSession.accessToken;
    }

    if (!userSession.refreshToken) {
        throw new Error('La sesión de Spotify expiró. Vuelve a iniciar sesión con tu cuenta.');
    }

    console.log(`[Spotify] Renovando token para el usuario ${userId}...`);
    const basicAuth = Buffer.from(`${spotifyCreds.clientId}:${spotifyCreds.clientSecret}`).toString('base64');
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: userSession.refreshToken
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
        delete userSpotifySessions[userId];
        persistSpotifySessions();
        throw new Error('No se pudo renovar la sesión de Spotify. Inicia sesión de nuevo.');
    }

    const data = await res.json();
    userSession.accessToken = data.access_token;
    userSession.expiresAt = Date.now() + (data.expires_in * 1000);
    if (data.refresh_token) {
        userSession.refreshToken = data.refresh_token;
    }

    persistSpotifySessions();
    return userSession.accessToken;
}

// ══════════════════════════════════════════════════════════════════════
// ENDPOINTS DE SPOTIFY (PROTEGIDOS: SOLO MARKO O ADMINISTRADORES)
// ══════════════════════════════════════════════════════════════════════

/**
 * Endpoint: GET /api/spotify/status
 * Estado de Spotify para el usuario consultado y lista de URIs recomendadas
 */
app.get('/api/spotify/status', async (req, res) => {
    const userId = req.query.userId || req.headers['x-user-id'];
    const username = req.query.username || '';

    // Validar acceso exclusivo a Marko o administradores
    const hasAccess = await isMarkoOrAdmin(userId, username);
    if (!hasAccess) {
        return res.status(403).json({
            configured: false,
            authenticated: false,
            restricted: true,
            message: 'Spotify está reservado exclusivamente para Marko y administradores.'
        });
    }

    const isConfigured = Boolean(spotifyCreds.clientId && spotifyCreds.clientSecret);
    const userSession = userId ? userSpotifySessions[userId] : null;
    const isAuthenticated = Boolean(userSession && userSession.accessToken && Date.now() < userSession.expiresAt);

    const localIp = getLocalNetworkIp();
    const recommendedUris = [
        `http://localhost:${PORT}/api/spotify/callback`,
        `http://${localIp}:${PORT}/api/spotify/callback`
    ];

    res.json({
        configured: isConfigured,
        clientIdMasked: spotifyCreds.clientId ? (spotifyCreds.clientId.slice(0, 6) + '...' + spotifyCreds.clientId.slice(-4)) : null,
        clientId: spotifyCreds.clientId || '',
        authenticated: isAuthenticated,
        user: isAuthenticated ? userSession.user : null,
        effectiveRedirectUri: getEffectiveRedirectUri(req),
        recommendedUris,
        localIp
    });
});

/**
 * Endpoint: POST /api/spotify/save-credentials
 * Guarda credenciales de Spotify en caliente y en el archivo .env
 */
app.post('/api/spotify/save-credentials', (req, res) => {
    const { clientId, clientSecret, redirectUri } = req.body;
    if (!clientId || !clientSecret) {
        return res.status(400).json({ error: 'Debes proporcionar Client ID y Client Secret.' });
    }

    spotifyCreds.clientId = clientId.trim();
    spotifyCreds.clientSecret = clientSecret.trim();
    if (redirectUri) {
        spotifyCreds.redirectUri = redirectUri.trim();
    } else if (!spotifyCreds.redirectUri || spotifyCreds.redirectUri.includes('github.io')) {
        spotifyCreds.redirectUri = `http://localhost:${PORT}/api/spotify/callback`;
    }

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
        envContent = updateEnvVar(envContent, 'SPOTIFY_REDIRECT_URI', spotifyCreds.redirectUri);

        fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
        console.log('[Spotify] Credenciales guardadas exitosamente en .env');
    } catch (fsErr) {
        console.warn('[Spotify] Aviso al escribir archivo .env:', fsErr.message);
    }

    return res.json({ success: true, message: 'Credenciales de Spotify guardadas correctamente.' });
});

/**
 * Endpoint: GET /api/spotify/qr
 * Genera Código QR para vincular Spotify (validando que sea Marko o admin)
 */
app.get('/api/spotify/qr', async (req, res) => {
    const userId = req.query.userId;
    const username = req.query.username || '';

    const hasAccess = await isMarkoOrAdmin(userId, username);
    if (!hasAccess) {
        return res.status(403).json({ error: 'Acceso no autorizado: función exclusiva para Marko o admin.' });
    }

    if (!spotifyCreds.clientId || !spotifyCreds.clientSecret) {
        return res.status(400).json({ error: 'Falta configurar credenciales de Spotify en el servidor.' });
    }

    try {
        const isRender = Boolean(process.env.RENDER || (spotifyCreds.redirectUri && !spotifyCreds.redirectUri.includes('localhost')));
        const hostBase = isRender 
            ? `https://${req.get('host')}`
            : `http://${getLocalNetworkIp()}:${PORT}`;

        const authEndpointUrl = `${hostBase}/api/spotify/login?userId=${encodeURIComponent(userId)}&username=${encodeURIComponent(username)}&fromMobile=1`;

        const qrDataUrl = await QRCode.toDataURL(authEndpointUrl, {
            errorCorrectionLevel: 'M',
            margin: 2,
            width: 260,
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        });

        res.json({
            success: true,
            authUrl: authEndpointUrl,
            qrDataUrl,
            hostBase
        });
    } catch (err) {
        console.error('[Spotify QR] Error:', err);
        res.status(500).json({ error: 'Error al generar código QR: ' + err.message });
    }
});

/**
 * Endpoint: GET /api/spotify/login
 * Inicia el flujo OAuth 2.0 validando permisos de Marko o administrador
 */
app.get('/api/spotify/login', async (req, res) => {
    if (!spotifyCreds.clientId || !spotifyCreds.clientSecret) {
        return res.status(400).send(`
            <html><body style="background:#0c0e12;color:#fff;font-family:sans-serif;padding:2rem;text-align:center;">
                <h2>Faltan credenciales de Spotify</h2>
                <p>Configura primero tu Client ID y Client Secret en la aplicación.</p>
                <a href="/" style="color:#1db954;">Regresar a la app</a>
            </body></html>
        `);
    }

    const userId = req.query.userId || 'anon';
    const username = req.query.username || '';

    const hasAccess = await isMarkoOrAdmin(userId, username);
    if (!hasAccess) {
        return res.status(403).send(`
            <html><body style="background:#0c0e12;color:#fff;font-family:sans-serif;padding:2rem;text-align:center;">
                <h2>Acceso Restringido</h2>
                <p>La vinculación de Spotify está habilitada exclusivamente para el usuario Marko y administradores.</p>
                <a href="/" style="color:#1db954;">Regresar al chat</a>
            </body></html>
        `);
    }

    const isMobile = req.query.fromMobile === '1' || /mobile|android|iphone|ipad/i.test(req.headers['user-agent'] || '');

    const statePayload = {
        userId,
        username,
        isMobile: Boolean(isMobile),
        nonce: crypto.randomBytes(8).toString('hex')
    };
    const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

    const redirectUri = getEffectiveRedirectUri(req);
    const scopes = [
        'user-library-read',
        'playlist-read-private',
        'playlist-read-collaborative',
        'user-read-private',
        'user-read-email'
    ].join(' ');

    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', spotifyCreds.clientId);
    authUrl.searchParams.set('scope', scopes);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);

    console.log(`[Spotify Login] Autorizando a @${username} (userId: ${userId}). Redirect: ${redirectUri}`);
    res.redirect(authUrl.toString());
});

/**
 * Endpoint: GET /api/spotify/callback
 * Callback de Spotify que recibe el código, decodifica el state y asocia el token al perfil
 */
app.get('/api/spotify/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
        console.error('[Spotify Callback] Error devuelto por Spotify:', error);
        return res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <title>Error de Spotify</title>
                <style>
                    body { background: #0c0e12; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
                    .card { background: #15181f; border: 1px solid #ef4444; border-radius: 16px; padding: 2rem; max-width: 440px; box-shadow: 0 10px 30px rgba(0,0,0,0.7); }
                    .icon { font-size: 3rem; margin-bottom: 0.5rem; color: #ef4444; }
                    h2 { margin: 0 0 0.5rem 0; }
                    p { color: #9ca3af; font-size: 0.9rem; line-height: 1.4; }
                    a { display: inline-block; margin-top: 1.2rem; background: #1db954; color: #fff; padding: 10px 20px; border-radius: 20px; text-decoration: none; font-weight: bold; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon">⚠️</div>
                    <h2>Error de Autorización en Spotify</h2>
                    <p>Spotify devolvió el error: <strong style="color:#ef4444;">${error}</strong></p>
                    <p style="margin-top:8px;">Asegúrate de agregar la Redirect URI exacta en los Settings de tu app en <a href="https://developer.spotify.com/dashboard" target="_blank" style="color:#1db954;">Spotify Developer</a>.</p>
                    <a href="/">Regresar a la Aplicación</a>
                </div>
            </body>
            </html>
        `);
    }

    if (!code) {
        return res.redirect('/#spotify_error=no_code');
    }

    let stateData = { userId: 'anon', username: '', isMobile: false };
    try {
        if (state) {
            stateData = JSON.parse(Buffer.from(state.toString(), 'base64url').toString('utf8'));
        }
    } catch (e) {
        console.warn('[Spotify Callback] Aviso al decodificar state:', e.message);
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
        let userProfile = null;

        try {
            const userRes = await fetch('https://api.spotify.com/v1/me', {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });
            if (userRes.ok) {
                userProfile = await userRes.json();
            }
        } catch (uErr) {
            console.warn('[Spotify Callback] No se pudo obtener el perfil de Spotify:', uErr);
        }

        // Asociar sesión de Spotify al perfil de usuario específico
        const targetUserId = stateData.userId || 'anon';
        userSpotifySessions[targetUserId] = {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + (tokenData.expires_in * 1000),
            user: userProfile,
            username: stateData.username,
            updatedAt: new Date().toISOString()
        };

        persistSpotifySessions();
        console.log(`[Spotify] ✔ Perfil de Spotify "${userProfile?.display_name || userProfile?.id}" vinculado con éxito al usuario @${stateData.username} (ID: ${targetUserId})`);

        // Si la autorización se hizo desde un dispositivo móvil (ej. escaneo de QR)
        if (stateData.isMobile) {
            return res.send(`
                <!DOCTYPE html>
                <html lang="es">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Spotify Vinculado</title>
                    <style>
                        body { background: #0c0e12; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 1.5rem; }
                        .card { background: #15181f; border: 1px solid #1db954; border-radius: 16px; padding: 2rem; max-width: 360px; box-shadow: 0 10px 30px rgba(0,0,0,0.7); }
                        .icon { font-size: 3.5rem; margin-bottom: 1rem; color: #1db954; }
                        h2 { margin: 0 0 0.5rem 0; font-size: 1.3rem; }
                        p { color: #9ca3af; font-size: 0.95rem; line-height: 1.4; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <div class="icon">✔</div>
                        <h2>¡Spotify Conectado!</h2>
                        <p>Tu cuenta de Spotify <strong>${userProfile?.display_name || ''}</strong> se ha vinculado a tu usuario <strong>@${stateData.username}</strong>.</p>
                        <p style="margin-top: 1rem; font-size: 0.85rem; color: #10b981;">Ya puedes volver a la pantalla de tu computadora, la música cargará automáticamente.</p>
                    </div>
                </body>
                </html>
            `);
        }

        return res.redirect('/#spotify_success=1');
    } catch (err) {
        console.error('[Spotify Callback] Error:', err);
        return res.redirect('/#spotify_error=' + encodeURIComponent(err.message));
    }
});

/**
 * Endpoint: POST /api/spotify/disconnect
 * Cierra la sesión activa de Spotify para el usuario correspondiente
 */
app.post('/api/spotify/disconnect', (req, res) => {
    const userId = req.body.userId || req.headers['x-user-id'];
    if (userId && userSpotifySessions[userId]) {
        delete userSpotifySessions[userId];
        persistSpotifySessions();
    }
    res.json({ success: true, message: 'Sesión de Spotify desconectada para tu perfil.' });
});

/**
 * Endpoint: GET /api/spotify/saved-tracks
 * Obtiene las canciones guardadas (Liked Songs) del usuario
 */
app.get('/api/spotify/saved-tracks', async (req, res) => {
    try {
        const userId = req.query.userId || req.headers['x-user-id'];
        const token = await ensureValidSpotifyToken(userId);
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
        const userId = req.query.userId || req.headers['x-user-id'];
        const token = await ensureValidSpotifyToken(userId);
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
 * Obtiene las pistas de una playlist de Spotify
 */
app.get('/api/spotify/playlist/:id/tracks', async (req, res) => {
    try {
        const userId = req.query.userId || req.headers['x-user-id'];
        const token = await ensureValidSpotifyToken(userId);
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
 * Busca canciones en YouTube devolviendo una lista amplia (hasta 50 resultados)
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

// Inicializar el servidor en 0.0.0.0 con captura de error EADDRINUSE amigable
const server = app.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalNetworkIp();
    console.log(`=======================================================`);
    console.log(` Servidor de Conversión YouTube + Spotify -> MP3 v1.7.0:`);
    console.log(` Local:      http://localhost:${PORT}`);
    console.log(` Red Wi-Fi:  http://${localIp}:${PORT}`);
    console.log(` Plataforma activa: ${process.platform} (${process.arch})`);
    console.log(` yt-dlp:     ${YTDLP_BIN}`);
    console.log(` ffmpeg:     ${FFMPEG_BIN}`);
    console.log(` Supabase:   ${SUPABASE_URL}`);
    console.log(` Media API:  ${MEDIA_API_URL}`);
    console.log(` Spotify Client ID: ${spotifyCreds.clientId ? (spotifyCreds.clientId.slice(0, 6) + '...') : 'NO CONFIGURADO'}`);
    console.log(` Control de Acceso: Spotify exclusivo para Marko y administradores`);
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
