/**
 * ============================================================================
 * Proyecto: Conversor de YouTube a MP3 y Uploader para Supabase Chat
 * Archivo: server.js
 * Versión: 1.1.0
 * Descripción: Servidor Node.js / Express para descargar audio de videos de
 *              YouTube, transcodificar a MP3 de alta fidelidad con FFmpeg,
 *              calcular hash SHA-256 (deduplicación), subir a Cloudflare R2
 *              y registrar pistas en la base de datos de Supabase vinculadas
 *              a la cuenta del usuario y sus respectivos álbumes.
 * ============================================================================
 */

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

// Rutas de ejecutables locales y directorios
const ROOT_DIR = __dirname;
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const TEMP_DIR = path.join(ROOT_DIR, 'temp_audio');

const YTDLP_BIN = path.join(BIN_DIR, 'yt-dlp.exe');
const FFMPEG_BIN = path.join(BIN_DIR, 'ffmpeg.exe');

// Asegurar existencia del directorio temporal
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Servir frontend y recursos estáticos
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use('/js', express.static(path.join(ROOT_DIR, 'js')));

/**
 * Función auxiliar para limpiar nombres de archivo de caracteres no permitidos en Windows
 */
function sanitizeFileName(name) {
    if (!name) return 'cancion';
    return name
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Función para ejecutar procesos de forma asíncrona mediante promesas
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
 * Endpoint: POST /api/video-info
 * Extrae metadatos previos del video de YouTube (título, duración, autor, miniatura)
 */
app.post('/api/video-info', async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'Debes proporcionar una URL válida de YouTube.' });
    }

    try {
        const args = [
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
            durationString: data.duration_string || `${Math.floor((data.duration || 0) / 60)}:${((data.duration || 0) % 60).toString().padStart(2, '0')}`,
            uploader: data.uploader || data.channel,
            thumbnail: data.thumbnail
        });
    } catch (err) {
        console.error('Error al obtener info del video:', err);
        return res.status(500).json({ error: 'No se pudo obtener información del video. Verifica que la URL sea válida y pública.' });
    }
});

/**
 * Endpoint: POST /api/convert-and-upload
 * Orquesta la descarga de audio de YouTube, conversión a MP3, hash SHA-256,
 * subida al Cloudflare Worker R2 y registro en la tabla music_tracks de Supabase.
 */
app.post('/api/convert-and-upload', async (req, res) => {
    const { url, album, customTitle, accessToken, userId } = req.body;

    if (!url || !accessToken || !userId) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos (url, accessToken, userId).' });
    }

    const tempId = crypto.randomUUID();
    const tempFileTemplate = path.join(TEMP_DIR, `${tempId}.%(ext)s`);
    const expectedMp3Path = path.join(TEMP_DIR, `${tempId}.mp3`);

    try {
        console.log(`[YouTube Convert] Iniciando descarga: ${url}`);

        // 1. Descarga del audio y transcodificación a MP3 usando yt-dlp y ffmpeg
        const ytdlArgs = [
            '--ffmpeg-location', FFMPEG_BIN,
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '0',
            '-o', tempFileTemplate,
            '--no-playlist',
            url.trim()
        ];

        await runProcess(YTDLP_BIN, ytdlArgs);

        if (!fs.existsSync(expectedMp3Path)) {
            throw new Error('No se generó el archivo MP3 correspondiente.');
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

        // 4. Verificar si el usuario ya tiene una pista con ese mismo nombre
        const checkNameRes = await fetch(`${SUPABASE_URL}/rest/v1/music_tracks?user_id=eq.${userId}&display_name=eq.${encodeURIComponent(displayName)}&select=id`, {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${accessToken}`
            }
        });
        const existingTracks = checkNameRes.ok ? await checkNameRes.json() : [];
        if (Array.isArray(existingTracks) && existingTracks.length > 0) {
            displayName = `${displayName} (${new Date().toLocaleDateString('es-ES').replace(/\//g, '-')})`;
        }

        // 5. Deduplicación por hash: llamar RPC find_active_track_by_hash en Supabase
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

        // 6. Si no existe previamente, subir el MP3 a Cloudflare R2 Worker
        if (!fileName) {
            console.log(`[YouTube Convert] Subiendo nuevo archivo a Cloudflare R2 Worker...`);
            const uploadRes = await fetch(`${MEDIA_API_URL}/upload/music`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'audio/mpeg',
                    'X-File-Name': encodeURIComponent(`${displayName}.mp3`)
                },
                body: mp3Buffer
            });

            let uploadPayload = null;
            try {
                uploadPayload = await uploadRes.json();
            } catch (jsonErr) {
                // Sin JSON
            }

            if (!uploadRes.ok || !uploadPayload || !uploadPayload.key) {
                throw new Error((uploadPayload && uploadPayload.error) || `Error ${uploadRes.status} al subir audio a R2.`);
            }

            fileName = uploadPayload.key;
            console.log(`[YouTube Convert] Subida a R2 exitosa. Clave asignada: ${fileName}`);
        }

        // 7. Guardar fila en tabla music_tracks de Supabase vinculada al perfil del usuario
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

        console.log(`[YouTube Convert] Pista registrada exitosamente en Supabase: "${displayName}" (ID: ${createdTrack ? createdTrack.id : 'OK'})`);

        return res.json({
            success: true,
            track: createdTrack,
            message: `Canción "${displayName}" convertida y agregada a tu perfil exitosamente.`
        });

    } catch (err) {
        console.error('[YouTube Convert] Error en proceso de conversión/subida:', err);
        return res.status(500).json({
            error: err.message || 'Error interno al procesar el video de YouTube.'
        });
    } finally {
        // Limpieza de archivos temporales
        try {
            if (fs.existsSync(expectedMp3Path)) {
                fs.unlinkSync(expectedMp3Path);
            }
        } catch (cleanErr) {
            console.error('Error al eliminar archivo temporal:', cleanErr);
        }
    }
});

// Inicializar el servidor
app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` Servidor de Conversión YouTube -> MP3 activo en:`);
    console.log(` http://localhost:${PORT}`);
    console.log(` Conectado a Supabase: ${SUPABASE_URL}`);
    console.log(` Conectado a Media API: ${MEDIA_API_URL}`);
    console.log(`=======================================================`);
});
