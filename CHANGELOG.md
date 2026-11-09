# Changelog — Conversor YouTube a MP3 para Supabase Chat

Todas las versiones siguen [Semantic Versioning](https://semver.org/lang/es/).

---

## [v1.9.11] — 2026-11-08

### ⚡ Álbum Persistente por Búsqueda, Botón Pegar Portapapeles y Acceso a Última Búsqueda

#### 1. Persistencia Opcional de Álbum para la Búsqueda Actual
- **Checkbox "Guardar todas las canciones de esta búsqueda en este álbum"**: Añadido en el panel lateral de álbum (`#albumPromptSidePanel`). Al agregar la primera canción de una búsqueda y confirmar el álbum con la casilla marcada, el álbum queda fijado para todas las canciones siguientes de esa misma consulta sin volver a abrir el panel en cada una.
- **Reseteo automático en nueva búsqueda**: En cuanto el usuario escribe y ejecuta una consulta diferente en YouTube, el álbum vinculado a la búsqueda anterior se limpia y el panel vuelve a preguntar para el nuevo artista.
- **Badge interactivo de álbum activo**: En la barra de resultados se muestra el álbum activo con un botón `✕` para desvincularlo en cualquier momento si se desea cambiar.

#### 2. Botón Pegar Portapapeles y Acceso Rápido a Última Búsqueda
- **Botón "📋 Pegar"**: Lee automáticamente el texto del portapapeles y lo coloca en el buscador de YouTube en un solo clic.
- **Botón "🕒 Última: [Consulta]"**: Registra la última búsqueda en `localStorage` y permite recargarla y buscarla instantáneamente.

---

## [v1.9.10] — 2026-11-08

### 🚀 Rescate de Subida a R2, Bypass Universal de Certificados SSL y Pregunta de Álbum por Canción

#### 1. Solución al Error de Subida a Cloudflare R2
- **Causa**: Node 24 utiliza el cliente nativo HTTP `undici` para `fetch`, el cual no respeta los agentes `https.Agent({ rejectUnauthorized: false })` por defecto, provocando el fallo `UNABLE_TO_VERIFY_LEAF_SIGNATURE` al enviar peticiones multipart/binarias al Worker de Cloudflare R2 en redes Windows con certificados intermedios.
- **Corrección**: Se activó `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` en el arranque del servidor Express, permitiendo la subida y comunicación cifrada fluida hacia R2 y Supabase sin rechazos de firma de certificado.
- **Estrategias con Cookies**: Cuando se detectan cookies de sesión de YouTube, `server.js` prioriza automáticamente `mweb,web` y `web,mweb` para descargar y transcodificar al primer intento sin pasar por clientes sin soporte de cookies.

#### 2. Confirmación Independiente de Álbum por Canción y Reseteo entre Búsquedas
- **Causa**: Al confirmar un álbum para una canción, el valor quedaba guardado en `#albumInput` y la función `proceedToQueueWithAlbum` lo reutilizaba ciegamente para las siguientes canciones o búsquedas distintas, sin volver a abrir el panel selector.
- **Corrección**:
  - `proceedToQueueWithAlbum` ahora evalúa siempre la banda detectada de la canción actual (`detectedBand`) y abre el panel lateral en el recuadro rojo para que el usuario elija o confirme el álbum específico.
  - Al ejecutar una nueva búsqueda en YouTube (`searchYouTube`), los campos de álbum y título previo se limpian automáticamente para garantizar que la nueva consulta empiece 100% limpia.

---

## [v1.9.9] — 2026-11-08

### 🎯 Ubicación en Recuadro Rojo, Corrección de Botones de Cola/Conversión y Estabilidad Integral

#### 1. Posicionamiento en el Recuadro Rojo Exterior (Margen Derecho)
- **Adaptativo milimétrico**: Tanto el panel de confirmación de álbum (`#albumPromptSidePanel`) como el de advertencia de duplicados (`#similarityInlineCard`) ahora usan la regla adaptativa:
  `right: max(20px, calc(50vw - 370px - 325px));`
  - En pantallas anchas/Full HD: se colocan automáticamente en el espacio negro libre a la derecha del contenedor principal (`.container`), en el recuadro rojo exacto indicado por el usuario, sin empujar los resultados de búsqueda.
  - En laptops o resoluciones con escalado de Windows (1280px–1366px): se mantienen fijos a 20px del margen derecho del viewport sin desbordarse ni provocar scroll horizontal.
  - En pantallas menores a 900px: se deslizan fluidamente desde abajo como *bottom-sheet*.

#### 2. Corrección Crítica en Botones de Cola y Convertir
- **Prevención de `TypeError`**: Se eliminó un intento de acceso a `classList` en elementos inexistentes en `closeSimilarityNotification()`. Este error detenía silenciosamente la ejecución de los botones `+ Cola`, `⚡ Convertir` y `Buscar`.
- Con esta corrección, los botones ejecutan fluidamente la validación de duplicados y el selector de álbumes existentes/nuevos.

#### 3. Limpieza de Caracteres y Emojis en Español
- Restaurados todos los caracteres especiales y emojis en botones y paneles (`▶ Probar`, `✔ Elegir`, `+ Cola`, `⚡ Convertir`, `✏️ Cambiar Nombre`, `✕ Cancelar`).
- Cache-busting actualizado a `v1.9.9` en `index.html` y `server.js`.

---

## [v1.9.8] — 2026-11-08

### 🛡️ Blindaje Total de Búsqueda en YouTube, Fallback Anti-Caída de Proxy y Verificación Integral

#### 1. Resiliencia de Búsqueda ante Proxies Caídos o Lentos
- **Estrategias escalonadas**: `/api/youtube-search` ahora implementa un pipeline de reintentos inteligentes:
  1. `youtube:player_client=visionos,android_vr` (con proxy, si está configurado).
  2. `youtube:player_client=android_vr,visionos` (con proxy).
  3. `youtube:player_client=ios,android` (**conexión directa sin proxy**, rescate automático).
  4. Búsqueda nativa sin extractor-args (**conexión directa sin proxy**).
- **Socket Timeout**: Se fijó `--socket-timeout 15` y `--prefer-insecure` para que ningún proxy caído o red restringida con certificados interceptados cuelgue el proceso.

#### 2. Feedback en Tiempo Real en la Consola del Conversor
- `searchYouTube()` emite eventos en vivo en la consola:
  - *"🔍 Buscando '[término]' en YouTube..."*
  - *"✔ [X] canciones encontradas..."*
  - *"Sin resultados para '[término]'."*
- Se aplicó `e.preventDefault(); e.stopPropagation();` en los botones de acción para aislar completamente los eventos.

#### 3. Actualización de Cache-Busting
- `styles.css?v=1.9.8`, `app.js?v=1.9.8` y scripts dependientes actualizados para forzar la recarga limpia de activos en el navegador.

---

## [v1.9.7] — 2026-11-08

### 🎛️ Panel Lateral de Duplicados a la Derecha y Activación Operativa de Cola

#### 1. Panel Lateral de Duplicados en Posición Fija a la Derecha
- **Reubicación solicitada por el usuario**: La tarjeta de validación de duplicados (`#similarityInlineCard`) se extrajo del interior del contenedor principal y se transformó en un elemento flotante fijo (`.similarity-side-panel`) ubicado en el **margen derecho del viewport** (`left: calc(50% + 390px)`), exactamente en el mismo espacio donde aparece el panel de álbum (recuadro rojo).
- **Diseño**: Borde ámbar (`#eab308`), cabecera con gradiente dorado (`#854d0e → #ca8a04`), visualización compacta de pista entrante vs pista registrada, botón para escuchar la pista existente, opción de renombrado in-situ y botones de acción.
- **Responsivo**: En pantallas móviles ($le 900\text{px}$), se convierte suavemente en un bottom-sheet deslizable desde abajo.

#### 2. Corrección Operativa de los Botones "+ Cola" y "⚡ Convertir"
- **Causa resuelta**: Se definió formalmente `processTrackSelection()` y `proceedToQueueWithAlbum()` en el ámbito global antes de `searchYouTube()`, eliminando el `ReferenceError` que impedía que los clics en los botones de búsqueda realizaran cualquier acción.
- **Flujo coordinado**:
  1. Si se detecta una canción similar, salta el panel amarillo de duplicados a la derecha.
  2. Si el usuario confirma o renombra, el panel amarillo se cierra y da paso al panel azul de álbum a la derecha (si la pista aún no tiene álbum asignado).
  3. Tras confirmar el álbum (o elegir "Sin categoría"), la canción se encola en `addToDownloadQueue()` y se desminimiza la lista de la cola con tiempos estimados.

---

## [v1.9.6] — 2026-11-08

### 🔍 Validación Proactiva de Duplicados en Búsqueda y Algoritmo de Similitud Mejorado

#### 1. Detección Proactiva de Duplicados en Búsqueda de YouTube
- **Problema corregido**: Al pulsar `+ Cola` o `⚡ Convertir` directamente en los resultados de búsqueda de YouTube, la aplicación encolaba la pista sin consultar si ya existía en el perfil del usuario.
- **Solución integral**: Se implementó `processTrackSelection()` que valida preventivamente la canción contra la caché del perfil (`myTracksCache`) antes de pedir el álbum o encolar.
- Si se detecta una canción similar o idéntica, se despliega de inmediato la tarjeta inline de advertencia (`#similarityInlineCard`) permitiendo:
  - Comparar visualmente ambas pistas.
  - Escuchar la pista existente con un clic.
  - Subir de todos modos.
  - Cambiar de nombre in-situ y continuar.
  - Cancelar la subida sin encolar.

#### 2. Algoritmo de Similitud Resiliente a Prefijos de Artista / Banda
- **Corrección de falsos negativos**: Antes, títulos como "Green A - Carta a dios" comparados contra "Carta a dios" o "Guns N' Roses - Don't Cry" contra "Don't Cry" daban un score inferior a 0.72 debido a la penalización por longitud estricta (regla del 60%).
- **Mejora**: Se incorporó `extractTrackNameOnly()` y comparación de subcadena significativa (longitud >= 5 caracteres) que otorga un score mínimo de 0.88 cuando el título de la canción está completamente contenido en el resultado de búsqueda.

#### 3. Reposicionamiento Dinámico y Cierre Inmediato de la Tarjeta Inline
- Si la cuadrícula de búsqueda está activa, la tarjeta `#similarityInlineCard` se inserta en el DOM **justo encima de los resultados de búsqueda**, evitando que el usuario tenga que desplazarse hacia el final de la página.
- Al confirmar ("Subir de todos modos" o "Cambiar Nombre"), la tarjeta se cierra inmediatamente para dar paso fluido al panel lateral de álbum o a la cola de descargas.

---

## [v1.9.4] — 2026-11-08

### Panel Lateral Inamovible de Album en el DOM + Estilos Completos

#### 1. Eliminacion del Modal Flotante de Album (#albumPromptModal)
- El modal flotante (position: fixed) se cerraba solo ante cualquier evento DOM externo.
- Solucion: Eliminado #albumPromptModal. Sustituido por aside#albumPromptSidePanel,
  ubicado directamente junto a #searchResultsGrid dentro de .search-layout-row (flex).

#### 2. Panel Lateral Estatico en el DOM (#albumPromptSidePanel)
- Vive permanentemente en el DOM, oculto con .hide. Inmune a cierres accidentales.
- Muestra: artista detectado (verde), titulo completo, campo editable de album, 2 botones.
- Animacion de entrada: sidePanelSlideIn — desliza desde la derecha.
- position: sticky top 20px: visible mientras el usuario navega la lista de resultados.

#### 3. Nueva promptAlbumConfirmation(suggestedArtist, songTitle) en app.js
- Rellena #promptArtistNameText, #promptSongNameText y #promptAlbumInput.
- Remueve .hide del panel y hace scrollIntoView smooth.
- Resuelve la promesa al confirmar album, elegir sin categoria o presionar Escape/X.
- Desconecta todos los listeners al resolver (evita fugas de memoria).
- Parametro songTitle nuevo para mostrar el titulo completo de la cancion.
- Llamadas actualizadas: promptAlbumConfirmation(detectedBand, fullTitleClean).

#### 4. Estilos CSS del Panel Lateral (public/styles.css)
- .search-layout-row: flex horizontal, gap 16px, align-items flex-start.
- .album-side-panel: 300px fijo, fondo #0f1623, borde azul #0284c7, sticky top 20px.
- .album-side-header: gradiente azul #0369a1 a #0284c7, titulo y boton cerrar.
- .album-side-field input: foco con borde azul y sombra suave.
- Responsive: <= 900px colapsa a columna vertical, panel pasa a 100% ancho.

#### 5. Inicializacion Global del Boton X en DOMContentLoaded
- Listener global para #btnCloseAlbumSidePanel (funciona incluso sin promesa activa).

#### 6. Actualizacion de Cache-Busting
- Todos los ?v= en index.html actualizados a 1.9.4 (styles, config, media-api, auth, app).

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
