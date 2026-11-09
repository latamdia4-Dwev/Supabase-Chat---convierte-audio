# Changelog — Conversor YouTube a MP3 para Supabase Chat

Todas las versiones siguen [Semantic Versioning](https://semver.org/lang/es/).

---

## [v1.9.3] — 2026-11-08

### 📥 Despliegue Automático de la Lista de Cola y Cierre Fluido de Modales
- **Despliegue automático de la lista de cola**: Al presionar `⚡ Convertir` o `+ Cola`, la función `showQueuePanel()` ahora desminimiza automáticamente el panel flotante y remueve la clase `minimized`, permitiendo que el usuario vea de inmediato la lista de canciones encoladas, el indicador de subida en vivo y los tiempos estimados de espera.
- **Cierre fluido del modal de álbum por backdrop y Escape**: El modal de confirmación de álbum (`#albumPromptModal`) ahora se cierra automáticamente si el usuario hace clic fuera de la cajita (en el fondo oscuro) o presiona la tecla `Escape`, evitando bloqueos en la interfaz.
- **Sincronización de auto-cierre**: Se vinculó `closeAlbumPrompt()` dentro de `closeSimilarityNotification()`, garantizando que tanto la tarjeta de duplicados como el diálogo de álbumes se limpien automáticamente al cambiar de canción o interactuar con la lista de cola.

---

## [v1.9.2] — 2026-11-08

### 💿 Detección Inteligente de Banda/Álbum, Limpieza de Título Completo y Corrección de Cola

#### 1. Cookies Directas en el Repositorio para Despliegues en la Nube
- **Inclusión directa en el repo**: Se removió `cookies.txt` de `.gitignore` y se integró físicamente en la raíz y en `bin/yt_cookies_builtin.txt`, garantizando que Render (o cualquier host en la nube) disponga de la sesión activa de YouTube automáticamente al clonar y desplegar sin configuraciones manuales.

#### 2. Detección de Artista/Banda y Confirmación Interactiva de Álbum
- **Extracción precisa**: La función `extractArtistAndTrackTitle()` analiza el título y el canal de YouTube para extraer con exactitud el nombre del artista o banda (ej. "Guns N' Roses", "Deftones").
- **Modal interactivo de confirmación**: Al seleccionar una canción (`✔ Elegir`, `+ Cola` o `⚡ Convertir`), el sistema pregunta: *"Detectamos la banda: [Nombre]. ¿Es correcto asignarla a este álbum o prefieres dejarla sin categoría?"* con opciones de un clic:
  - `✔ Sí, guardar en este álbum`
  - `📁 Sin categoría (Sin álbum)`
  - `✏️ Personalizar nombre`

#### 3. Limpieza de Título Preservando Banda y Canción Completas
- Elimina automáticamente coletillas parasitarias de YouTube tales como `(Official Music Video)`, `[Official HD Video]`, `(Lyrics)`, `[Remastered]`, `[4K]`, `Audio Oficial`, etc.
- Preserva estrictamente el nombre completo del video en formato limpio: **"Banda - Nombre de la Canción"**.

#### 4. Corrección Definitiva del Botón "+ Cola"
- Corregida la referencia en el DOM: se resolvió el error de lectura sobre el campo de álbum inexistente (`albumSelectInput` -> `albumInput`), permitiendo que el botón `+ Cola` agregue canciones inmediatamente a la cola de descargas con su tiempo estimado.

#### 5. Auto-Cierre de la Interfaz de Duplicados
- La tarjeta flotante de comparación de duplicados (`#similarityInlineCard`) ahora se cierra y limpia automáticamente cada vez que el usuario selecciona otra canción, realiza una nueva búsqueda o ingresa un enlace diferente, eliminando la necesidad de cerrarla manualmente con la cruz.

---

## [v1.9.1] — 2026-11-08

### 🚀 Cola de Descarga Secuencial Inteligente + Single Sign-On (SSO) con Supabase Chat

#### 1. Sistema de Cola de Descargas Secuencial Estricto
- **Procesamiento estrictamente secuencial**: Sube una sola canción a la vez (`processDownloadQueue`), asegurando que no haya colisiones ni solapamientos en subprocesos ni cuellos de botella en la red.
- **Canalización universal a la cola**: Tanto el botón rápido `⚡ Convertir` como `+ Cola`, las playlists completas y el botón principal de conversión encolan automáticamente la pista en lugar de intentar ejecuciones paralelas que provocaban pérdida de peticiones.
- **Métricas de tiempo dinámicas en vivo**:
  - Registro de histórico de tiempos reales de subida finalizados (`uploadDurationsHistory`).
  - Cálculo automático del tiempo promedio de conversión/subida por pista.
  - Estimación en tiempo real del tiempo restante para toda la cola pendiente (`formatTimeRemaining`).
- **Control visual e interactivo de la cola**:
  - Barra de estadísticas en cabecera (`Promedio: ~40s | Restante: ~1m 20s`).
  - Numeración visual clara para canciones pendientes (`#1`, `#2`, `#3`...).
  - Botón interactivo `✕` para quitar canciones pendientes de la cola antes de que inicien.
  - Barra de progreso animada para la canción activa en proceso.
- **Resiliencia anti-504 integrada**: Si el proxy upstream o Render emite un 504 Timeout mientras el servidor sigue convirtiendo en segundo plano, la cola sondea automáticamente Supabase hasta confirmar la pista y avanza a la siguiente canción sin trabarse.

#### 2. Navegación Compartida y Single Sign-On (SSO) con el Chat
- **Navegación con sesión activa**: Botón `💬 Abrir Chat` en la barra de usuario que transfiere la sesión activa de Supabase (`access_token` y `refresh_token`) de forma segura a través del hash de URL hacia `https://latamdia4-dwev.github.io/Supabase-Chat/`.
- **Auto-restauración de sesión**: Al cargar la página, comprueba automáticamente tokens transferidos en el hash de la URL o sesiones preexistentes en Supabase Auth, iniciando sesión de inmediato sin pedir usuario y contraseña repetidamente.
- **Acceso rápido desde el login**: Enlace visible en la pantalla de bloqueo para acceder a la página del Chat.

#### 3. Soporte de Cookies Activas de YouTube
- Integración de `cookies.txt` real para el bypass de captchas y verificación de bot en YouTube.
- Protección en `.gitignore` para no exponer credenciales privadas en el repositorio.

---

## [v1.9.0] — 2026-11-07

### 🛠️ Problema resuelto: Error 504 en redes restringidas + Preview de YouTube bloqueado

#### Cambios en `server.js`

**Nuevas funciones y utilidades:**
- `getConfiguredProxy()` — Resuelve el proxy configurado en variables de entorno (`YOUTUBE_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`).
- `buildFetchAgentForProxy()` — Construye el agente HTTP para fetch() considerando el proxy configurado.
- `runProcess(cmdPath, args, timeoutMs=300000)` — Ahora acepta un timeout configurable. Si `yt-dlp` no termina en el tiempo límite, el proceso se mata con `SIGTERM` y se lanza un error descriptivo, evitando que el proxy upstream devuelva 504 silenciosamente.

**Endpoints nuevos:**
- `GET /api/yt-stream?videoId=XXXX` — Streaming directo de audio a través de yt-dlp usando las cookies y proxy configurados en el backend. Permite reproducir canciones incluso cuando la red corporativa bloquea el acceso directo a youtube.com desde el navegador.
- `GET /api/yt-proxy?videoId=XXXX` — Reproductor dual para redes restringidas: permite alternar con un clic entre streaming nativo por servidor local (utilizando proxy y cookies de YouTube) y el reproductor original embebido de YouTube.

**`buildBaseYtDlpArgs()` mejorado:**
- Agrega `--socket-timeout 30` para fallar rápido si el socket no recibe datos en 30 segundos.
- Propaga `getConfiguredProxy()` a `--proxy` de `yt-dlp` de forma centralizada y con log de confirmación.

**`formatYtDlpError()` mejorado:**
- Detecta errores de timeout/socket y da instrucciones claras para configurar `YOUTUBE_PROXY` en `.env`.
- Detecta errores de red inalcanzable (`getaddrinfo`, `ECONNREFUSED`, `Network is unreachable`) y sugiere el `YOUTUBE_PROXY`.

#### Cambios en `public/app.js`

- `playPreview(videoId, title)` — En lugar de apuntar a `https://www.youtube.com/embed/...` directamente (bloqueado en redes corporativas), ahora usa `/api/yt-proxy?videoId=...` del servidor local.

#### Cambios en `.env.example`

- Documentación completa de `YOUTUBE_PROXY` con ejemplos de formatos HTTP, HTTPS y SOCKS5.
- Aclaración sobre cuándo usar `YOUTUBE_COOKIES` vs `YOUTUBE_COOKIES_BASE64`.

#### Cambios en `package.json`

- Versión actualizada a `1.9.0`.

---

## [v1.8.7] — 2026-10-xx

### Sistema de Cola de Descargas (Download Queue) y Video Previo Expandible

- Panel flotante con estados de progreso: pendiente, procesando, completado, error.
- Botón `+ Cola` en resultados de búsqueda para encolar canciones sin bloquear la UI.
- Botón `⛶ Ver video / 🗗 Reducir` para expandir el reproductor de YouTube.

---

## [v1.8.6] — 2026-10-xx

### Protección anti-429 y bot-check en Render

- Clientes `visionos` y `android_vr` como primera estrategia (inmunes a captchas de YouTube).
- Rotación automática de 5 estrategias de cliente de yt-dlp.
- Soporte automático de `cookies.txt` y variable de entorno `YOUTUBE_COOKIES`.

---

## [v1.8.5b] — 2026-10-xx

### Fix SSL fetch

- Reemplaza `fetch()` por `fetchInsecure()` con `https.Agent({ rejectUnauthorized: false })` para subidas a Cloudflare R2 y Supabase en Windows con certificados intermedios.

---

## [v1.8.5] — 2026-10-xx

### Resaltado visual interactivo de canción en reproducción

- Clase `.playing-now` con glow verde y badge animado en la pista activa.
- Sincronización automática al abrir/cerrar el preview.
- Toggle de reproducción con un clic en el botón `Probar`.

---

## [v1.8.4] — 2026-10-xx

### Arquitectura inline inamovible de comparación de duplicados

- Reemplazo del modal flotante por tarjeta fija en el flujo del DOM (`#similarityInlineCard`).
- Eliminación de cierres accidentales.
- Barra de progreso integrada con detección del límite de 500 MB en Cloudflare.
- Cache-busting estricto (`?v=1.8.4`).

---

## [v1.8.3] — 2026-10-xx

### Prevención de bloqueos por duplicados y soporte SSL universal

- Panel de progreso en vivo dentro del modal de similitud.
- Flag `--no-check-certificates` en yt-dlp para erradicar fallos SSL en Windows.

---

## [v1.8.2] — 2026-10-xx

### Solución definitiva al parpadeo del modal de similitud

- Erradicación del listener de clic en el backdrop overlay.
- Control estricto de propagación de eventos (`stopPropagation`/`preventDefault`).
- Protección temporal contra rebotes (debounce 300ms).
- Umbral de similitud calibrado a 0.72 para evitar falsos positivos.

---

## [v1.8.1] — 2026-10-xx

### Corrección integral del flujo de conversión

- Botón de desbloqueo de emergencia.
- Bypass de advertencias de canciones similares aprobadas.
- Modal de similitud con renombrado in-situ y cierre seguro con detención de audio.
- Timeouts controlados con `AbortController`.
- Botón de descarga directa de un clic desde la búsqueda.
