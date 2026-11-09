/**
 * ============================================================================
 * Proyecto: Conversor de YouTube a MP3 y Uploader para Supabase Chat
 * Archivo: public/app.js
 * Versión: 1.9.6
 * Descripción: Lógica del cliente enfocada y optimizada para YouTube:
 *              - Resaltado visual interactivo y badge animado en la canción de YouTube en reproducción
 *              - Tarjeta inline inamovible de comparación de duplicados
 *              - Sincronización en tiempo real del reproductor previo y resultados de búsqueda
 *              - Cache-busting estricto (?v=1.9.3) y soporte SSL universal en backend
 * ============================================================================
 */

const $ = (id) => document.getElementById(id);

// Estado de la sesión y aplicación
let currentUserId = null;
let currentAccessToken = null;
let currentUsername = null;
let cachedUsernames = null;
let myTracksCache = [];
const albumExpandState = new Map();
let currentLoadedVideoId = null;
let currentPlayingVideoId = null;
const bypassedSimilarityTitles = new Set();

/**
 * Función robusta para realizar fetch con timeout y control de errores JSON/HTML
 */
async function safeFetchJson(url, options = {}, timeoutMs = 180000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fetchOptions = { ...options, signal: controller.signal };

    let res = null;
    try {
        res = await fetch(url, fetchOptions);
    } catch (netErr) {
        clearTimeout(timer);
        if (netErr.name === 'AbortError') {
            throw new Error(`La operación tardó demasiado tiempo (más de ${Math.round(timeoutMs / 1000)}s) y fue cancelada. Puedes reintentar.`);
        }
        throw new Error('No se pudo comunicar con el servidor local. Verifica que la terminal tenga corriendo "npm start".');
    } finally {
        clearTimeout(timer);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Error del servidor (${res.status})`);
        return data;
    } else {
        const text = await res.text();
        if (!res.ok) {
            throw new Error(res.status === 504 ? 'El proxy intermediario agotó el tiempo de espera (Error 504 Gateway Timeout). El servidor en segundo plano sigue procesando.' : `El servidor devolvió error ${res.status}.`);
        }
        try {
            return JSON.parse(text);
        } catch (parseErr) {
            throw new Error('El servidor devolvió una respuesta inesperada.');
        }
    }
}

/**
 * Restablecer de inmediato el botón de conversión a su estado activo
 */
function resetConvertButtonState() {
    const btn = $('btnConvertAndUpload');
    if (btn) {
        btn.disabled = false;
        $('convertBtnIcon').textContent = '⚡';
        $('convertBtnText').textContent = 'Convertir a MP3 y Subir a mi Perfil';
    }
    const resetBtn = $('btnResetConvertState');
    if (resetBtn) {
        resetBtn.classList.add('hide');
    }
}

// ══════════════════════════════════════════════════════════════════════
// 1. SISTEMA DE LOGIN Y REGISTRO (IDÉNTICO AL CHAT ORIGINAL SIN INVITADOS)
// ══════════════════════════════════════════════════════════════════════

function showLockError(msg) {
    const el = $('lockError');
    if (!msg) {
        el.style.display = 'none';
        el.textContent = '';
    } else {
        el.textContent = msg;
        el.style.display = 'block';
    }
}

$('showRegisterLink').onclick = () => {
    showLockError('');
    $('accountForm').classList.add('hide');
    $('registerForm').classList.remove('hide');
    $('registerUsernameInput').focus();
};

$('showLoginLink').onclick = () => {
    showLockError('');
    $('registerForm').classList.add('hide');
    $('accountForm').classList.remove('hide');
    $('accountUsernameInput').focus();
};

/**
 * Obtener la lista completa de todos los usuarios registrados del chat
 */
async function fetchUsernames() {
    if (cachedUsernames) return cachedUsernames;
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=username&order=username.asc`, {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`
            }
        });
        const data = response.ok ? await response.json() : [];
        cachedUsernames = Array.isArray(data) ? data.map(p => p.username).filter(Boolean) : [];
    } catch (e) {
        console.error('Error al obtener lista de usuarios:', e);
        cachedUsernames = [];
    }
    return cachedUsernames;
}

$('btnUsersToggle').onclick = async () => {
    const sel = $('userDropdownSelect');
    if (!sel.classList.contains('hide')) {
        sel.classList.add('hide');
        return;
    }
    const list = await fetchUsernames();
    if (list.length > 0) {
        sel.innerHTML = list.map(u => `<option value="${u.replace(/"/g, '&quot;')}">${u.replace(/</g, '&lt;')}</option>`).join('');
    } else {
        sel.innerHTML = '<option disabled>Sin usuarios registrados</option>';
    }
    sel.classList.remove('hide');
};

$('userDropdownSelect').onchange = (e) => {
    $('accountUsernameInput').value = e.target.value;
    e.target.classList.add('hide');
    $('accountPasswordInput').focus();
};

async function handleLogin() {
    const username = $('accountUsernameInput').value.trim();
    const password = $('accountPasswordInput').value;
    showLockError('');

    if (!username || !password) {
        showLockError('Escribe tu usuario y contraseña.');
        return;
    }

    try {
        $('accountLoginBtn').disabled = true;
        $('accountLoginBtn').textContent = 'Entrando...';

        const user = await loginAccount(username, password);
        currentUserId = user.id;
        currentUsername = username;

        const session = (await supabaseClient.auth.getSession()).data.session;
        currentAccessToken = session ? session.access_token : null;

        $('currentUsernameText').textContent = username;
        $('lockOverlay').style.display = 'none';
        $('appCard').classList.remove('hide');

        logEvent(`Sesión iniciada como @${username}`, 'success');

        await loadAlbumsDataList();
        await loadUploadedTracks();

    } catch (err) {
        showLockError(err.message || 'Usuario o contraseña incorrectos.');
    } finally {
        $('accountLoginBtn').disabled = false;
        $('accountLoginBtn').textContent = 'Entrar';
    }
}

$('accountLoginBtn').onclick = handleLogin;
$('accountPasswordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
});

async function handleRegister() {
    const username = $('registerUsernameInput').value.trim();
    const password = $('registerPasswordInput').value;
    showLockError('');

    if (!username || !password) {
        showLockError('Elige un usuario y una contraseña.');
        return;
    }

    try {
        $('registerBtn').disabled = true;
        $('registerBtn').textContent = 'Creando cuenta...';

        await registerAccount(username, password);
        cachedUsernames = null;

        $('accountUsernameInput').value = username;
        $('accountPasswordInput').value = password;
        $('registerForm').classList.add('hide');
        $('accountForm').classList.remove('hide');

        await handleLogin();
    } catch (err) {
        showLockError(err.message || 'Error al crear la cuenta.');
    } finally {
        $('registerBtn').disabled = false;
        $('registerBtn').textContent = 'Crear cuenta';
    }
}

$('registerBtn').onclick = handleRegister;
$('registerPasswordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleRegister();
});

$('btnLogout').onclick = async () => {
    await supabaseClient.auth.signOut();
    location.reload();
};

// ══════════════════════════════════════════════════════════════════════
// 2. CONSOLA DE EVENTOS Y PESTAÑAS DE MODO
// ══════════════════════════════════════════════════════════════════════

function logEvent(message, type = 'info') {
    const consoleBox = $('consoleBox');
    consoleBox.classList.remove('hide');

    const line = document.createElement('div');
    line.className = `console-line ${type}`;

    const iconSpan = document.createElement('span');
    iconSpan.textContent = type === 'success' ? '✔' : type === 'error' ? '✘' : type === 'warn' ? '▲' : '❯';

    const textSpan = document.createElement('span');
    textSpan.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

    line.appendChild(iconSpan);
    line.appendChild(textSpan);

    consoleBox.appendChild(line);
    consoleBox.scrollTop = consoleBox.scrollHeight;
}

$('tabModeSearch').onclick = () => {
    $('tabModeSearch').classList.add('active');
    $('tabModeDirect').classList.remove('active');
    $('viewSearch').classList.remove('hide');
    $('viewDirect').classList.add('hide');
};

$('tabModeDirect').onclick = () => {
    $('tabModeDirect').classList.add('active');
    $('tabModeSearch').classList.remove('active');
    $('viewDirect').classList.remove('hide');
    $('viewSearch').classList.add('hide');
};

// ══════════════════════════════════════════════════════════════════════
// 3. BARRA DE PRE-ESCUCHA INTERACTIVA Y RESALTADO DE PISTA ACTIVA
// ══════════════════════════════════════════════════════════════════════

function updatePlayingPreviewHighlight() {
    const rows = document.querySelectorAll('.search-item');
    rows.forEach(row => {
        const rowVid = row.dataset.videoId;
        const listenBtn = row.querySelector('.search-btn-listen');
        const infoEl = row.querySelector('.search-info');
        const titleEl = row.querySelector('.search-title');
        let badge = row.querySelector('.playing-indicator-badge');

        if (currentPlayingVideoId && rowVid === currentPlayingVideoId) {
            row.classList.add('playing-now');
            if (listenBtn) {
                listenBtn.innerHTML = '🔊 Sonando';
            }
            if (!badge && titleEl) {
                badge = document.createElement('span');
                badge.className = 'playing-indicator-badge';
                badge.innerHTML = '▶ Sonando';
                titleEl.appendChild(badge);
            }
        } else {
            row.classList.remove('playing-now');
            if (listenBtn) {
                listenBtn.innerHTML = '▶ Probar';
            }
            if (badge) {
                badge.remove();
            }
        }
    });

    const previewBtn = $('btnPreviewCurrentVideo');
    if (previewBtn) {
        if (currentPlayingVideoId && currentLoadedVideoId === currentPlayingVideoId) {
            previewBtn.innerHTML = '🔊 Sonando ahora';
            previewBtn.style.borderColor = 'var(--primary)';
            previewBtn.style.color = 'var(--primary)';
        } else {
            previewBtn.innerHTML = '▶ Escuchar previo';
            previewBtn.style.borderColor = '';
            previewBtn.style.color = '';
        }
    }
}

let isPreviewExpanded = false;

function toggleExpandPreview() {
    isPreviewExpanded = !isPreviewExpanded;
    const bar = $('previewFixedBar');
    const btn = $('btnToggleExpandPreview');
    if (!bar || !btn) return;

    if (isPreviewExpanded) {
        bar.classList.add('preview-expanded');
        btn.innerHTML = '🗗 Reducir';
        btn.title = 'Volver al reproductor compacto (solo audio)';
    } else {
        bar.classList.remove('preview-expanded');
        btn.innerHTML = '⛶ Ver video';
        btn.title = 'Expandir para ver el video completo';
    }
}

function playPreview(videoId, title) {
    if (!videoId) return;
    currentPlayingVideoId = videoId;
    const bar = $('previewFixedBar');
    const wrap = $('previewIframeWrap');

    $('previewBarTitle').textContent = title || 'Vista previa';
    wrap.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoId}?autoplay=1&enablejsapi=1" allow="autoplay" title="Vista previa"></iframe>`;
    bar.classList.remove('hide');

    updatePlayingPreviewHighlight();
}

function closePreview() {
    currentPlayingVideoId = null;
    isPreviewExpanded = false;
    const bar = $('previewFixedBar');
    const wrap = $('previewIframeWrap');
    const btn = $('btnToggleExpandPreview');
    if (btn) btn.innerHTML = '⛶ Ver video';
    wrap.innerHTML = '';
    bar.classList.remove('preview-expanded');
    bar.classList.add('hide');

    updatePlayingPreviewHighlight();
}

$('btnClosePreviewBar').onclick = closePreview;
if ($('btnToggleExpandPreview')) {
    $('btnToggleExpandPreview').onclick = toggleExpandPreview;
}

// ══════════════════════════════════════════════════════════════════════
// 3.5. SISTEMA DE COLA DE DESCARGA (QUEUE SYSTEM)
// ══════════════════════════════════════════════════════════════════════

const downloadQueue = [];
let isQueueProcessing = false;
let isQueueMinimized = false;
const uploadDurationsHistory = [40]; // Histórico de tiempos de subida en segundos (base 40s)

/**
 * Calcula el tiempo promedio de subida a partir de los tiempos reales registrados
 */
function getAverageUploadDuration() {
    if (uploadDurationsHistory.length === 0) return 40;
    const sum = uploadDurationsHistory.reduce((a, b) => a + b, 0);
    return Math.max(Math.round(sum / uploadDurationsHistory.length), 15);
}

/**
 * Formatea segundos a texto amigable de tiempo estimado
 */
function formatTimeRemaining(seconds) {
    if (!seconds || seconds <= 0) return '0s';
    if (seconds < 60) return `~${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
}

/**
 * Agrega una canción a la cola de descargas y procesa secuencialmente una por una
 */
function addToDownloadQueue(item) {
    if (!item || !item.url) return;

    // Verificar si ya está en la cola pendiente o procesándose
    const existing = downloadQueue.find(q => q.url === item.url && (q.status === 'pending' || q.status === 'processing'));
    if (existing) {
        logEvent(`La canción "${item.title}" ya está en la cola de descarga.`, 'warn');
        showQueuePanel();
        return;
    }

    const queueId = 'queue_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const avgDuration = getAverageUploadDuration();
    const pendingCount = downloadQueue.filter(q => q.status === 'pending').length;
    const estimatedWaitSec = (pendingCount + (isQueueProcessing ? 1 : 0)) * avgDuration;

    const queueItem = {
        id: queueId,
        url: item.url,
        title: item.title || 'Canción de YouTube',
        cleanTitle: item.cleanTitle || item.title || 'Canción de YouTube',
        album: item.album || null,
        thumbnail: item.thumbnail || 'https://i.ytimg.com/vi/hqdefault.jpg',
        durationString: item.durationString || '',
        status: 'pending', // 'pending' | 'processing' | 'completed' | 'error'
        elapsedSec: 0,
        errorMsg: null
    };

    downloadQueue.push(queueItem);
    showQueuePanel();
    renderDownloadQueue();

    const pos = downloadQueue.filter(q => q.status === 'pending').length;
    logEvent(`➕ Añadida a la cola: "${queueItem.title}" (Posición #${pos} | Espera est.: ${formatTimeRemaining(estimatedWaitSec)})`, 'info');

    // Iniciar procesamiento secuencial si no está activo
    if (!isQueueProcessing) {
        processDownloadQueue();
    }
}

function showQueuePanel() {
    const panel = $('downloadQueuePanel');
    const btn = $('btnToggleQueueMinimize');
    if (panel) {
        panel.classList.remove('hide');
        panel.classList.remove('minimized');
        isQueueMinimized = false;
        if (btn) {
            btn.textContent = '−';
            btn.title = 'Minimizar cola';
        }
    }
}

function closeAlbumPrompt() {
    const panel = $('albumPromptSidePanel');
    if (panel) panel.classList.add('hide');
    const modal = $('albumPromptModal');
    if (modal) modal.classList.add('hide');
}

function toggleQueueMinimize() {
    const panel = $('downloadQueuePanel');
    const btn = $('btnToggleQueueMinimize');
    if (!panel || !btn) return;

    isQueueMinimized = !isQueueMinimized;
    if (isQueueMinimized) {
        panel.classList.add('minimized');
        btn.textContent = '+';
        btn.title = 'Expandir cola';
    } else {
        panel.classList.remove('minimized');
        btn.textContent = '−';
        btn.title = 'Minimizar cola';
    }
}

function removeFromDownloadQueue(queueId) {
    const idx = downloadQueue.findIndex(q => q.id === queueId);
    if (idx !== -1) {
        const item = downloadQueue[idx];
        if (item.status === 'processing') {
            logEvent(`No se puede quitar "${item.title}" porque ya se está descargando.`, 'warn');
            return;
        }
        downloadQueue.splice(idx, 1);
        renderDownloadQueue();
        logEvent(`Eliminada de la cola: "${item.title}"`, 'info');
        if (downloadQueue.length === 0) {
            $('downloadQueuePanel').classList.add('hide');
        }
    }
}

function clearCompletedDownloadQueue() {
    for (let i = downloadQueue.length - 1; i >= 0; i--) {
        if (downloadQueue[i].status === 'completed' || downloadQueue[i].status === 'error') {
            downloadQueue.splice(i, 1);
        }
    }
    renderDownloadQueue();
    if (downloadQueue.length === 0) {
        $('downloadQueuePanel').classList.add('hide');
    }
}

/**
 * Renderiza la interfaz visual de la cola con tiempos estimados y estados detallados
 */
function renderDownloadQueue() {
    const panel = $('downloadQueuePanel');
    const badge = $('queueCountBadge');
    const container = $('queueListContainer');
    if (!panel || !badge || !container) return;

    const pendingItems = downloadQueue.filter(q => q.status === 'pending');
    const processingItem = downloadQueue.find(q => q.status === 'processing');
    const pendingCount = pendingItems.length + (processingItem ? 1 : 0);
    badge.textContent = pendingCount;

    // Actualizar métricas de tiempo estimado en la barra superior
    const avgSec = getAverageUploadDuration();
    const totalRemainingSec = pendingCount * avgSec;
    const avgEl = $('queueAvgTimeText');
    const remEl = $('queueEstimatedRemainingText');
    if (avgEl) avgEl.textContent = `Promedio: ~${avgSec}s`;
    if (remEl) remEl.textContent = `Restante: ${formatTimeRemaining(totalRemainingSec)} (${pendingCount})`;

    container.innerHTML = '';
    if (downloadQueue.length === 0) {
        return;
    }

    let pendingIndex = 0;
    downloadQueue.forEach(item => {
        const row = document.createElement('div');
        row.className = `queue-item ${item.status}`;

        const thumb = document.createElement('img');
        thumb.className = 'queue-item-thumb';
        thumb.src = item.thumbnail;
        thumb.alt = item.title;

        const info = document.createElement('div');
        info.className = 'queue-item-info';

        const titleRow = document.createElement('div');
        titleRow.style.display = 'flex';
        titleRow.style.alignItems = 'center';
        titleRow.style.overflow = 'hidden';

        if (item.status === 'pending') {
            pendingIndex++;
            const posBadge = document.createElement('span');
            posBadge.className = 'queue-item-pos-badge';
            posBadge.textContent = `#${pendingIndex}`;
            titleRow.appendChild(posBadge);
        }

        const title = document.createElement('div');
        title.className = 'queue-item-title';
        title.textContent = item.title;
        title.title = item.title;
        titleRow.appendChild(title);

        const status = document.createElement('div');
        status.className = 'queue-item-status';

        if (item.status === 'pending') {
            const itemWaitEst = pendingIndex * avgSec;
            status.innerHTML = `⏳ En espera <span class="queue-item-estimate">~${formatTimeRemaining(itemWaitEst)}</span>`;
        } else if (item.status === 'processing') {
            status.innerHTML = '🔄 Convirtiendo y subiendo...';
            const progressWrap = document.createElement('div');
            progressWrap.className = 'queue-progress-bar-wrap';
            progressWrap.innerHTML = '<div class="queue-progress-bar-fill"></div>';
            status.appendChild(progressWrap);
        } else if (item.status === 'completed') {
            status.innerHTML = `✔ Completada ${item.elapsedSec ? `(${item.elapsedSec}s)` : ''}`;
        } else if (item.status === 'error') {
            status.innerHTML = `❌ Error: ${item.errorMsg || 'Falló'}`;
            status.title = item.errorMsg || '';
        }

        info.appendChild(titleRow);
        info.appendChild(status);

        row.appendChild(thumb);
        row.appendChild(info);

        // Botón de eliminar para items pendientes o con error
        if (item.status !== 'processing') {
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'queue-item-remove';
            removeBtn.innerHTML = '✕';
            removeBtn.title = 'Quitar de la cola';
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                removeFromDownloadQueue(item.id);
            };
            row.appendChild(removeBtn);
        }

        container.appendChild(row);
    });
}

/**
 * Procesa la cola de descarga secuencialmente: SUBE UNA CANCIÓN A LA VEZ
 * con cálculo de tiempo real y sondeo anti-504 para garantizar que nunca se trabe.
 */
async function processDownloadQueue() {
    if (isQueueProcessing) return;

    const nextItem = downloadQueue.find(q => q.status === 'pending');
    if (!nextItem) {
        isQueueProcessing = false;
        renderDownloadQueue();
        return;
    }

    isQueueProcessing = true;
    nextItem.status = 'processing';
    renderDownloadQueue();

    const startTimeMs = Date.now();
    const startTimeIso = new Date(startTimeMs - 2000).toISOString();
    logEvent(`[Cola] Iniciando descarga de: "${nextItem.title}"`, 'info');

    try {
        const sessionRes = await supabaseClient.auth.getSession();
        const token = sessionRes.data?.session?.access_token || currentAccessToken;

        if (!token || !currentUserId) {
            throw new Error('Sesión no disponible. Inicia sesión nuevamente.');
        }

        let uploadSucceeded = false;
        try {
            await safeFetchJson('/api/convert-and-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: nextItem.url,
                    album: nextItem.album || null,
                    customTitle: nextItem.cleanTitle || nextItem.title,
                    accessToken: token,
                    userId: currentUserId
                })
            }, 180000);
            uploadSucceeded = true;
        } catch (fetchErr) {
            // Si el proxy cortó con 504 o timeout, verificar en Supabase si el servidor completó la subida
            if (fetchErr.message && (fetchErr.message.includes('504') || fetchErr.message.includes('tiempo'))) {
                logEvent(`[Cola] ⏳ El proxy dio 504 en "${nextItem.title}", verificando en perfil si terminó de subir...`, 'warn');
                const polledTrack = await pollForTrackAfterTimeout(nextItem.cleanTitle || nextItem.title, startTimeIso, 90);
                if (polledTrack) {
                    uploadSucceeded = true;
                } else {
                    throw fetchErr;
                }
            } else {
                throw fetchErr;
            }
        }

        if (uploadSucceeded) {
            const elapsedSec = Math.max(Math.round((Date.now() - startTimeMs) / 1000), 5);
            nextItem.status = 'completed';
            nextItem.elapsedSec = elapsedSec;
            uploadDurationsHistory.push(elapsedSec);
            if (uploadDurationsHistory.length > 10) uploadDurationsHistory.shift();

            logEvent(`✔ [Cola] "${nextItem.title}" completada con éxito en ${elapsedSec}s.`, 'success');
            await loadAlbumsDataList();
            await loadUploadedTracks();
        }

    } catch (err) {
        nextItem.status = 'error';
        nextItem.errorMsg = err.message || 'Error en conversión';
        logEvent(`✘ [Cola] Error en "${nextItem.title}": ${err.message}`, 'error');
    } finally {
        isQueueProcessing = false;
        renderDownloadQueue();

        // Pausa de cortesía de 600ms antes de procesar la siguiente canción de la cola
        setTimeout(() => {
            processDownloadQueue();
        }, 600);
    }
}

// Vinculación de controles de la cola
if ($('btnClearCompletedQueue')) {
    $('btnClearCompletedQueue').onclick = clearCompletedDownloadQueue;
}
if ($('btnToggleQueueMinimize')) {
    $('btnToggleQueueMinimize').onclick = toggleQueueMinimize;
}
if ($('queueHeader')) {
    $('queueHeader').onclick = (e) => {
        if (!e.target.closest('.btn-queue-action')) {
            toggleQueueMinimize();
        }
    };
}

// ══════════════════════════════════════════════════════════════════════
// 4. BUSCADOR EXTENDIDO DE YOUTUBE (HASTA 40 RESULTADOS CON PRE-ESCUCHA)
// ══════════════════════════════════════════════════════════════════════


/**
 * Extrae la banda/artista y limpia el título de la canción eliminando
 * etiquetas parasitarias de YouTube (Official Video, Lyrics, 4K, Remastered),
 * pero preservando el nombre completo del video como "Banda - Canción". [v1.9.2]
 */
function extractArtistAndTrackTitle(rawTitle, uploader = '') {
    if (!rawTitle) return { fullCleanTitle: 'Canción', artist: '', songName: 'Canción' };

    let cleaned = rawTitle
        // Remover etiquetas de video/audio oficial, lyrics, remaster, etc.
        .replace(/\s*[\(\[]\s*(?:official\s*(?:music\s*)?video|video\s*oficial|audio\s*oficial|official\s*audio|official\s*visualizer|visualizer|lyrics?|letra|remaster(?:ed)?|hd|4k|live|en\s*vivo|clip\s*officiel|video\s*clip)[^\)\]]*[\)\]]/gi, '')
        // Remover sufijos sueltos tipo "| Official Video" o "- Official Audio"
        .replace(/\s*[|\-]\s*(?:official\s*video|official\s*audio|video\s*oficial|audio\s*oficial|lyrics?|letra)\s*$/gi, '')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    let artist = '';
    let songName = cleaned;

    if (cleaned.includes(' - ')) {
        const parts = cleaned.split(' - ');
        artist = parts[0].trim();
        songName = parts.slice(1).join(' - ').trim();
    } else if (uploader) {
        let cleanUploader = uploader
            .replace(/\s*-\s*Topic$/i, '')
            .replace(/VEVO$/i, '')
            .replace(/\s*Official(?:\s*Channel)?$/i, '')
            .trim();
        artist = cleanUploader;
    }

    return {
        fullCleanTitle: cleaned || rawTitle,
        artist: artist || '',
        songName: songName || cleaned
    };
}

/**
 * Muestra el PANEL LATERAL inamovible en el DOM para confirmar álbum/banda.
 * El panel #albumPromptSidePanel está siempre en el DOM junto a #searchResultsGrid.
 * Reemplaza el antiguo modal flotante que se cerraba solo. [v1.9.4]
 * v1.9.5: Ahora carga y muestra los álbumes existentes del usuario en un select.
 *
 * @param {string} suggestedArtist - Nombre de banda/artista detectado automáticamente
 * @param {string} [songTitle]     - Título de la canción (para mostrar en el panel)
 * @returns {Promise<string|null>}  Nombre del álbum, null = sin álbum, '__CANCELLED__' = cancelado
 */
async function promptAlbumConfirmation(suggestedArtist, songTitle = '') {
    const panel      = $('albumPromptSidePanel');
    const artistText = $('promptArtistNameText');
    const songText   = $('promptSongNameText');
    const albumInput = $('promptAlbumInput');
    const btnConfirm = $('btnPromptConfirmAlbum');
    const btnNoAlbum = $('btnPromptNoAlbum');
    const btnClose   = $('btnCloseAlbumSidePanel');

    // Si el panel no existe (DOM no cargado) o no hay artista sugerido, resuelve inmediatamente
    if (!panel || !suggestedArtist) {
        return $('albumInput')?.value?.trim() || null;
    }

    // Llenar información en el panel
    if (artistText) artistText.textContent = suggestedArtist;
    if (songText)   songText.textContent   = songTitle || '';
    if (albumInput) albumInput.value        = suggestedArtist;

    // Cargar álbumes existentes en el select del panel lateral [v1.9.5]
    const existingSelect = $('promptExistingAlbumSelect');
    if (existingSelect) {
        existingSelect.innerHTML = '<option value="">── Nuevo álbum ──</option>';
        try {
            const { data: albumRows } = await supabaseClient
                .from('music_tracks')
                .select('album')
                .eq('user_id', currentUserId)
                .not('album', 'is', null);

            const uniqueAlbums = [...new Set((albumRows || []).map(r => r.album))].sort();

            uniqueAlbums.forEach(alb => {
                const opt = document.createElement('option');
                opt.value = alb;
                opt.textContent = alb;
                // Pre-seleccionar si coincide con el artista sugerido
                if (alb.toLowerCase() === suggestedArtist.toLowerCase()) opt.selected = true;
                existingSelect.appendChild(opt);
            });

            // Si encontramos coincidencia exacta, actualizar el input también
            if (existingSelect.value) albumInput.value = existingSelect.value;

        } catch (e) {
            console.warn('No se pudieron cargar álbumes existentes:', e);
        }

        // Sincronizar select → input al elegir un álbum existente
        existingSelect.onchange = () => {
            if (existingSelect.value) {
                albumInput.value = existingSelect.value;
            } else {
                // "Nuevo álbum" seleccionado: restaurar el sugerido
                albumInput.value = suggestedArtist;
            }
        };
    }

    // Mostrar el panel (position: fixed) [v1.9.4b]
    panel.classList.remove('hide');

    // Esperar la decisión del usuario mediante una Promesa
    return new Promise((resolve) => {
        let isResolved = false;

        // Limpieza y resolución de la promesa
        const cleanUp = (val) => {
            if (isResolved) return;
            isResolved = true;

            // Ocultar panel
            panel.classList.add('hide');

            // Desconectar listeners para evitar fugas de memoria
            if (btnConfirm) btnConfirm.onclick = null;
            if (btnNoAlbum) btnNoAlbum.onclick = null;
            if (btnClose)   btnClose.onclick   = null;
            const sel = $('promptExistingAlbumSelect');
            if (sel) sel.onchange = null;
            window.removeEventListener('keydown', onEscKey);

            resolve(val);
        };

        // Cerrar con Escape (cancela sin agregar a cola)
        const onEscKey = (e) => {
            if (e.key === 'Escape') cleanUp('__CANCELLED__');
        };
        window.addEventListener('keydown', onEscKey);

        // Botón: Confirmar álbum
        if (btnConfirm) {
            btnConfirm.onclick = () => {
                const finalAlbum = albumInput?.value?.trim() || suggestedArtist;
                cleanUp(finalAlbum);
            };
        }

        // Botón: Sin categoría
        if (btnNoAlbum) {
            btnNoAlbum.onclick = () => {
                cleanUp(null);
            };
        }

        // Botón ✕: Cerrar panel (cancela sin agregar a cola)
        if (btnClose) {
            btnClose.onclick = () => {
                cleanUp('__CANCELLED__');
            };
        }
    });
}

async function searchYouTube() {
    closeSimilarityNotification(); // [v1.9.2] Auto-cerrar duplicados al buscar
    const query = $('ytSearchInput').value.trim();
    if (!query) return;

    const limit = parseInt($('ytSearchLimitSelect').value, 10) || 25;
    const btn = $('btnYtSearch');
    const resultsGrid = $('searchResultsGrid');
    const controlsBar = $('searchControlsBar');

    try {
        btn.disabled = true;
        btn.textContent = 'Buscando...';
        resultsGrid.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Buscando canciones en YouTube...</div>';
        resultsGrid.classList.remove('hide');
        controlsBar.classList.add('hide');

        const data = await safeFetchJson('/api/youtube-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, limit })
        });

        if (!data.results || data.results.length === 0) {
            resultsGrid.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No se encontraron resultados para tu búsqueda.</div>';
            return;
        }

        controlsBar.classList.remove('hide');
        $('searchResultsCountText').textContent = `${data.results.length} canciones encontradas para "${query}":`;

        resultsGrid.innerHTML = '';
        data.results.forEach(item => {
            const row = document.createElement('div');
            row.className = 'search-item';
            row.dataset.videoId = item.id;
            row.id = `yt-track-${item.id}`;

            // Extraer banda y título limpio completo ("Banda - Canción") [v1.9.2]
            const parsed = extractArtistAndTrackTitle(item.title, item.uploader);
            const fullTitleClean = parsed.fullCleanTitle;
            const detectedBand = parsed.artist;

            const img = document.createElement('img');
            img.className = 'search-thumb';
            img.src = item.thumbnail;
            img.alt = fullTitleClean;

            const info = document.createElement('div');
            info.className = 'search-info';

            const title = document.createElement('div');
            title.className = 'search-title';
            title.textContent = fullTitleClean;
            title.title = fullTitleClean;

            const channel = document.createElement('div');
            channel.className = 'search-channel';
            channel.textContent = `${item.uploader} • ${item.durationString}`;

            info.appendChild(title);
            info.appendChild(channel);

            const actions = document.createElement('div');
            actions.className = 'search-actions';

            // 1. Botón de Pre-escucha
            const listenBtn = document.createElement('button');
            listenBtn.type = 'button';
            listenBtn.className = 'search-btn-listen';
            listenBtn.textContent = (currentPlayingVideoId === item.id) ? '🔊 Sonando' : '▶ Probar';
            listenBtn.title = 'Escuchar vista previa antes de convertir';
            listenBtn.onclick = () => {
                closeSimilarityNotification();
                if (currentPlayingVideoId === item.id) {
                    closePreview();
                } else {
                    playPreview(item.id, fullTitleClean);
                }
            };

            // 2. Botón Elegir: asigna título y álbum y cierra duplicados anteriores [v1.9.2]
            const selectBtn = document.createElement('button');
            selectBtn.type = 'button';
            selectBtn.className = 'search-btn-select';
            selectBtn.textContent = '✔ Elegir';
            selectBtn.title = 'Seleccionar para ajustar nombre o álbum';
            selectBtn.onclick = () => {
                closeSimilarityNotification(); // Cierra duplicados anteriores
                currentLoadedVideoId = item.id;
                $('youtubeUrlInput').value = item.url;
                $('customTitleInput').value = fullTitleClean;
                if (detectedBand) {
                    $('albumInput').value = detectedBand;
                }

                $('videoPreviewBox').classList.remove('hide');
                $('videoThumbImg').src = item.thumbnail;
                $('videoMetaTitle').textContent = fullTitleClean;
                $('videoMetaDetails').textContent = `${item.uploader} • Duración: ${item.durationString}`;

                logEvent(`Seleccionado: "${fullTitleClean}" (Banda detectada: ${detectedBand || 'Ninguna'})`, 'info');

                // Validación proactiva de duplicados al seleccionar [v1.9.6]
                const match = findSimilarTrack(fullTitleClean);
                if (match) {
                    logEvent(`⚠️ Canción similar ya registrada en tu perfil: "${match.track.display_name}"`, 'warn');
                    showSimilarityInlineCard(fullTitleClean, $('albumInput')?.value?.trim() || detectedBand, match.track, (finalTitle) => {
                        $('customTitleInput').value = finalTitle;
                    });
                }

                $('trackConfigSection').scrollIntoView({ behavior: 'smooth' });
                updatePlayingPreviewHighlight();
            };

            // 3. Botón Añadir a la Cola: valida duplicados, confirma álbum/banda y encola [v1.9.6]
            const queueBtn = document.createElement('button');
            queueBtn.type = 'button';
            queueBtn.className = 'search-btn-queue';
            queueBtn.innerHTML = '+ Cola';
            queueBtn.title = 'Añadir a la cola de descargas';
            queueBtn.onclick = async () => {
                await processTrackSelection({ item, fullTitleClean, detectedBand });
            };

            // 4. Botón Convertir: valida duplicados, confirma álbum y encola directamente [v1.9.6]
            const convertDirectBtn = document.createElement('button');
            convertDirectBtn.type = 'button';
            convertDirectBtn.className = 'search-btn-select';
            convertDirectBtn.style.background = '#10b981';
            convertDirectBtn.style.color = '#fff';
            convertDirectBtn.innerHTML = '⚡ Convertir';
            convertDirectBtn.title = 'Convertir y subir a tu perfil';
            convertDirectBtn.onclick = async () => {
                await processTrackSelection({ item, fullTitleClean, detectedBand });
            };

            actions.appendChild(listenBtn);
            actions.appendChild(selectBtn);
            actions.appendChild(queueBtn);
            actions.appendChild(convertDirectBtn);

            row.appendChild(img);
            row.appendChild(info);
            row.appendChild(actions);
            resultsGrid.appendChild(row);
        });

        // Aplicar estado de reproducción actual si alguna pista ya sonaba
        updatePlayingPreviewHighlight();

    } catch (err) {
        resultsGrid.innerHTML = `<div style="color: var(--danger); padding: 0.8rem; font-size: 0.88rem;">${err.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Buscar';
    }
}

$('btnYtSearch').onclick = searchYouTube;
$('youtubeUrlInput').addEventListener('input', () => closeSimilarityNotification());
$('ytSearchInput').addEventListener('input', () => closeSimilarityNotification());

$('ytSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchYouTube();
});

// Botón de preescucha en la tarjeta de previsualización
$('btnPreviewCurrentVideo').onclick = () => {
    if (currentLoadedVideoId) {
        playPreview(currentLoadedVideoId, $('videoMetaTitle').textContent);
    }
};

// ══════════════════════════════════════════════════════════════════════
// 5. ANÁLISIS DE ENLACES INDIVIDUALES Y PLAYLISTS
// ══════════════════════════════════════════════════════════════════════

let currentPlaylistData = null;

async function analyzeUrl() {
    closeSimilarityNotification(); // [v1.9.2] Cierra duplicados
    const url = $('youtubeUrlInput').value.trim();
    if (!url) {
        logEvent('Ingresa un enlace de YouTube.', 'warn');
        return;
    }

    const btn = $('btnFetchInfo');
    try {
        btn.disabled = true;
        btn.textContent = 'Analizando...';
        logEvent(`Analizando enlace: ${url}`, 'info');

        if (url.includes('list=')) {
            const plData = await safeFetchJson('/api/playlist-info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });

            if (plData.isPlaylist) {
                currentPlaylistData = plData;
                showPlaylistView(plData);
                return;
            }
        }

        const data = await safeFetchJson('/api/video-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        currentLoadedVideoId = data.id;
        $('playlistBox').classList.add('hide');
        $('videoPreviewBox').classList.remove('hide');
        $('videoThumbImg').src = data.thumbnail || '';
        $('videoMetaTitle').textContent = data.title;
        $('videoMetaDetails').textContent = `${data.uploader || 'YouTube'} • Duración: ${data.durationString}`;

        if (!$('customTitleInput').value.trim()) {
            $('customTitleInput').value = data.cleanTitle || data.title;
        }

        logEvent(`Video analizado: "${data.title}" (${data.durationString})`, 'success');

    } catch (err) {
        logEvent(err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🔍</span> Analizar';
    }
}

$('btnFetchInfo').onclick = analyzeUrl;

function showPlaylistView(plData) {
    $('videoPreviewBox').classList.add('hide');
    const box = $('playlistBox');
    box.classList.remove('hide');

    $('playlistTitleText').textContent = `Playlist: ${plData.playlistTitle}`;
    $('playlistSubtitleText').textContent = `${plData.trackCount} canciones detectadas`;

    if (!$('albumInput').value.trim()) {
        $('albumInput').value = plData.playlistTitle;
    }

    const list = $('playlistTracksList');
    list.innerHTML = '';

    plData.tracks.forEach((track, i) => {
        const row = document.createElement('div');
        row.className = 'playlist-track-row';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.trackIndex = i;

        const title = document.createElement('span');
        title.style.flex = '1';
        title.style.whiteSpace = 'nowrap';
        title.style.overflow = 'hidden';
        title.style.textOverflow = 'ellipsis';
        title.textContent = `${track.index}. ${track.title} (${track.durationString})`;

        row.appendChild(cb);
        row.appendChild(title);
        list.appendChild(row);
    });

    logEvent(`Playlist detectada: "${plData.playlistTitle}" (${plData.trackCount} pistas).`, 'success');
}

$('btnSelectAllPlaylist').onclick = () => {
    const cbs = document.querySelectorAll('#playlistTracksList input[type="checkbox"]');
    const someUnchecked = Array.from(cbs).some(c => !c.checked);
    cbs.forEach(c => c.checked = someUnchecked);
    $('btnSelectAllPlaylist').textContent = someUnchecked ? 'Desmarcar Todas' : 'Marcar Todas';
};

// ══════════════════════════════════════════════════════════════════════
// 6. DETECCIÓN Y COMPARACIÓN DE NOMBRES SIMILARES
// ══════════════════════════════════════════════════════════════════════

function normalizeTitle(str) {
    if (!str) return '';
    return str
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\b(128k|192k|256k|320k|kbps|official|video|audio|lyrics|letra|remastered|hd|4k)\b/gi, '')
        .replace(/[()[\]{}_+\-=|\\/:*?"<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractTrackNameOnly(str) {
    if (!str) return '';
    const parts = str.split(/\s*[-–—:]\s*/);
    if (parts.length >= 2) {
        return parts.slice(1).join(' ').trim();
    }
    return str.trim();
}

function calculateSimilarity(a, b) {
    const normA = normalizeTitle(a);
    const normB = normalizeTitle(b);

    if (normA === normB) return 1.0;
    if (!normA || !normB) return 0.0;

    // 1. Si una está contenida en la otra y tiene longitud significativa (>= 5 caracteres) [v1.9.6]
    if (normA.includes(normB) || normB.includes(normA)) {
        const shorter = Math.min(normA.length, normB.length);
        const longer = Math.max(normA.length, normB.length);
        if (shorter >= 5) {
            return 0.88 + 0.12 * (shorter / longer);
        }
    }

    // 2. Comparar también aislando solo el nombre de la pista (sin banda) [v1.9.6]
    const trackA = normalizeTitle(extractTrackNameOnly(a));
    const trackB = normalizeTitle(extractTrackNameOnly(b));
    if (trackA && trackB && (trackA === trackB || trackA.includes(trackB) || trackB.includes(trackA))) {
        const shorter = Math.min(trackA.length, trackB.length);
        if (shorter >= 4) return 0.90;
    }

    // 3. Similitud por Bigramas Dice-Sorensen
    const getBigrams = s => {
        const set = new Set();
        for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
        return set;
    };
    const bA = getBigrams(normA);
    const bB = getBigrams(normB);
    let common = 0;
    for (const bg of bA) if (bB.has(bg)) common++;
    const total = bA.size + bB.size;
    return total > 0 ? (2.0 * common) / total : 0.0;
}

function findSimilarTrack(candidateTitle) {
    const normCandidate = normalizeTitle(candidateTitle);
    if (!normCandidate || bypassedSimilarityTitles.has(normCandidate)) {
        return null;
    }

    let bestMatch = null;
    let highestScore = 0;

    for (const track of myTracksCache) {
        const score = calculateSimilarity(candidateTitle, track.display_name);
        if (score > highestScore && score >= 0.72) {
            highestScore = score;
            bestMatch = track;
        }
    }
    return bestMatch ? { track: bestMatch, score: highestScore } : null;
}

let modalOpenedAt = 0;

function closeSimilarityNotification() {
    closeAlbumPrompt(); // [v1.9.3] Cierra cualquier modal de álbum pendiente
    const card = $('similarityInlineCard');
    if (card) {
        card.classList.add('hide');
        const audios = card.querySelectorAll('audio');
        audios.forEach(a => {
            try { a.pause(); a.currentTime = 0; } catch (e) {}
        });
        $('inlineAudioCompareWrap').innerHTML = '';
        $('inlineRenameSection').classList.add('hide');
        $('btnInlineRename').textContent = 'Cambiar Nombre';
        $('inlineCompareTable').classList.remove('hide');
        $('inlineActionsRow').classList.remove('hide');
        $('inlineLoadingState').classList.add('hide');
    }
    const modal = $('similarityModal');
    if (modal) modal.classList.add('hide');
}

function showSimilarityInlineCard(newTitle, newAlbum, existingTrack, onConfirm) {
    closeSimilarityNotification();

    const card = $('similarityInlineCard');
    if (!card) return;

    // Reposicionamiento visible en el DOM [v1.9.6]
    // Si la cuadrícula de búsqueda está activa, mover la tarjeta arriba de los resultados
    const searchGrid = $('searchResultsGrid');
    if (searchGrid && !searchGrid.classList.contains('hide')) {
        searchGrid.parentNode.insertBefore(card, searchGrid);
    } else {
        const trackSec = $('trackConfigSection');
        if (trackSec) {
            const convertBtnWrap = $('btnConvertAndUpload')?.parentElement;
            if (convertBtnWrap) {
                trackSec.insertBefore(card, convertBtnWrap);
            }
        }
    }

    $('inlineNewTitle').textContent = newTitle;
    $('inlineNewAlbum').textContent = newAlbum || 'Sin álbum';

    $('inlineExistingTitle').textContent = existingTrack.display_name;
    $('inlineExistingAlbum').textContent = existingTrack.album || 'Sin álbum';

    $('inlineRenameInput').value = newTitle;
    $('inlineRenameSection').classList.add('hide');
    $('btnInlineRename').textContent = 'Cambiar Nombre';

    const compareTable = $('inlineCompareTable');
    if (compareTable) compareTable.classList.remove('hide');
    const actionsRow = $('inlineActionsRow');
    if (actionsRow) actionsRow.classList.remove('hide');
    const loadingState = $('inlineLoadingState');
    if (loadingState) loadingState.classList.add('hide');

    // Botón para reproducir la canción que ya existe
    const audioWrap = $('inlineAudioCompareWrap');
    audioWrap.innerHTML = '';
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'btn-secondary';
    playBtn.style.padding = '4px 10px';
    playBtn.style.fontSize = '0.8rem';
    playBtn.textContent = '▶ Escuchar la que ya tienes';

    playBtn.onclick = async (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        try {
            playBtn.disabled = true;
            playBtn.textContent = 'Cargando audio...';
            const signedUrl = await getR2SignedUrl(existingTrack.file_name);
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.src = signedUrl;
            audio.autoplay = true;
            audioWrap.innerHTML = '';
            audioWrap.appendChild(audio);
        } catch (err) {
            alert('Error al reproducir canción existente: ' + err.message);
            playBtn.disabled = false;
            playBtn.textContent = '▶ Escuchar la que ya tienes';
        }
    };
    audioWrap.appendChild(playBtn);

    card.classList.remove('hide');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const triggerUpload = async (titleToUpload) => {
        if (compareTable) compareTable.classList.add('hide');
        if (actionsRow) actionsRow.classList.add('hide');
        if (loadingState) loadingState.classList.remove('hide');
        $('inlineLoadingText').textContent = 'Descargando audio de YouTube y transcodificando a MP3...';

        try {
            await onConfirm(titleToUpload);
            closeSimilarityNotification();
        } catch (uploadErr) {
            if (actionsRow) actionsRow.classList.remove('hide');
            const is500Mb = uploadErr.message && uploadErr.message.includes('500 MB');
            if (is500Mb) {
                $('inlineLoadingText').innerHTML = `
                    <div style="color: #f87171; font-weight: 700; font-size: 0.95rem; margin-bottom: 4px;">
                        ⚠️ Límite de 500 MB alcanzado en tu cuenta de Cloudflare
                    </div>
                    <div style="color: #cbd5e1; font-size: 0.82rem; line-height: 1.4;">
                        Elimina canciones viejas o repetidas de tu lista de abajo con el botón 🗑️ para liberar espacio y vuelve a presionar "Reintentar Subida".
                    </div>
                `;
            } else {
                $('inlineLoadingText').innerHTML = `<span style="color: var(--danger)">✘ ${uploadErr.message}</span>`;
            }
            $('btnInlineUploadAnyway').textContent = 'Reintentar Subida';
        }
    };

    // Botón Subir de todos modos
    $('btnInlineUploadAnyway').onclick = async (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        bypassedSimilarityTitles.add(normalizeTitle(newTitle));
        await triggerUpload(newTitle);
    };

    // Botón Cambiar Nombre
    $('btnInlineRename').onclick = async (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        const renameSec = $('inlineRenameSection');
        if (renameSec.classList.contains('hide')) {
            renameSec.classList.remove('hide');
            $('btnInlineRename').textContent = 'Guardar y Subir';
            $('inlineRenameInput').focus();
            $('inlineRenameInput').select();
        } else {
            const updated = $('inlineRenameInput').value.trim() || newTitle;
            $('customTitleInput').value = updated;
            bypassedSimilarityTitles.add(normalizeTitle(updated));
            await triggerUpload(updated);
        }
    };

    // Botón Cancelar
    $('btnInlineCancel').onclick = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        closeSimilarityNotification();
        logEvent('Subida cancelada por el usuario tras verificar duplicado.', 'warn');
        resetConvertButtonState();
    };

    // Botón Cruz ✕
    $('btnInlineClose').onclick = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        closeSimilarityNotification();
        resetConvertButtonState();
    };
}

// ══════════════════════════════════════════════════════════════════════
// 7. PIPELINE DE CONVERSIÓN Y SUBIDA (INDIVIDUAL O PLAYLIST)
// ══════════════════════════════════════════════════════════════════════


/**
 * Sondeo automático ante corte de proxy o timeout (504 Gateway Timeout):
 * Verifica si la canción termina de procesarse en segundo plano en Supabase y actualiza la lista.
 */
async function pollForBackgroundUpload(customTitle, startTimeIso, maxWaitSeconds = 90) {
    const cleanExpected = (customTitle || '').trim().toLowerCase();
    const intervalMs = 4000;
    const maxAttempts = Math.ceil((maxWaitSeconds * 1000) / intervalMs);

    logEvent('⏳ El proxy cortó la respuesta (504 Timeout), pero el servidor en Render sigue convirtiendo y subiendo tu canción...', 'warn');
    logEvent('🔍 Verificando automáticamente en tu perfil si la pista termina de procesarse...', 'info');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, intervalMs));
        const btn = $('btnConvertAndUpload');
        if (btn) {
            $('convertBtnText').textContent = `Esperando al servidor... (${attempt * 4}s)`;
        }

        try {
            const { data: newTracks, error } = await supabaseClient
                .from('music_tracks')
                .select('*')
                .eq('user_id', currentUserId)
                .is('deleted_at', null)
                .gte('created_at', startTimeIso)
                .order('created_at', { ascending: false });

            if (!error && Array.isArray(newTracks) && newTracks.length > 0) {
                const match = newTracks.find(t => 
                    (t.display_name && t.display_name.trim().toLowerCase() === cleanExpected) ||
                    (cleanExpected && t.display_name && t.display_name.trim().toLowerCase().includes(cleanExpected))
                ) || newTracks[0];

                if (match) {
                    logEvent(`✔ ¡Canción "${match.display_name}" detectada y guardada con éxito en tu perfil!`, 'success');
                    $('youtubeUrlInput').value = '';
                    $('customTitleInput').value = '';
                    $('videoPreviewBox').classList.add('hide');
                    currentLoadedVideoId = null;

                    await loadAlbumsDataList();
                    await loadUploadedTracks();
                    return { success: true, message: `Pista "${match.display_name}" subida exitosamente.` };
                }
            }
        } catch (pollErr) {
            // Silencioso para continuar intentando
        }
    }

    // Si terminó el tiempo de espera, refrescamos la lista de todos modos
    await loadUploadedTracks();
    throw new Error('El proceso tardó más de 90 segundos. Se actualizó la lista por si la canción terminó de guardarse.');
}

async function executeUpload(url, customTitle, album) {
    const btn = $('btnConvertAndUpload');

    try {
        if (!url) {
            logEvent('Ingresa un enlace de YouTube o selecciona una canción del buscador.', 'warn');
            resetConvertButtonState();
            return;
        }

        const sessionRes = await supabaseClient.auth.getSession();
        const token = sessionRes.data?.session?.access_token || currentAccessToken;

        if (!token || !currentUserId) {
            logEvent('Tu sesión ha expirado o no es válida. Inicia sesión de nuevo.', 'error');
            $('lockOverlay').style.display = 'flex';
            $('appCard').classList.add('hide');
            showLockError('Tu sesión ha expirado. Por favor ingresa tus datos.');
            resetConvertButtonState();
            throw new Error('Sesión expirada.');
        }

        btn.disabled = true;
        $('convertBtnIcon').textContent = '⏳';
        $('convertBtnText').textContent = 'Descargando y convirtiendo a MP3...';
        $('btnResetConvertState').classList.remove('hide');

        const consoleBox = $('consoleBox');
        consoleBox.classList.remove('hide');
        consoleBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        logEvent(`Iniciando procesamiento de "${customTitle}"...`, 'info');
        logEvent(`Descargando audio de YouTube y transcodificando a MP3 de alta fidelidad...`, 'info');

        const startTimeIso = new Date(Date.now() - 15000).toISOString();

        let result = null;
        try {
            result = await safeFetchJson('/api/convert-and-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url,
                    album: album || null,
                    customTitle,
                    accessToken: token,
                    userId: currentUserId
                })
            }, 180000);

            logEvent(`✔ ${result.message}`, 'success');

            $('youtubeUrlInput').value = '';
            $('customTitleInput').value = '';
            $('videoPreviewBox').classList.add('hide');
            currentLoadedVideoId = null;

            await loadAlbumsDataList();
            await loadUploadedTracks();

            return result;

        } catch (fetchErr) {
            const msg = fetchErr.message || '';
            const isTimeoutOrProxy = msg.includes('504') || 
                                     msg.includes('tardó demasiado') || 
                                     msg.includes('No se pudo comunicar') || 
                                     msg.includes('AbortError') ||
                                     msg.includes('Failed to fetch') ||
                                     msg.includes('NetworkError');

            if (isTimeoutOrProxy) {
                return await pollForBackgroundUpload(customTitle, startTimeIso, 90);
            } else {
                throw fetchErr;
            }
        }

    } catch (err) {
        logEvent(`✘ Error en el proceso: ${err.message}`, 'error');
        if (err.message && (err.message.includes('429') || err.message.includes('bot') || err.message.includes('YOUTUBE_COOKIES') || err.message.includes('Sign in'))) {
            logEvent(`💡 Tip para Render: Agrega la variable de entorno YOUTUBE_COOKIES en tu panel de Render con tus cookies de YouTube (exportadas con "Get cookies.txt LOCALLY").`, 'warn');
        }
        throw err;
    } finally {
        resetConvertButtonState();
    }
}

async function processPlaylistUpload(plData, album) {
    const cbs = document.querySelectorAll('#playlistTracksList input[type="checkbox"]:checked');
    const selectedTracks = Array.from(cbs).map(cb => plData.tracks[parseInt(cb.dataset.trackIndex, 10)]);

    if (selectedTracks.length === 0) {
        logEvent('Selecciona al menos una canción de la lista.', 'warn');
        return;
    }

    logEvent(`Encolando ${selectedTracks.length} canciones de la playlist "${plData.playlistTitle}"...`, 'info');
    selectedTracks.forEach(t => {
        addToDownloadQueue({
            url: t.url,
            title: t.title,
            cleanTitle: t.cleanTitle || t.title,
            album: album || plData.playlistTitle || null,
            thumbnail: t.thumbnail,
            durationString: t.durationString
        });
    });

    $('playlistBox').classList.add('hide');
    $('youtubeUrlInput').value = '';
    currentPlaylistData = null;
    showQueuePanel();
}

$('btnResetConvertState').onclick = () => {
    resetConvertButtonState();
    logEvent('Botón de conversión restablecido manualmente.', 'warn');
};

$('btnConvertAndUpload').onclick = async (e) => {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }

    const album = $('albumInput').value.trim() || null;

    if (currentPlaylistData && !$('playlistBox').classList.contains('hide')) {
        await processPlaylistUpload(currentPlaylistData, album);
        return;
    }

    const url = $('youtubeUrlInput').value.trim();
    if (!url) {
        logEvent('Ingresa un enlace de YouTube o selecciona una canción del buscador.', 'warn');
        if ($('tabModeSearch') && $('tabModeSearch').classList.contains('active')) {
            $('ytSearchInput').focus();
        } else {
            $('youtubeUrlInput').focus();
        }
        return;
    }

    let customTitle = $('customTitleInput').value.trim();
    if (!customTitle) {
        customTitle = `YouTube_${Date.now()}`;
        $('customTitleInput').value = customTitle;
    }

    const thumbImg = $('videoThumbImg')?.src || 'https://i.ytimg.com/vi/hqdefault.jpg';

    const triggerAddToQueue = (finalTitle) => {
        addToDownloadQueue({
            url,
            title: finalTitle || customTitle,
            cleanTitle: finalTitle || customTitle,
            album: album || null,
            thumbnail: thumbImg,
            durationString: ''
        });
        $('youtubeUrlInput').value = '';
        $('customTitleInput').value = '';
        $('videoPreviewBox').classList.add('hide');
        currentLoadedVideoId = null;
    };

    const match = findSimilarTrack(customTitle);
    if (match) {
        showSimilarityInlineCard(customTitle, album, match.track, (finalTitle) => {
            triggerAddToQueue(finalTitle);
            return Promise.resolve();
        });
    } else {
        triggerAddToQueue(customTitle);
    }
};

// ══════════════════════════════════════════════════════════════════════
// 8. GESTIÓN Y RENDERIZADO DE ÁLBUMES (IDÉNTICO AL CHAT ORIGINAL)
// ══════════════════════════════════════════════════════════════════════

async function loadAlbumsDataList() {
    try {
        const { data, error } = await supabaseClient
            .from('music_tracks')
            .select('album')
            .eq('user_id', currentUserId)
            .not('album', 'is', null);

        if (error) throw error;
        const set = [...new Set((data || []).map(r => r.album))].sort();
        $('albumDataList').innerHTML = set.map(a => `<option value="${a.replace(/"/g, '&quot;')}">`).join('');
    } catch (e) {
        console.warn('Error al cargar álbumes:', e);
    }
}

async function loadUploadedTracks() {
    const wrap = $('albumsWrapper');
    try {
        const { data: tracks, error } = await supabaseClient
            .from('music_tracks')
            .select('*')
            .eq('user_id', currentUserId)
            .is('deleted_at', null)
            .order('created_at', { ascending: false });

        if (error) throw error;

        myTracksCache = tracks || [];
        renderAlbumsView();

    } catch (err) {
        wrap.innerHTML = `<div style="color: var(--danger); font-size: 0.85rem; padding: 0.5rem;">Error al cargar canciones: ${err.message}</div>`;
    }
}

$('btnRefreshTracks').onclick = loadUploadedTracks;

function renderAlbumsView() {
    const wrap = $('albumsWrapper');
    const filter = ($('filterTracksInput').value || '').trim().toLowerCase();

    const filteredTracks = filter 
        ? myTracksCache.filter(t => (t.display_name || '').toLowerCase().includes(filter))
        : myTracksCache;

    if (filteredTracks.length === 0) {
        wrap.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 1.5rem; font-size: 0.88rem;">
            ${filter ? 'No hay canciones que coincidan con el filtro.' : 'No tienes canciones en tu perfil aún. ¡Convierte un video arriba!'}
        </div>`;
        return;
    }

    const NO_ALBUM_KEY = '__sin_album__';
    const groups = new Map();

    filteredTracks.forEach(track => {
        const key = (track.album && track.album.trim()) ? track.album.trim() : NO_ALBUM_KEY;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(track);
    });

    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
        if (a === NO_ALBUM_KEY) return 1;
        if (b === NO_ALBUM_KEY) return -1;
        return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });

    wrap.innerHTML = '';

    sortedKeys.forEach(albumKey => {
        const groupTracks = groups.get(albumKey);
        const isNoAlbum = albumKey === NO_ALBUM_KEY;
        const isCollapsed = albumExpandState.has(albumKey) ? !albumExpandState.get(albumKey) : !isNoAlbum;

        const groupDiv = document.createElement('div');
        groupDiv.className = 'album-group';

        const header = document.createElement('div');
        header.className = 'album-header';

        const arrow = document.createElement('span');
        arrow.className = 'album-toggle-arrow';
        arrow.textContent = isCollapsed ? '▸' : '▾';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'album-header-title';
        titleSpan.textContent = `${isNoAlbum ? '📁 Sin álbum' : '💿 ' + albumKey} (${groupTracks.length})`;

        header.appendChild(arrow);
        header.appendChild(titleSpan);

        const tracksContainer = document.createElement('div');
        tracksContainer.className = 'album-tracks-container';
        if (isCollapsed) tracksContainer.classList.add('hide');

        header.onclick = () => {
            const currentlyCollapsed = tracksContainer.classList.contains('hide');
            const willBeExpanded = currentlyCollapsed;
            albumExpandState.set(albumKey, willBeExpanded);
            arrow.textContent = willBeExpanded ? '▾' : '▸';
            if (willBeExpanded) {
                tracksContainer.classList.remove('hide');
            } else {
                tracksContainer.classList.add('hide');
            }
        };

        groupTracks.forEach(track => {
            const item = document.createElement('div');
            item.className = 'radio-item';

            const info = document.createElement('div');
            info.className = 'radio-info';

            const title = document.createElement('span');
            title.className = 'radio-title';
            title.textContent = track.display_name;
            title.title = track.display_name;

            info.appendChild(title);

            const actions = document.createElement('div');
            actions.className = 'radio-actions';

            const playBtn = document.createElement('button');
            playBtn.type = 'button';
            playBtn.className = 'btn-secondary';
            playBtn.textContent = '▶ Escuchar';

            playBtn.onclick = async () => {
                try {
                    playBtn.disabled = true;
                    playBtn.textContent = 'Cargando...';
                    const signedUrl = await getR2SignedUrl(track.file_name);

                    const audioEl = document.createElement('audio');
                    audioEl.controls = true;
                    audioEl.src = signedUrl;
                    audioEl.autoplay = true;

                    actions.replaceChild(audioEl, playBtn);
                } catch (audioErr) {
                    alert('Error al reproducir: ' + audioErr.message);
                    playBtn.disabled = false;
                    playBtn.textContent = '▶ Escuchar';
                }
            };

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'btn-delete-track';
            delBtn.textContent = '🗑️';
            delBtn.title = 'Eliminar canción de tu lista';

            delBtn.onclick = async () => {
                const confirmed = confirm(`¿Estás seguro de que deseas eliminar "${track.display_name}" de tu perfil?`);
                if (!confirmed) return;

                try {
                    delBtn.disabled = true;
                    delBtn.textContent = '⏳';

                    const { error } = await supabaseClient
                        .from('music_tracks')
                        .delete()
                        .eq('id', track.id);

                    if (error) {
                        await supabaseClient
                            .from('music_tracks')
                            .update({ deleted_at: new Date().toISOString() })
                            .eq('id', track.id);
                    }

                    logEvent(`Canción eliminada: "${track.display_name}"`, 'warn');
                    myTracksCache = myTracksCache.filter(t => t.id !== track.id);
                    renderAlbumsView();
                    loadAlbumsDataList();

                } catch (delErr) {
                    alert('No se pudo eliminar la canción: ' + delErr.message);
                    delBtn.disabled = false;
                    delBtn.textContent = '🗑️';
                }
            };

            actions.appendChild(playBtn);
            actions.appendChild(delBtn);

            item.appendChild(info);
            item.appendChild(actions);
            tracksContainer.appendChild(item);
        });

        groupDiv.appendChild(header);
        groupDiv.appendChild(tracksContainer);
        wrap.appendChild(groupDiv);
    });
}

$('btnExpandAllAlbums').onclick = () => {
    myTracksCache.forEach(t => {
        const k = (t.album && t.album.trim()) ? t.album.trim() : '__sin_album__';
        albumExpandState.set(k, true);
    });
    renderAlbumsView();
};

$('btnCollapseAllAlbums').onclick = () => {
    myTracksCache.forEach(t => {
        const k = (t.album && t.album.trim()) ? t.album.trim() : '__sin_album__';
        albumExpandState.set(k, false);
    });
    renderAlbumsView();
};

$('filterTracksInput').addEventListener('input', renderAlbumsView);

// ══════════════════════════════════════════════════════════════════════
// 9. NAVEGACIÓN COMPARTIDA Y SINGLE SIGN-ON (SSO) CON EL CHAT [v1.9.1]
// Permite transferir la sesión activa automáticamente entre
// Conversor YouTube y Supabase Chat sin volver a pedir usuario/contraseña.
// ══════════════════════════════════════════════════════════════════════

const CHAT_APP_BASE_URL = 'https://latamdia4-dwev.github.io/Supabase-Chat/';

/**
 * Abre la aplicación del Chat transfiriendo la sesión de Supabase si está disponible
 */
async function openChatWithSession() {
    try {
        const sessionRes = await supabaseClient.auth.getSession();
        const session = sessionRes.data?.session;

        if (session && session.access_token && session.refresh_token) {
            // Transferencia de sesión segura vía hash de URL (no viaja en cabeceras HTTP de red)
            const targetUrl = `${CHAT_APP_BASE_URL}#access_token=${encodeURIComponent(session.access_token)}&refresh_token=${encodeURIComponent(session.refresh_token)}`;
            window.open(targetUrl, '_blank', 'noopener');
        } else {
            // Si no hay sesión iniciada, abrir el Chat en modo normal
            window.open(CHAT_APP_BASE_URL, '_blank', 'noopener');
        }
    } catch (e) {
        console.warn('Error al preparar enlace al Chat:', e);
        window.open(CHAT_APP_BASE_URL, '_blank', 'noopener');
    }
}

// Botón de navegación al Chat en la barra de usuario
if ($('btnGoToChatWithSession')) {
    $('btnGoToChatWithSession').onclick = openChatWithSession;
}

/**
 * Comprueba al cargar la página si hay una sesión transferida por URL hash
 * o si ya existe una sesión guardada en localStorage por Supabase Auth
 */
async function initSessionAutoLogin() {
    try {
        // 1. Comprobar si viene token transferido desde el Chat en el hash de la URL
        if (window.location.hash && window.location.hash.includes('access_token=')) {
            const hashClean = window.location.hash.startsWith('#') ? window.location.hash.substring(1) : window.location.hash;
            const params = new URLSearchParams(hashClean);
            const accessToken = params.get('access_token');
            const refreshToken = params.get('refresh_token');

            if (accessToken && refreshToken) {
                logEvent('Restaurando sesión transferida desde el Chat...', 'info');
                const { data, error } = await supabaseClient.auth.setSession({
                    access_token: accessToken,
                    refresh_token: refreshToken
                });

                // Limpiar el hash de la barra de direcciones para no dejar tokens en el historial
                history.replaceState(null, '', window.location.pathname + window.location.search);

                if (!error && data.session) {
                    await finalizeAutoLogin(data.session);
                    return;
                }
            }
        }

        // 2. Comprobar si ya existe una sesión previa en Supabase Auth
        const { data: sessionData } = await supabaseClient.auth.getSession();
        if (sessionData && sessionData.session && sessionData.session.user) {
            await finalizeAutoLogin(sessionData.session);
        }
    } catch (autoErr) {
        console.warn('Aviso en auto-login de sesión:', autoErr);
    }
}

async function finalizeAutoLogin(session) {
    currentUserId = session.user.id;
    currentAccessToken = session.access_token;

    // Obtener username de la tabla profiles
    try {
        const { data: profile } = await supabaseClient
            .from('profiles')
            .select('username')
            .eq('id', currentUserId)
            .maybeSingle();

        currentUsername = (profile && profile.username) || session.user.email?.split('@')[0] || 'Usuario';
    } catch (pe) {
        currentUsername = session.user.email?.split('@')[0] || 'Usuario';
    }

    $('currentUsernameText').textContent = currentUsername;
    $('lockOverlay').style.display = 'none';
    $('appCard').classList.remove('hide');

    logEvent(`✔ Sesión restaurada automáticamente como @${currentUsername}`, 'success');

    await loadAlbumsDataList();
    await loadUploadedTracks();
}

// Iniciar comprobación de sesión al arrancar la app
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSessionAutoLogin);
} else {
    initSessionAutoLogin();
}
