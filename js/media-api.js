// js/media-api.js
// Cliente del Worker de Cloudflare (R2) para audio y video.
// Requiere MEDIA_API_URL (config.js) y supabaseClient. Cargar después de config.js.

// Las canciones nuevas viven en R2 y su file_name empieza con "music/".
// Las viejas (Supabase Storage) no tienen ese prefijo: se siguen leyendo
// por el camino anterior mientras existan.
function isR2MusicKey(key) {
    return typeof key === 'string' && key.startsWith('music/');
}

async function getAccessToken() {
    const { data } = await supabaseClient.auth.getSession();
    return data && data.session ? data.session.access_token : null;
}

function assertMediaApiConfigured() {
    if (!MEDIA_API_URL || MEDIA_API_URL.includes('TU-WORKER')) {
        throw new Error('Falta configurar MEDIA_API_URL en js/config.js (URL de tu Worker de Cloudflare).');
    }
}

// kind: 'music' | 'chat'. Devuelve { key } (music) o { key, url } (chat).
async function uploadToR2(kind, file) {
    assertMediaApiConfigured();
    const token = await getAccessToken();
    if (!token) throw new Error('Tu sesión expiró. Inicia sesión de nuevo.');

    const res = await fetch(`${MEDIA_API_URL}/upload/${kind}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': file.type || 'application/octet-stream',
            'X-File-Name': encodeURIComponent(file.name || 'archivo')
        },
        body: file
    });

    let payload = null;
    try { payload = await res.json(); } catch (e) { /* sin cuerpo JSON */ }
    if (!res.ok) throw new Error((payload && payload.error) || `Error ${res.status} al subir el archivo.`);
    return payload;
}

// URL temporal de reproducción (se cachea hasta poco antes de vencer).
const r2SignedUrlCache = new Map();

async function getR2SignedUrl(key) {
    const cached = r2SignedUrlCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.url;

    assertMediaApiConfigured();
    const token = await getAccessToken();
    if (!token) throw new Error('Tu sesión expiró. Inicia sesión de nuevo.');

    const res = await fetch(`${MEDIA_API_URL}/sign`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
    });
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* sin cuerpo JSON */ }
    if (!res.ok) throw new Error((payload && payload.error) || `Error ${res.status} al obtener la canción.`);

    r2SignedUrlCache.set(key, { url: payload.url, expiresAt: Date.now() + payload.expiresIn * 1000 });
    return payload.url;
}
