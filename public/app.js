/**
 * ============================================================================
 * Proyecto: Conversor de YouTube a MP3 y Uploader para Supabase Chat
 * Archivo: public/app.js
 * Versión: 1.5.0
 * Descripción: Lógica del cliente con:
 *              - Integración con Spotify (OAuth 2.0, Liked Songs y Playlists)
 *              - Búsqueda automática en YouTube de canciones de Spotify
 *              - Conversión directa de canciones y listas completas de Spotify
 *              - Búsqueda extendida de YouTube (15, 25, 40 resultados)
 *              - Barra de pre-escucha interactiva para verificar audio antes de subir
 *              - Prevención de errores de respuesta HTML (safeFetchJson)
 *              - Login idéntico al chat (sin invitados)
 *              - Detección de canciones similares con modal comparador
 *              - Grupos de álbumes y eliminación directa en Supabase
 * ============================================================================
 */

const $ = (id) => document.getElementById(id);

// Estado de la sesión y aplicación
let currentUserId = null;
let currentAccessToken = null;
let currentUsername = null;
let cachedUsernames = null;
let myTracksCache = [];
let collapsedAlbums = new Set();
let currentLoadedVideoId = null;

// Estado de Spotify
let spotifyCurrentMode = 'liked'; // 'liked' o 'playlists'
let spotifyCurrentTracks = [];
let spotifyCurrentPlaylistTitle = 'Spotify';

/**
 * Función robusta para realizar fetch esperando JSON, evitando errores de 'Unexpected token <'
 */
async function safeFetchJson(url, options) {
    let res = null;
    try {
        res = await fetch(url, options);
    } catch (netErr) {
        throw new Error('No se pudo comunicar con el servidor local. Verifica que la consola tenga corriendo "npm start".');
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Error del servidor (${res.status})`);
        return data;
    } else {
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`El servidor devolvió error ${res.status}. Reinicia el servidor en la terminal con "npm start" para aplicar los cambios.`);
        }
        try {
            return JSON.parse(text);
        } catch (parseErr) {
            throw new Error('El servidor devolvió una respuesta inesperada.');
        }
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
        await checkSpotifyStatus();

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

function setActiveNavTab(activeTabId, activeViewId) {
    const tabs = ['tabModeSearch', 'tabModeDirect', 'tabModeSpotify'];
    const views = ['viewSearch', 'viewDirect', 'viewSpotify'];

    tabs.forEach(t => $(t).classList.remove('active'));
    views.forEach(v => $(v).classList.add('hide'));

    $(activeTabId).classList.add('active');
    $(activeViewId).classList.remove('hide');
}

$('tabModeSearch').onclick = () => setActiveNavTab('tabModeSearch', 'viewSearch');
$('tabModeDirect').onclick = () => setActiveNavTab('tabModeDirect', 'viewDirect');
$('tabModeSpotify').onclick = () => {
    setActiveNavTab('tabModeSpotify', 'viewSpotify');
    checkSpotifyStatus();
};

// ══════════════════════════════════════════════════════════════════════
// 3. BARRA DE PRE-ESCUCHA INTERACTIVA (PREVIEW PLAYER)
// ══════════════════════════════════════════════════════════════════════

function playPreview(videoId, title) {
    if (!videoId) return;
    const bar = $('previewFixedBar');
    const wrap = $('previewIframeWrap');

    $('previewBarTitle').textContent = title || 'Vista previa';
    wrap.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoId}?autoplay=1&enablejsapi=1" allow="autoplay" title="Vista previa"></iframe>`;
    bar.classList.remove('hide');
}

function closePreview() {
    const bar = $('previewFixedBar');
    const wrap = $('previewIframeWrap');
    wrap.innerHTML = '';
    bar.classList.add('hide');
}

$('btnClosePreviewBar').onclick = closePreview;

// ══════════════════════════════════════════════════════════════════════
// 4. BUSCADOR EXTENDIDO DE YOUTUBE (HASTA 40 RESULTADOS CON PRE-ESCUCHA)
// ══════════════════════════════════════════════════════════════════════

async function searchYouTube(forcedQuery = null) {
    const query = forcedQuery || $('ytSearchInput').value.trim();
    if (!query) return;

    if (forcedQuery) {
        $('ytSearchInput').value = forcedQuery;
    }

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
            listenBtn.textContent = '▶ Probar';
            listenBtn.title = 'Escuchar vista previa antes de convertir';
            listenBtn.onclick = () => {
                playPreview(item.id, item.title);
            };

            // Botón de Selección
            const selectBtn = document.createElement('button');
            selectBtn.type = 'button';
            selectBtn.className = 'search-btn-select';
            selectBtn.textContent = '✔ Elegir';
            selectBtn.title = 'Seleccionar para convertir a MP3';

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
            };

            actions.appendChild(listenBtn);
            actions.appendChild(selectBtn);

            row.appendChild(img);
            row.appendChild(info);
            row.appendChild(actions);
            resultsGrid.appendChild(row);
        });

    } catch (err) {
        resultsGrid.innerHTML = `<div style="color: var(--danger); padding: 0.8rem; font-size: 0.88rem;">${err.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Buscar';
    }
}

$('btnYtSearch').onclick = () => searchYouTube();
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

    if (normA.includes(normB) || normB.includes(normA)) {
        const shorter = Math.min(normA.length, normB.length);
        const longer = Math.max(normA.length, normB.length);
        if (shorter / longer >= 0.35) {
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
    return (2.0 * common) / (bA.size + bB.size);
}

function findSimilarTrack(candidateTitle) {
    let bestMatch = null;
    let highestScore = 0;

    for (const track of myTracksCache) {
        const score = calculateSimilarity(candidateTitle, track.display_name);
        if (score > highestScore && score >= 0.55) {
            highestScore = score;
            bestMatch = track;
        }
    }
    return bestMatch ? { track: bestMatch, score: highestScore } : null;
}

function showSimilarityModal(newTitle, newAlbum, existingTrack, onConfirm) {
    $('modalNewTitle').textContent = newTitle;
    $('modalNewAlbum').textContent = newAlbum || 'Sin álbum';

    $('modalExistingTitle').textContent = existingTrack.display_name;
    $('modalExistingAlbum').textContent = existingTrack.album || 'Sin álbum';

    const modalAudioWrap = $('modalAudioCompareWrap');
    modalAudioWrap.innerHTML = '';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'btn-secondary';
    playBtn.style.padding = '4px 10px';
    playBtn.style.fontSize = '0.8rem';
    playBtn.textContent = '▶ Escuchar la que ya tienes';

    playBtn.onclick = async () => {
        try {
            playBtn.disabled = true;
            playBtn.textContent = 'Cargando audio...';
            const signedUrl = await getR2SignedUrl(existingTrack.file_name);
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.src = signedUrl;
            audio.autoplay = true;
            modalAudioWrap.innerHTML = '';
            modalAudioWrap.appendChild(audio);
        } catch (err) {
            alert('Error al reproducir canción existente: ' + err.message);
            playBtn.disabled = false;
            playBtn.textContent = '▶ Escuchar la que ya tienes';
        }
    };
    modalAudioWrap.appendChild(playBtn);

    $('similarityModal').classList.remove('hide');

    $('btnModalUploadAnyway').onclick = () => {
        $('similarityModal').classList.add('hide');
        onConfirm();
    };

    $('btnModalRename').onclick = () => {
        $('similarityModal').classList.add('hide');
        $('customTitleInput').focus();
        $('customTitleInput').select();
    };

    $('btnModalCancel').onclick = () => {
        $('similarityModal').classList.add('hide');
        logEvent('Subida cancelada por el usuario tras verificar similitud.', 'warn');
    };
}

// ══════════════════════════════════════════════════════════════════════
// 7. PIPELINE DE CONVERSIÓN Y SUBIDA (INDIVIDUAL O PLAYLIST)
// ══════════════════════════════════════════════════════════════════════

async function executeUpload(url, customTitle, album) {
    const sessionRes = await supabaseClient.auth.getSession();
    const token = sessionRes.data?.session?.access_token || currentAccessToken;

    if (!token) {
        logEvent('Tu sesión ha expirado. Inicia sesión de nuevo.', 'error');
        return;
    }

    const btn = $('btnConvertAndUpload');
    btn.disabled = true;
    $('convertBtnIcon').textContent = '⏳';
    $('convertBtnText').textContent = 'Convirtiendo...';

    logEvent(`Procesando "${customTitle}"...`, 'info');
    logEvent(`Descargando audio de YouTube y transcodificando a MP3...`, 'info');

    try {
        const result = await safeFetchJson('/api/convert-and-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url,
                album: album || null,
                customTitle,
                accessToken: token,
                userId: currentUserId
            })
        });

        logEvent(`✔ ${result.message}`, 'success');

        $('youtubeUrlInput').value = '';
        $('customTitleInput').value = '';
        $('videoPreviewBox').classList.add('hide');
        currentLoadedVideoId = null;

        await loadAlbumsDataList();
        await loadUploadedTracks();

    } catch (err) {
        logEvent(`Error al procesar: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        $('convertBtnIcon').textContent = '⚡';
        $('convertBtnText').textContent = 'Convertir a MP3 y Subir a mi Perfil';
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

    logEvent(`Iniciando conversión de playlist: ${selectedTracks.length} canciones al álbum "${album}"`, 'info');

    let successCount = 0;
    for (let i = 0; i < selectedTracks.length; i++) {
        const t = selectedTracks[i];
        $('convertBtnText').textContent = `Procesando [${i + 1}/${selectedTracks.length}]: ${t.title}`;
        logEvent(`[${i + 1}/${selectedTracks.length}] Descargando "${t.title}"...`, 'info');

        try {
            const sessionRes = await supabaseClient.auth.getSession();
            const token = sessionRes.data?.session?.access_token || currentAccessToken;

            const res = await safeFetchJson('/api/convert-and-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: t.url,
                    album: album || null,
                    customTitle: t.cleanTitle || t.title,
                    accessToken: token,
                    userId: currentUserId
                })
            });

            successCount++;
            logEvent(`✔ [${i + 1}/${selectedTracks.length}] "${t.title}" agregada.`, 'success');
        } catch (e) {
            logEvent(`✘ Error en "${t.title}": ${e.message}`, 'error');
        }
    }

    logEvent(`Finalizada la playlist: ${successCount} de ${selectedTracks.length} canciones procesadas.`, 'success');
    btn.disabled = false;
    $('convertBtnIcon').textContent = '⚡';
    $('convertBtnText').textContent = 'Convertir a MP3 y Subir a mi Perfil';

    $('playlistBox').classList.add('hide');
    $('youtubeUrlInput').value = '';
    currentPlaylistData = null;

    await loadAlbumsDataList();
    await loadUploadedTracks();
}

$('btnConvertAndUpload').onclick = async () => {
    const album = $('albumInput').value.trim() || null;

    if (currentPlaylistData && !$('playlistBox').classList.contains('hide')) {
        await processPlaylistUpload(currentPlaylistData, album);
        return;
    }

    const url = $('youtubeUrlInput').value.trim();
    if (!url) {
        logEvent('Ingresa un enlace de YouTube o selecciona una canción del buscador.', 'warn');
        return;
    }

    let customTitle = $('customTitleInput').value.trim();
    if (!customTitle) {
        customTitle = `YouTube_${Date.now()}`;
    }

    const match = findSimilarTrack(customTitle);
    if (match) {
        showSimilarityModal(customTitle, album, match.track, () => {
            executeUpload(url, customTitle, album);
        });
    } else {
        await executeUpload(url, customTitle, album);
    }
};

// ══════════════════════════════════════════════════════════════════════
// 8. INTEGRACIÓN CON SPOTIFY (OAUTH, BIBLIOTECA, PLAYLISTS, SUBIDA)
// ══════════════════════════════════════════════════════════════════════

async function checkSpotifyStatus() {
    try {
        const data = await safeFetchJson('/api/spotify/status');

        $('spotifySuggestedRedirectUri').textContent = data.redirectUri;

        if (!data.configured) {
            $('spotifySetupBox').classList.remove('hide');
            $('spotifyLoginBox').classList.add('hide');
            $('spotifyConnectedBox').classList.add('hide');
            return;
        }

        if (!data.authenticated) {
            $('spotifySetupBox').classList.add('hide');
            $('spotifyLoginBox').classList.remove('hide');
            $('spotifyConnectedBox').classList.add('hide');
            return;
        }

        // Usuario autenticado con Spotify
        $('spotifySetupBox').classList.add('hide');
        $('spotifyLoginBox').classList.add('hide');
        $('spotifyConnectedBox').classList.remove('hide');

        const user = data.user;
        $('spotifyUserName').textContent = user ? (user.display_name || user.id) : 'Usuario Spotify';

        const avatarImg = $('spotifyUserAvatar');
        if (user && user.images && user.images.length > 0) {
            avatarImg.src = user.images[0].url;
            avatarImg.classList.remove('hide');
        } else {
            avatarImg.classList.add('hide');
        }

        // Cargar canciones que le gustan inicialmente
        await loadSpotifyLikedTracks();
        await loadSpotifyPlaylists();

    } catch (err) {
        console.error('Error al verificar estado de Spotify:', err);
    }
}

$('btnSaveSpotifyCreds').onclick = async () => {
    const clientId = $('spotifyInputClientId').value.trim();
    const clientSecret = $('spotifyInputClientSecret').value.trim();

    if (!clientId || !clientSecret) {
        alert('Debes ingresar tanto el Client ID como el Client Secret.');
        return;
    }

    try {
        $('btnSaveSpotifyCreds').disabled = true;
        $('btnSaveSpotifyCreds').textContent = 'Guardando...';

        await safeFetchJson('/api/spotify/save-credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId, clientSecret })
        });

        logEvent('Credenciales de Spotify guardadas correctamente.', 'success');
        await checkSpotifyStatus();
    } catch (err) {
        alert('Error al guardar credenciales: ' + err.message);
    } finally {
        $('btnSaveSpotifyCreds').disabled = false;
        $('btnSaveSpotifyCreds').textContent = '💾 Guardar Credenciales de Spotify';
    }
};

$('btnEditSpotifyCreds').onclick = () => {
    $('spotifyLoginBox').classList.add('hide');
    $('spotifySetupBox').classList.remove('hide');
};

$('btnSpotifyDisconnect').onclick = async () => {
    try {
        await safeFetchJson('/api/spotify/disconnect', { method: 'POST' });
        logEvent('Sesión de Spotify cerrada.', 'info');
        await checkSpotifyStatus();
    } catch (e) {
        alert('Error al desconectar Spotify: ' + e.message);
    }
};

$('btnSpotifyLikedTab').onclick = () => {
    spotifyCurrentMode = 'liked';
    $('btnSpotifyLikedTab').classList.add('active-subtab');
    $('btnSpotifyPlaylistsTab').classList.remove('active-subtab');
    $('spotifyPlaylistsDropdownWrap').classList.add('hide');
    loadSpotifyLikedTracks();
};

$('btnSpotifyPlaylistsTab').onclick = () => {
    spotifyCurrentMode = 'playlists';
    $('btnSpotifyPlaylistsTab').classList.add('active-subtab');
    $('btnSpotifyLikedTab').classList.remove('active-subtab');
    $('spotifyPlaylistsDropdownWrap').classList.remove('hide');
    if ($('spotifyPlaylistSelect').value) {
        loadSpotifyPlaylistTracks($('spotifyPlaylistSelect').value);
    }
};

async function loadSpotifyLikedTracks() {
    const list = $('spotifyTracksList');
    list.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Cargando canciones que te gustan...</div>';
    $('spotifyTracksHeader').classList.add('hide');

    try {
        const data = await safeFetchJson('/api/spotify/saved-tracks?limit=50');
        spotifyCurrentTracks = data.tracks || [];
        spotifyCurrentPlaylistTitle = 'Spotify Liked';
        $('spotifyLikedCount').textContent = data.total || spotifyCurrentTracks.length;

        renderSpotifyTracks(spotifyCurrentTracks, 'Canciones que te gustan');
    } catch (err) {
        list.innerHTML = `<div style="color: var(--danger); padding: 1rem;">Error al cargar canciones: ${err.message}</div>`;
    }
}

async function loadSpotifyPlaylists() {
    try {
        const data = await safeFetchJson('/api/spotify/playlists');
        const playlists = data.playlists || [];
        $('spotifyPlaylistsCount').textContent = data.total || playlists.length;

        const sel = $('spotifyPlaylistSelect');
        if (playlists.length > 0) {
            sel.innerHTML = playlists.map(p => `<option value="${p.id}">${p.name} (${p.trackCount} temas)</option>`).join('');
            sel.onchange = () => {
                loadSpotifyPlaylistTracks(sel.value);
            };
        } else {
            sel.innerHTML = '<option disabled>Sin playlists creadas</option>';
        }
    } catch (e) {
        console.warn('Error al cargar playlists:', e);
    }
}

async function loadSpotifyPlaylistTracks(playlistId) {
    if (!playlistId) return;
    const list = $('spotifyTracksList');
    list.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1.5rem;">Cargando pistas de la playlist...</div>';
    $('spotifyTracksHeader').classList.add('hide');

    try {
        const sel = $('spotifyPlaylistSelect');
        const plName = sel.options[sel.selectedIndex]?.text.split(' (')[0] || 'Playlist Spotify';
        spotifyCurrentPlaylistTitle = plName;

        const data = await safeFetchJson(`/api/spotify/playlist/${playlistId}/tracks`);
        spotifyCurrentTracks = data.tracks || [];

        renderSpotifyTracks(spotifyCurrentTracks, plName);
    } catch (err) {
        list.innerHTML = `<div style="color: var(--danger); padding: 1rem;">Error al cargar playlist: ${err.message}</div>`;
    }
}

function renderSpotifyTracks(tracks, sourceName) {
    const list = $('spotifyTracksList');
    const header = $('spotifyTracksHeader');

    if (!tracks || tracks.length === 0) {
        list.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1.5rem;">No se encontraron canciones en esta sección.</div>';
        header.classList.add('hide');
        return;
    }

    header.classList.remove('hide');
    $('spotifyTracksCountText').textContent = `${tracks.length} canciones en "${sourceName}":`;

    list.innerHTML = '';
    tracks.forEach((track, index) => {
        const item = document.createElement('div');
        item.className = 'search-item';

        const img = document.createElement('img');
        img.className = 'spotify-track-thumb';
        img.src = track.thumbnail || 'https://via.placeholder.com/48x48?text=SP';
        img.alt = track.title;

        const info = document.createElement('div');
        info.className = 'search-info';

        const title = document.createElement('div');
        title.className = 'search-title';
        title.textContent = `${index + 1}. ${track.title}`;
        title.title = track.title;

        const artist = document.createElement('div');
        artist.className = 'search-channel';
        artist.textContent = `${track.artist} • ${track.album || 'Sencillo'} (${track.durationString})`;

        info.appendChild(title);
        info.appendChild(artist);

        const actions = document.createElement('div');
        actions.className = 'search-actions';

        // Botón 1: Buscar en YouTube
        const btnSearchYt = document.createElement('button');
        btnSearchYt.type = 'button';
        btnSearchYt.className = 'search-btn-listen';
        btnSearchYt.textContent = '🔎 YouTube';
        btnSearchYt.title = 'Buscar en YouTube con vista previa';
        btnSearchYt.onclick = () => {
            setActiveNavTab('tabModeSearch', 'viewSearch');
            searchYouTube(track.searchQuery);
            $('albumInput').value = track.album || spotifyCurrentPlaylistTitle;
        };

        // Botón 2: Convertir directo
        const btnUploadDirect = document.createElement('button');
        btnUploadDirect.type = 'button';
        btnUploadDirect.className = 'search-btn-select';
        btnUploadDirect.textContent = '⚡ Subir';
        btnUploadDirect.title = 'Buscar el mejor match en YouTube y subir al chat';

        btnUploadDirect.onclick = async () => {
            try {
                btnUploadDirect.disabled = true;
                btnUploadDirect.textContent = 'Buscando...';
                logEvent(`Buscando mejor versión de "${track.title}" en YouTube...`, 'info');

                const ytSearch = await safeFetchJson('/api/youtube-search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: track.searchQuery, limit: 5 })
                });

                if (!ytSearch.results || ytSearch.results.length === 0) {
                    throw new Error(`No se encontró "${track.title}" en YouTube.`);
                }

                const bestMatch = ytSearch.results[0];
                logEvent(`Mejor coincidencia encontrada: "${bestMatch.title}"`, 'info');

                const destAlbum = track.album || spotifyCurrentPlaylistTitle;
                const match = findSimilarTrack(track.title);

                if (match) {
                    showSimilarityModal(track.title, destAlbum, match.track, () => {
                        executeUpload(bestMatch.url, track.title, destAlbum);
                    });
                } else {
                    await executeUpload(bestMatch.url, track.title, destAlbum);
                }

            } catch (err) {
                logEvent(`✘ Error al procesar "${track.title}": ${err.message}`, 'error');
            } finally {
                btnUploadDirect.disabled = false;
                btnUploadDirect.textContent = '⚡ Subir';
            }
        };

        actions.appendChild(btnSearchYt);
        actions.appendChild(btnUploadDirect);

        item.appendChild(img);
        item.appendChild(info);
        item.appendChild(actions);

        list.appendChild(item);
    });
}

// Subida masiva de Spotify al chat
$('btnBatchUploadSpotify').onclick = async () => {
    if (!spotifyCurrentTracks || spotifyCurrentTracks.length === 0) return;

    const confirmed = confirm(`¿Deseas convertir y subir las ${spotifyCurrentTracks.length} canciones al álbum "${spotifyCurrentPlaylistTitle}" en tu perfil?`);
    if (!confirmed) return;

    const btn = $('btnBatchUploadSpotify');
    btn.disabled = true;
    logEvent(`Iniciando migración masiva de Spotify: ${spotifyCurrentTracks.length} canciones...`, 'info');

    let processedCount = 0;
    for (let i = 0; i < spotifyCurrentTracks.length; i++) {
        const t = spotifyCurrentTracks[i];
        btn.textContent = `[${i + 1}/${spotifyCurrentTracks.length}] Subiendo...`;
        logEvent(`[${i + 1}/${spotifyCurrentTracks.length}] Buscando en YouTube: "${t.title} - ${t.artist}"...`, 'info');

        try {
            const ytSearch = await safeFetchJson('/api/youtube-search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: t.searchQuery, limit: 3 })
            });

            if (!ytSearch.results || ytSearch.results.length === 0) {
                logEvent(`▲ No se encontró en YouTube: "${t.title}". Omitiendo.`, 'warn');
                continue;
            }

            const best = ytSearch.results[0];
            const sessionRes = await supabaseClient.auth.getSession();
            const token = sessionRes.data?.session?.access_token || currentAccessToken;

            await safeFetchJson('/api/convert-and-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: best.url,
                    album: t.album || spotifyCurrentPlaylistTitle,
                    customTitle: t.title,
                    accessToken: token,
                    userId: currentUserId
                })
            });

            processedCount++;
            logEvent(`✔ [${i + 1}/${spotifyCurrentTracks.length}] "${t.title}" convertida y subida.`, 'success');
        } catch (e) {
            logEvent(`✘ Error en "${t.title}": ${e.message}`, 'error');
        }
    }

    logEvent(`Proceso de Spotify finalizado: ${processedCount} canciones transferidas al chat.`, 'success');
    btn.disabled = false;
    btn.textContent = '⚡ Subir Todas al Chat';

    await loadAlbumsDataList();
    await loadUploadedTracks();
};

// ══════════════════════════════════════════════════════════════════════
// 9. GESTIÓN Y RENDERIZADO DE ÁLBUMES (IDÉNTICO AL CHAT ORIGINAL)
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
        const isCollapsed = collapsedAlbums.has(albumKey);

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
            if (collapsedAlbums.has(albumKey)) {
                collapsedAlbums.delete(albumKey);
                arrow.textContent = '▾';
                tracksContainer.classList.remove('hide');
            } else {
                collapsedAlbums.add(albumKey);
                arrow.textContent = '▸';
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
    collapsedAlbums.clear();
    renderAlbumsView();
};

$('btnCollapseAllAlbums').onclick = () => {
    const keys = new Set(myTracksCache.map(t => (t.album && t.album.trim()) ? t.album.trim() : '__sin_album__'));
    collapsedAlbums = keys;
    renderAlbumsView();
};

$('filterTracksInput').addEventListener('input', renderAlbumsView);

// ══════════════════════════════════════════════════════════════════════
// 10. DETECCIÓN DE RETORNO OAUTH DE SPOTIFY AL CARGAR
// ══════════════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
    const hash = window.location.hash || '';
    if (hash.includes('spotify_success=1')) {
        history.replaceState(null, '', window.location.pathname);
        setTimeout(() => {
            logEvent('✔ ¡Cuenta de Spotify vinculada exitosamente!', 'success');
            checkSpotifyStatus();
        }, 500);
    } else if (hash.includes('spotify_error=')) {
        const errParam = new URLSearchParams(hash.substring(1)).get('spotify_error');
        history.replaceState(null, '', window.location.pathname);
        setTimeout(() => {
            logEvent(`✘ Error al vincular con Spotify: ${decodeURIComponent(errParam || '')}`, 'error');
        }, 500);
    }
});
