/**
 * ============================================================================
 * Proyecto: Conversor de YouTube a MP3 y Uploader para Supabase Chat
 * Archivo: scripts/setup-binaries.js
 * Versión: 1.5.0
 * Descripción: Script de aprovisionamiento multiplataforma de ejecutables
 *              (yt-dlp y ffmpeg) para entornos locales (Windows) y de despliegue
 *              en la nube como Render.com (Linux x64).
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');

const ROOT_DIR = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT_DIR, 'bin');

if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
}

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

console.log(`[Setup Binaries] Detectando plataforma: ${process.platform} (${process.arch})`);

/**
 * Descargar archivo siguiendo redirecciones HTTP/HTTPS
 */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(destPath);
        
        function get(currUrl) {
            https.get(currUrl, (response) => {
                // Manejo de redirecciones 301, 302, 307, 308
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    return get(response.headers.location);
                }
                
                if (response.statusCode !== 200) {
                    fileStream.close();
                    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                    return reject(new Error(`Fallo en descarga (${response.statusCode}): ${currUrl}`));
                }

                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close(resolve);
                });
            }).on('error', (err) => {
                fileStream.close();
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                reject(err);
            });
        }

        get(url);
    });
}

async function setup() {
    try {
        if (isLinux) {
            console.log('[Setup Binaries] Configurando ejecutables para Linux (Render.com)...');

            const ytdlpPath = path.join(BIN_DIR, 'yt-dlp');
            if (!fs.existsSync(ytdlpPath)) {
                console.log('[Setup Binaries] Descargando binario yt-dlp Linux...');
                await downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', ytdlpPath);
                fs.chmodSync(ytdlpPath, 0o755);
                console.log('[Setup Binaries] yt-dlp Linux descargado y marcado como ejecutable.');
            } else {
                fs.chmodSync(ytdlpPath, 0o755);
                console.log('[Setup Binaries] yt-dlp Linux ya existe.');
            }

            const ffmpegPath = path.join(BIN_DIR, 'ffmpeg');
            if (!fs.existsSync(ffmpegPath)) {
                console.log('[Setup Binaries] Descargando FFmpeg Linux x64...');
                const ffmpegZip = path.join(BIN_DIR, 'ffmpeg-linux.zip');
                await downloadFile('https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-linux-64.zip', ffmpegZip);
                
                console.log('[Setup Binaries] Extrayendo FFmpeg...');
                const zip = new AdmZip(ffmpegZip);
                zip.extractAllTo(BIN_DIR, true);
                if (fs.existsSync(ffmpegZip)) fs.unlinkSync(ffmpegZip);
                
                if (fs.existsSync(ffmpegPath)) {
                    fs.chmodSync(ffmpegPath, 0o755);
                    console.log('[Setup Binaries] FFmpeg Linux configurado exitosamente.');
                }
            } else {
                fs.chmodSync(ffmpegPath, 0o755);
                console.log('[Setup Binaries] FFmpeg Linux ya existe.');
            }

        } else if (isWin) {
            console.log('[Setup Binaries] Entorno Windows detectado.');
            const ytdlpWin = path.join(BIN_DIR, 'yt-dlp.exe');
            const ffmpegWin = path.join(BIN_DIR, 'ffmpeg.exe');

            if (!fs.existsSync(ytdlpWin)) {
                console.log('[Setup Binaries] Descargando yt-dlp.exe para Windows...');
                await downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', ytdlpWin);
                console.log('[Setup Binaries] yt-dlp.exe descargado.');
            } else {
                console.log('[Setup Binaries] yt-dlp.exe ya está presente.');
            }

            if (!fs.existsSync(ffmpegWin)) {
                console.log('[Setup Binaries] Descargando ffmpeg.exe para Windows...');
                const zipPath = path.join(BIN_DIR, 'ffmpeg-win.zip');
                await downloadFile('https://github.com/ffbinaries/ffbinaries-prebuilt/releases/download/v6.1/ffmpeg-6.1-win-64.zip', zipPath);
                const zip = new AdmZip(zipPath);
                zip.extractAllTo(BIN_DIR, true);
                if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
                console.log('[Setup Binaries] ffmpeg.exe configurado.');
            } else {
                console.log('[Setup Binaries] ffmpeg.exe ya está presente.');
            }
        } else {
            console.log(`[Setup Binaries] Sistema operativo ${process.platform}. Se recomienda instalar yt-dlp y ffmpeg en el PATH del sistema.`);
        }

        console.log('[Setup Binaries] ✔ Provisión de ejecutables completada con éxito.');
    } catch (err) {
        console.error('[Setup Binaries] ✘ Error durante la configuración de binarios:', err);
        process.exit(1);
    }
}

setup();
