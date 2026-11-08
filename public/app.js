/**
 * ============================================================================
 * Proyecto: Conversor de YouTube a MP3 y Uploader para Supabase Chat
 * Archivo: public/app.js
 * Versión: 1.9.1
 * Descripción: Lógica del cliente enfocada y optimizada para YouTube:
 *              - Resaltado visual interactivo y badge animado en la canción de YouTube en reproducción
 *              - Tarjeta inline inamovible de comparación de duplicados
 *              - Sincronización en tiempo real del reproductor previo y resultados de búsqueda
 *              - Cache-busting estricto (?v=1.8.5) y soporte SSL universal en backend
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
    const queueItem = {
        id: queueId,
        url: item.url,
        title: item.title || 'Canción de YouTube',
        album: item.album || null,
        thumbnail: item.thumbnail || 'https://i.ytimg.com/vi/hqdefault.jpg',
        durationString: item.durationString || '',
        status: 'pending', // 'pending' | 'processing' | 'completed' | 'error'
        errorMsg: null
    };

    downloadQueue.push(queueItem);
    showQueuePanel();
    renderDownloadQueue();
    logEvent(`➕ Añadida a la cola: "${queueItem.title}" (Posición #${downloadQueue.filter(q => q.status === 'pending').length})`, 'info');

    // Iniciar el procesamiento automático si no está activo
    if (!isQueueProcessing) {
        processDownloadQueue();
    }
}

function showQueuePanel() {
    const panel = $('downloadQueuePanel');
    if (panel) {
        panel.classList.remove('hide');
    }
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
            logEvent(`No se puede eliminar "${item.title}" porque ya se está descargando.`, 'warn');
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
    const initialLen = downloadQueue.length;
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

function renderDownloadQueue() {
    const panel = $('downloadQueuePanel');
    const badge = $('queueCountBadge');
    const container = $('queueListContainer');
    if (!panel || !badge || !container) return;

    const pendingCount = downloadQueue.filter(q => q.status === 'pending' || q.status === 'processing').length;
    badge.textContent = pendingCount;

    container.innerHTML = '';
    if (downloadQueue.length === 0) {
        return;
    }

    downloadQueue.forEach(item => {
        const row = document.createElement('div');
        row.className = `queue-item ${item.status}`;

        const thumb = document.createElement('img');
        thumb.className = 'queue-item-thumb';
        thumb.src = item.thumbnail;
        thumb.alt = item.title;

        const info = document.createElement('div');
        info.className = 'queue-item-info';

        const title = document.createElement('div');
        title.className = 'queue-item-title';
        title.textContent = item.title;
        title.title = item.title;

        const status = document.createElement('div');
        status.className = 'queue-item-status';

        if (item.status === 'pending') {
            status.innerHTML = '⏳ En espera...';
        } else if (item.status === 'processing') {
            status.innerHTML = '🔄 Descargando y convirtiendo...';
        } else if (item.status === 'completed') {
            status.innerHTML = '✔ Subida con éxito';
        } else if (item.status === 'error') {
            status.innerHTML = `❌ Error: ${item.errorMsg || 'Falló'}`;
            status.title = item.errorMsg || '';
        }

        info.appendChild(title);
        info.appendChild(status);

        row.appendChild(thumb);
        row.appendChild(info);

        // Botón de eliminar si no está en proceso
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

async function processDownloadQueue() {
    if (isQueueProcessing) return;

    const nextItem = downloadQueue.find(q => q.status === 'pending');
    if (!nextItem) {
        isQueueProcessing = false;
        return;
    }

    isQueueProcessing = true;
    nextItem.status = 'processing';
    renderDownloadQueue();

    logEvent(`[Cola] Iniciando descarga de: "${nextItem.title}"`, 'info');

    try {
        const sessionRes = await client.auth.getSession();
        const token = sessionRes.data?.session?.access_token || currentAccessToken;

        if (!token || !currentUserId) {
            throw new Error('Sesión no disponible. Inicia sesión nuevamente.');
        }

        const result = await safeFetchJson('/api/convert-and-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: nextItem.url,
                album: nextItem.album || null,
                customTitle: nextItem.title,
                accessToken: token,
                userId: currentUserId
            })
        }, 180000);

        nextItem.status = 'completed';
        logEvent(`✔ [Cola] "${nextItem.title}" completada y agregada al perfil.`, 'success');

        await loadAlbumsDataList();
        await loadUploadedTracks();

    } catch (err) {
        nextItem.status = 'error';
        nextItem.errorMsg = err.message || 'Error en conversión';
        logEvent(`✘ [Cola] Error en "${nextItem.title}": ${err.message}`, 'error');
    } finally {
        isQueueProcessing = false;
        renderDownloadQueue();

        // Procesar siguiente item en la cola con pequeña pausa para no saturar
        setTimeout(() => {
            processDownloadQueue();
        }, 800);
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

async function searchYouTube() {
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

            const img = document.createElement('img');
            img.className = 'search-thumb';
            img.src = item.thumbnail;
            img.alt = item.title;

            const info = document.createElement('div');
            info.className = 'search-info';

            const title = document.createElement('div');
            title.className = 'search-title';
            title.textContent = item.title;
            title.title = item.title;

            const channel = document.createElement('div');
            channel.className = 'search-channel';
            channel.textContent = `${item.uploader} • ${item.durationString}`;

            info.appendChild(title);
            info.appendChild(channel);

            const actions = document.createElement('div');
            actions.className = 'search-actions';

            // Botón de Pre-escucha antes de descargar
            const listenBtn = document.createElement('button');
            listenBtn.type = 'button';
            listenBtn.className = 'search-btn-listen';
            listenBtn.textContent = (currentPlayingVideoId === item.id) ? '🔊 Sonando' : '▶ Probar';
            listenBtn.title = 'Escuchar vista previa antes de convertir';
            listenBtn.onclick = () => {
                if (currentPlayingVideoId === item.id) {
                    closePreview();
                } else {
                    playPreview(item.id, item.title);
                }
            };

            // Botón de Selección para personalizar título o álbum antes de convertir
            const selectBtn = document.createElement('button');
            selectBtn.type = 'button';
            selectBtn.className = 'search-btn-select';
            selectBtn.textContent = '✔ Elegir';
            selectBtn.title = 'Seleccionar para ajustar nombre o álbum';

            selectBtn.onclick = () => {
                currentLoadedVideoId = item.id;
                $('youtubeUrlInput').value = item.url;
                $('customTitleInput').value = item.cleanTitle || item.title;

                $('videoPreviewBox').classList.remove('hide');
                $('videoThumbImg').src = item.thumbnail;
                $('videoMetaTitle').textContent = item.title;
                $('videoMetaDetails').textContent = `${item.uploader} • Duración: ${item.durationString}`;

                logEvent(`Seleccionado: "${item.title}" (${item.durationString})`, 'info');
                $('trackConfigSection').scrollIntoView({ behavior: 'smooth' });
                updatePlayingPreviewHighlight();
            };

            // Botón de Conversión Rápida de un Solo Clic
            const convertDirectBtn = document.createElement('button');
            convertDirectBtn.type = 'button';
            convertDirectBtn.className = 'search-btn-select';
            convertDirectBtn.style.background = '#10b981';
            convertDirectBtn.style.color = '#fff';
            convertDirectBtn.innerHTML = '⚡ Convertir';
            convertDirectBtn.title = 'Convertir a MP3 y subir a mi perfil de inmediato';

            convertDirectBtn.onclick = () => {
                if (isQueueProcessing) {
                    addToDownloadQueue({
                        url: item.url,
                        title: item.cleanTitle || item.title,
                        album: $('albumSelectInput').value.trim() || null,
                        thumbnail: item.thumbnail,
                        durationString: item.durationString
                    });
                    return;
                }

                currentLoadedVideoId = item.id;
                $('youtubeUrlInput').value = item.url;
                $('customTitleInput').value = item.cleanTitle || item.title;

                $('videoPreviewBox').classList.remove('hide');
                $('videoThumbImg').src = item.thumbnail;
                $('videoMetaTitle').textContent = item.title;
                $('videoMetaDetails').textContent = `${item.uploader} • Duración: ${item.durationString}`;

                logEvent(`Procesando de inmediato: "${item.title}"`, 'info');
                $('btnConvertAndUpload').click();
                updatePlayingPreviewHighlight();
            };

            // Botón Añadir a la Cola
            const queueBtn = document.createElement('button');
            queueBtn.type = 'button';
            queueBtn.className = 'search-btn-queue';
            queueBtn.innerHTML = '+ Cola';
            queueBtn.title = 'Añadir a la cola de descargas';
            queueBtn.onclick = () => {
                addToDownloadQueue({
                    url: item.url,
                    title: item.cleanTitle || item.title,
                    album: $('albumSelectInput').value.trim() || null,
                    thumbnail: item.thumbnail,
                    durationString: item.durationString
                });
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

function calculateSimilarity(a, b) {
    const normA = normalizeTitle(a);
    const normB = normalizeTitle(b);

    if (normA === normB) return 1.0;
    if (!normA || !normB) return 0.0;

    // Solo si una es subcadena de la otra Y la longitud es al menos el 60%
    if (normA.includes(normB) || normB.includes(normA)) {
        const shorter = Math.min(normA.length, normB.length);
        const longer = Math.max(normA.length, normB.length);
        if (shorter / longer >= 0.60) {
            return 0.85 + 0.15 * (shorter / longer);
        }
    }

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
            $('inlineLoadingText').textContent = '✔ ¡Canción agregada con éxito a tu perfil!';
            setTimeout(() => {
                closeSimilarityNotification();
            }, 1500);
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

    const btn = $('btnConvertAndUpload');
    btn.disabled = true;
    $('btnResetConvertState').classList.remove('hide');

    const consoleBox = $('consoleBox');
    consoleBox.classList.remove('hide');
    consoleBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    logEvent(`Iniciando conversión de playlist: ${selectedTracks.length} canciones al álbum "${album || 'Sin álbum'}"`, 'info');

    let successCount = 0;
    try {
        for (let i = 0; i < selectedTracks.length; i++) {
            const t = selectedTracks[i];
            $('convertBtnText').textContent = `Procesando [${i + 1}/${selectedTracks.length}]: ${t.title}`;
            logEvent(`[${i + 1}/${selectedTracks.length}] Descargando "${t.title}"...`, 'info');

            try {
                const sessionRes = await supabaseClient.auth.getSession();
                const token = sessionRes.data?.session?.access_token || currentAccessToken;

                await safeFetchJson('/api/convert-and-upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: t.url,
                        album: album || null,
                        customTitle: t.cleanTitle || t.title,
                        accessToken: token,
                        userId: currentUserId
                    })
                }, 180000);

                successCount++;
                logEvent(`✔ [${i + 1}/${selectedTracks.length}] "${t.title}" agregada.`, 'success');
            } catch (e) {
                logEvent(`✘ Error en "${t.title}": ${e.message}`, 'error');
            }
        }

        logEvent(`Finalizada la playlist: ${successCount} de ${selectedTracks.length} canciones procesadas.`, 'success');

        $('playlistBox').classList.add('hide');
        $('youtubeUrlInput').value = '';
        currentPlaylistData = null;

        await loadAlbumsDataList();
        await loadUploadedTracks();

    } catch (fatalErr) {
        logEvent(`Error general en la playlist: ${fatalErr.message}`, 'error');
    } finally {
        resetConvertButtonState();
    }
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
    const btn = $('btnConvertAndUpload');
    if (btn.disabled) return;

    const album = $('albumInput').value.trim() || null;

    if (currentPlaylistData && !$('playlistBox').classList.contains('hide')) {
        await processPlaylistUpload(currentPlaylistData, album);
        return;
    }

    const url = $('youtubeUrlInput').value.trim();
    if (!url) {
        logEvent('Ingresa un enlace de YouTube o selecciona una canción del buscador.', 'warn');
        if ($('tabSearchYt').classList.contains('active')) {
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

    const match = findSimilarTrack(customTitle);
    if (match) {
        showSimilarityInlineCard(customTitle, album, match.track, (finalTitle) => {
            return executeUpload(url, finalTitle || customTitle, album);
        });
    } else {
        await executeUpload(url, customTitle, album);
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
