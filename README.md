# Conversor YouTube a MP3 — Supabase Chat 🎵☁️

> **Versión:** 1.9.12  
> **Autor:** [MarcosHD17](https://github.com/MarcosHD17)  
> **Licencia:** ISC

Servicio web y API REST que convierte canciones de YouTube a MP3 (y otros formatos) con un solo clic y las sube automáticamente al perfil del usuario en el **Supabase Chat**. Integra autenticación SSO, deduplicación por SHA-256, gestión de álbumes, pre-escucha flotante y despliegue automatizado en Render.com.

---

## 🚀 Características Principales

### 🔍 Búsqueda y Descarga desde YouTube
- **Búsqueda por palabras clave** con hasta 50 resultados por consulta, miniaturas y duración.
- **Acceso directo por URL** de video individual o lista de reproducción (Playlist) de YouTube.
- **Botón 📋 Pegar** portapapeles directo al buscador + **🕒 Última búsqueda** recuperable desde `localStorage`.
- Estrategias de cliente rotativas (`visionos`, `android_vr`, `ios`, `android`, `mweb`, `web`) con reintentos automáticos contra bloqueos HTTP 403 / 429 de YouTube.

### 🎵 Pre-escucha Antes de Descargar
- **Reproductor flotante** de pre-escucha integrado en la barra inferior.
- Permite escuchar el video completo de YouTube (incluyendo vista embebida expandida) antes de decidir si descargar.

### ⚡ Pipeline de Conversión y Subida
1. `yt-dlp` descarga el stream de audio desde YouTube con rotación de clientes.
2. `ffmpeg` convierte el audio a **MP3 de máxima fidelidad** (`--audio-quality 0`).
3. Se calcula el **hash SHA-256** del archivo convertido.
4. Si la canción ya existe en Cloudflare R2 (misma huella), no se vuelve a subir; se enlaza directamente a tu perfil (deduplicación de almacenamiento).
5. Se inserta el registro en la tabla `music_tracks` de Supabase con tu usuario, título personalizado y álbum elegido.

### 📀 Gestión de Álbumes
- **Álbum persistente por búsqueda:** Fija un álbum para toda una sesión de búsqueda y se aplica automáticamente a cada canción que descargues sin necesidad de reconfirmarlo.
- **Badge interactivo** del álbum activo con botón `✕` para desvincularlo al instante.
- **Reseteo automático** al iniciar una nueva búsqueda diferente.
- Confirmación independiente de álbum por canción cuando no hay álbum fijado.

### 🔗 Integración SSO con el Chat
- **Botón "Ir al Chat"** que transfiere los tokens de sesión de Supabase Auth al **Supabase Chat** sin volver a iniciar sesión.
- Soporte para **auto-login por URL hash** (`#access_token=...&refresh_token=...`) cuando el chat redirige hacia el conversor.
- Pantalla de login con registro de nueva cuenta directamente en la app.

### ☁️ Almacenamiento en Cloudflare R2
- Las canciones se suben al bucket de Cloudflare R2 vía un **Worker HTTP** privado.
- Límite recomendado: **40 MB** por canción, **500 MB** de cuota por usuario.
- Deduplicación automática: si otra persona ya subió la misma canción, se agrega a tu perfil sin duplicar el archivo.

### 🛠️ Aprovisionamiento Automático de Binarios
- El hook `postinstall` de npm ejecuta `scripts/setup-binaries.js`, que descarga automáticamente:
  - `yt-dlp` (Windows `.exe` o Linux binario).
  - `ffmpeg` (Windows `.exe` o Linux `x64` desde ffbinaries).
- No necesitas instalar FFmpeg ni yt-dlp manualmente en tu sistema.

---

## 📋 Requisitos Previos

1. **Node.js** ≥ 18.0.0 (se recomienda Node 20 LTS o superior).
2. Proyecto de **Supabase** configurado con tabla `music_tracks` y Auth habilitado.
3. Bucket de **Cloudflare R2** con un Worker HTTP para subida de archivos.
4. *(Opcional)* Archivo `cookies.txt` de YouTube para evitar bloqueos 429 en servidores cloud.

---

## 🛠️ Instalación

### 1. Clonar e instalar dependencias
```bash
cd "Supabase-Chat - convierte audio -"
npm install
```
> [!NOTE]
> `npm install` ejecuta automáticamente el script `scripts/setup-binaries.js`, descargando `yt-dlp` y `ffmpeg` en la carpeta `bin/` según tu sistema operativo.

### 2. Configurar variables de entorno
Copia `.env.example` a `.env` y completa los valores:
```ini
# Puerto del servidor
PORT=3000
NODE_ENV=development

# API de Spotify (opcional, para integración futura)
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=
```

> [!IMPORTANT]
> Las credenciales de Supabase (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) y la URL del Cloudflare Worker (`MEDIA_API_URL`) están hardcodeadas en `server.js`. Si usas tu propia instancia, actualízalas allí.

---

## 💻 Cómo Correr el Proyecto

### Modo Normal
```bash
npm start
```
Abre `http://localhost:3000` en el navegador.

### Modo Desarrollo (con auto-recarga)
```bash
npm run dev
```

---

## 🌐 Despliegue en Render.com

El archivo `render.yaml` incluye toda la configuración necesaria:

| Campo | Valor |
|---|---|
| Build Command | `npm install && node scripts/setup-binaries.js` |
| Start Command | `node server.js` |
| Plan | Free |
| Región | Oregon |

**Variables recomendadas en Render:**
- `NODE_ENV`: `production`
- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` / `SPOTIFY_REDIRECT_URI`: credenciales de Spotify Developer.
- `YOUTUBE_COOKIES` *(opcional)*: Contenido de tu `cookies.txt` de YouTube para evitar bloqueos de IP de datacenter.

---

## 📡 API REST

### `POST /api/youtube-search`
Busca videos en YouTube por palabras clave.
```json
{ "query": "dua lipa houdini", "limit": 20 }
```

### `POST /api/playlist-info`
Extrae todas las pistas de una playlist pública de YouTube.
```json
{ "url": "https://www.youtube.com/playlist?list=PL..." }
```

### `POST /api/video-info`
Obtiene metadatos (título, duración, miniatura) de un video.
```json
{ "url": "https://www.youtube.com/watch?v=suAR1PYFNYA" }
```

### `POST /api/convert-and-upload`
Pipeline completo: convierte a MP3 y sube directamente al perfil de Supabase.
```json
{
  "url": "https://www.youtube.com/watch?v=suAR1PYFNYA",
  "title": "Dua Lipa - Houdini",
  "album": "Pop Hits",
  "userId": "uuid-de-supabase",
  "accessToken": "token-de-supabase-auth"
}
```

---

## 🛡️ Solución al Error 429 / Bot Detection de YouTube

Si ves errores en Render como _"Sign in to confirm you're not a bot"_ o _"HTTP Error 429"_:
1. En tu navegador, instala la extensión **Get cookies.txt LOCALLY**.
2. Inicia sesión en YouTube y exporta el archivo `cookies.txt`.
3. En tu servicio de Render, ve a **Environment** → crea la variable `YOUTUBE_COOKIES` → pega el contenido del archivo.
4. El servidor detecta la variable automáticamente y la usa en cada petición a YouTube.

---

## 📁 Estructura del Repositorio

```text
Supabase-Chat - convierte audio -/
├── bin/                      # Binarios yt-dlp y ffmpeg (descargados por postinstall) [Git ignorado]
├── node_modules/             # Dependencias npm [Git ignorado]
├── public/
│   ├── app.js                # Lógica de cliente: búsqueda, pre-escucha, conversión y álbumes
│   ├── index.html            # Interfaz web responsiva
│   └── styles.css            # Estilos completos (modo claro/oscuro)
├── scripts/
│   └── setup-binaries.js     # Aprovisionamiento automático multiplataforma de yt-dlp y ffmpeg
├── temp_audio/               # Archivos temporales de conversión [Git ignorado]
├── .env                      # Variables de entorno locales [Git ignorado]
├── .env.example              # Plantilla de variables de entorno
├── .gitignore                # Exclusiones de Git
├── CHANGELOG.md              # Historial de versiones detallado
├── package.json              # Metadatos del proyecto y dependencias
├── README.md                 # Esta documentación
├── render.yaml               # Especificación de despliegue en Render.com
└── server.js                 # Servidor Express: API REST, conversión y subida a R2
```

---

## 📋 Historial de Versiones Destacado

| Versión | Descripción |
|---|---|
| **v1.9.12** | Reparación de cola (pollForTrackAfterTimeout), bypass anti-bot visionos y resiliencia de proxy |
| **v1.9.11** | Álbum persistente por búsqueda, botón 📋 Pegar portapapeles, 🕒 última búsqueda |
| **v1.9.10** | Fix SSL Node 24 para subida a R2, confirmación de álbum independiente por canción |
| **v1.9.9** | Paneles fijados en recuadro lateral, reparación de botones de cola y conversión |
| **v1.9.8** | Blindaje de búsqueda en YouTube, fallback anti-caída de proxy, logging proactivo |
| **v1.9.7** | Panel lateral de duplicados a la derecha, activación de botones de cola |

Ver historial completo en [CHANGELOG.md](CHANGELOG.md).
