/**
 * ============================================================================
 * Proyecto: Conversor de YouTube a MP3 y Uploader para Supabase Chat
 * Archivo: public/app.js
 * Versión: 1.1.0
 * Descripción: Lógica del cliente para autenticación, análisis de videos,
 *              orquestación de conversión de YouTube a MP3 y gestión de álbumes
 *              en el perfil del usuario de Supabase Chat.
 * ============================================================================
 */

// Elementos del DOM
const $ = (id) => document.getElementById(id);

let currentUserId = null;
let currentAccessToken = null;
let currentUsername = null;
let cachedUsernames = null;

/**
 * Función para imprimir mensajes en la consola de eventos en vivo
 */
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

/**
 * Obtener la lista pública de usuarios registrados desde Supabase profiles
 * (Igual que en el chat principal y uploader.html)
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

/**
 * Alternar el menú desplegable de usuarios
 */
$('btnToggleUsers').onclick = async () => {
    const dropdown = $('userDropdown');
    if (!dropdown.classList.contains('hide')) {
        dropdown.classList.add('hide');
        return;
    }

    const list = await fetchUsernames();
    if (list.length > 0) {
        dropdown.innerHTML = list.map(u => `<option value="${u.replace(/"/g, '&quot;')}">${u.replace(/</g, '&lt;')}</option>`).join('');
    } else {
        dropdown.innerHTML = '<option disabled>Sin usuarios registrados</option>';
    }
    dropdown.classList.remove('hide');
};

$('userDropdown').onchange = (e) => {
    $('usernameInput').value = e.target.value;
    e.target.classList.add('hide');
    $('passwordInput').focus();
};

/**
 * Iniciar sesión con la cuenta de Supabase Chat
 */
async function handleLogin() {
    const username = $('usernameInput').value.trim();
    const password = $('passwordInput').value;
    $('loginErrorMsg').textContent = '';

    if (!username || !password) {
        $('loginErrorMsg').textContent = 'Por favor escribe tu usuario y contraseña.';
        return;
    }

    try {
        $('btnLogin').disabled = true;
        $('btnLogin').textContent = 'Verificando...';

        const user = await loginAccount(username, password);
        currentUserId = user.id;
        currentUsername = username;

        // Obtener token de acceso para las peticiones de subida
        const session = (await supabaseClient.auth.getSession()).data.session;
        currentAccessToken = session ? session.access_token : null;

        $('currentUsernameText').textContent = username;
        $('loginCard').classList.add('hide');
        $('appCard').classList.remove('hide');

        logEvent(`Sesión iniciada correctamente como @${username}`, 'success');

        // Cargar álbumes y pistas existentes
        await loadAlbums();
        await loadUserTracks();

    } catch (err) {
        $('loginErrorMsg').textContent = err.message || 'Error al iniciar sesión.';
    } finally {
        $('btnLogin').disabled = false;
        $('btnLogin').textContent = 'Entrar a mi cuenta';
    }
}

$('btnLogin').onclick = handleLogin;
$('passwordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
});

/**
 * Cerrar sesión
 */
$('btnLogout').onclick = async () => {
    await supabaseClient.auth.signOut();
    location.reload();
};

/**
 * Cargar lista de álbumes únicos del usuario
 */
async function loadAlbums() {
    try {
        const { data, error } = await supabaseClient
            .from('music_tracks')
            .select('album')
            .eq('user_id', currentUserId)
            .not('album', 'is', null);

        if (error) throw error;

        const uniqueAlbums = [...new Set((data || []).map(r => r.album))].sort();
        $('albumDataList').innerHTML = uniqueAlbums
            .map(album => `<option value="${album.replace(/"/g, '&quot;')}">`)
            .join('');

    } catch (err) {
        console.warn('Error al cargar álbumes:', err);
    }
}

/**
 * Analizar URL de YouTube y previsualizar video
 */
async function fetchVideoInfo() {
    const url = $('youtubeUrlInput').value.trim();
    if (!url) {
        logEvent('Ingresa un enlace de YouTube para analizar.', 'warn');
        return null;
    }

    try {
        $('btnFetchInfo').disabled = true;
        $('btnFetchInfo').textContent = 'Buscando...';
        logEvent(`Analizando información de YouTube: ${url}`, 'info');

        const response = await fetch('/api/video-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Error al obtener datos del video.');

        // Mostrar caja de previsualización
        $('videoPreviewBox').classList.remove('hide');
        $('videoThumbImg').src = data.thumbnail || '';
        $('videoMetaTitle').textContent = data.title;
        $('videoMetaDetails').textContent = `${data.uploader || 'YouTube'} • Duración: ${data.durationString}`;

        // Sugerir título limpio si el usuario no ha escrito uno
        if (!$('customTitleInput').value.trim()) {
            $('customTitleInput').value = data.cleanTitle || data.title;
        }

        logEvent(`Video encontrado: "${data.title}" (${data.durationString})`, 'success');
        return data;

    } catch (err) {
        logEvent(err.message, 'error');
        return null;
    } finally {
        $('btnFetchInfo').disabled = false;
        $('btnFetchInfo').innerHTML = '<span>🔍</span> Analizar';
    }
}

$('btnFetchInfo').onclick = fetchVideoInfo;
$('youtubeUrlInput').addEventListener('change', () => {
    if ($('youtubeUrlInput').value.trim()) fetchVideoInfo();
});

/**
 * Convertir Video de YouTube a MP3 y subir a R2 / Supabase
 */
$('btnConvertAndUpload').onclick = async () => {
    const url = $('youtubeUrlInput').value.trim();
    if (!url) {
        logEvent('Ingresa un enlace válido de YouTube.', 'warn');
        $('youtubeUrlInput').focus();
        return;
    }

    let customTitle = $('customTitleInput').value.trim();
    if (!customTitle) {
        // Si no analizó antes, intentar obtener el título
        const info = await fetchVideoInfo();
        if (info) customTitle = info.cleanTitle || info.title;
        if (!customTitle) customTitle = `YouTube_${Date.now()}`;
        $('customTitleInput').value = customTitle;
    }

    const album = $('albumInput').value.trim() || null;

    // Asegurar token de sesión fresco
    const sessionRes = await supabaseClient.auth.getSession();
    const token = sessionRes.data?.session?.access_token || currentAccessToken;

    if (!token) {
        logEvent('La sesión ha expirado. Inicia sesión nuevamente.', 'error');
        return;
    }

    // Bloquear UI durante el procesamiento
    const btn = $('btnConvertAndUpload');
    btn.disabled = true;
    $('convertBtnIcon').textContent = '⏳';
    $('convertBtnText').textContent = 'Descargando y convirtiendo audio...';

    logEvent(`Iniciando pipeline de conversión para "${customTitle}"...`, 'info');
    logEvent(`Descargando audio de YouTube y transcodificando a MP3 de alta fidelidad...`, 'info');

    try {
        const response = await fetch('/api/convert-and-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url,
                album,
                customTitle,
                accessToken: token,
                userId: currentUserId
            })
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || 'Ocurrió un error en la conversión o subida.');
        }

        logEvent(`✔ Proceso completado con éxito: ${result.message}`, 'success');
        if (album) {
            logEvent(`Asignada al álbum: "${album}"`, 'info');
        }

        // Limpiar campos de entrada
        $('youtubeUrlInput').value = '';
        $('customTitleInput').value = '';
        $('videoPreviewBox').classList.add('hide');

        // Recargar datos actualizados
        await loadAlbums();
        await loadUserTracks();

    } catch (err) {
        logEvent(`Error en el proceso: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        $('convertBtnIcon').textContent = '⚡';
        $('convertBtnText').textContent = 'Convertir a MP3 y Subir a mi Perfil';
    }
};

/**
 * Cargar y mostrar las pistas subidas por el usuario
 */
async function loadUserTracks() {
    const container = $('userTracksContainer');
    try {
        const { data: tracks, error } = await supabaseClient
            .from('music_tracks')
            .select('*')
            .eq('user_id', currentUserId)
            .is('deleted_at', null)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!tracks || tracks.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1rem; font-size: 0.88rem;">No tienes canciones en tu perfil aún. ¡Convierte tu primer video arriba!</div>';
            return;
        }

        container.innerHTML = '';

        for (const track of tracks) {
            const item = document.createElement('div');
            item.className = 'track-item';

            const infoDiv = document.createElement('div');
            infoDiv.className = 'track-info';

            const titleSpan = document.createElement('span');
            titleSpan.className = 'track-title';
            titleSpan.textContent = track.display_name;

            const albumSpan = document.createElement('span');
            albumSpan.className = 'track-album';
            albumSpan.textContent = track.album ? `Álbum: ${track.album}` : 'Sin álbum';

            infoDiv.appendChild(titleSpan);
            infoDiv.appendChild(albumSpan);

            const playerDiv = document.createElement('div');
            playerDiv.className = 'track-player';

            const playBtn = document.createElement('button');
            playBtn.className = 'btn-secondary';
            playBtn.style.padding = '0.35rem 0.65rem';
            playBtn.style.fontSize = '0.82rem';
            playBtn.textContent = '▶ Escuchar';

            playBtn.onclick = async () => {
                try {
                    playBtn.disabled = true;
                    playBtn.textContent = 'Cargando...';
                    const signedUrl = await getR2SignedUrl(track.file_name);

                    // Reemplazar botón con reproductor
                    const audioEl = document.createElement('audio');
                    audioEl.controls = true;
                    audioEl.src = signedUrl;
                    audioEl.autoplay = true;

                    playerDiv.replaceChild(audioEl, playBtn);
                } catch (audioErr) {
                    alert('Error al reproducir canción: ' + audioErr.message);
                    playBtn.disabled = false;
                    playBtn.textContent = '▶ Escuchar';
                }
            };

            playerDiv.appendChild(playBtn);

            item.appendChild(infoDiv);
            item.appendChild(playerDiv);
            container.appendChild(item);
        }

    } catch (err) {
        container.innerHTML = `<div style="color: var(--danger); font-size: 0.85rem; padding: 0.5rem;">Error al cargar canciones: ${err.message}</div>`;
    }
}

$('btnRefreshTracks').onclick = loadUserTracks;
