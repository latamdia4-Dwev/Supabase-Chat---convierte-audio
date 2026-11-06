# Conversor YouTube y Spotify a MP3 - Supabase Chat

**Versión:** 1.5.0  
**Arquitectura:** Node.js (Express), yt-dlp, FFmpeg, Cloudflare R2, Supabase Auth/DB, Spotify Web API & Render.com  

---

## 🎯 Descripción General
Servicio integral y panel web moderno diseñado para sincronizar música desde **YouTube** y **Spotify** directamente con el perfil y almacenamiento del chat grupal en Supabase y Cloudflare R2.

### ✨ Nuevas Características en la Versión 1.5.0
1. **🟢 Integración Completa con Spotify**:
   - Conexión vía OAuth 2.0 segura con tu cuenta de Spotify.
   - Explorador de canciones guardadas (*Liked Songs*) y listas de reproducción personales (*Playlists*).
   - Búsqueda inteligente en YouTube con un solo clic para cada pista de Spotify.
   - Conversión directa individual o en lote (*Batch Transfer*) para subir álbumes enteros al chat.
   - Asistente integrado para configurar credenciales de Spotify Developer sin tocar archivos.
2. **🚀 Despliegue Automatizado en Render.com**:
   - Archivo de infraestructura declarativa `render.yaml` (Blueprint).
   - Script de aprovisionamiento multiplataforma `scripts/setup-binaries.js` ejecutado en el ciclo `postinstall` de npm.
   - Detección dinámica de ejecutables nativos: Windows (`.exe`) y Linux (`x86_64`) con permisos automáticos (`0o755`).
   - Soporte para variables de entorno y `trust proxy` para HTTPS en producción.
3. **🔍 Búsqueda Extendida y Pre-escucha**:
   - Resultados de hasta 40 canciones por búsqueda en YouTube.
   - Barra flotante interactiva para escuchar la canción antes de convertirla o subirla.
4. **🛡️ Resiliencia y Deduplicación**:
   - Prevención de errores HTTP 403 Forbidden mediante resolución de n-tokens con `--js-runtimes node` y rotación de clientes (`android,web`, `web,android`, `mweb`).
   - Deduplicación por hash SHA-256 en Cloudflare R2 mediante la RPC `find_active_track_by_hash`.
   - Detección de canciones similares con modal comparador visual.

---

## 🚀 Despliegue en Render.com

Para poner esta aplicación en internet en `dashboard.render.com`:

### Opción A: Conectar Repositorio de GitHub (Recomendado)
1. Sube este repositorio a tu cuenta de **GitHub**.
2. Entra en tu panel de [dashboard.render.com](https://dashboard.render.com).
3. Haz clic en **New +** y selecciona **Web Service**.
4. Conecta tu repositorio de GitHub `Supabase-Chat - convierte audio`.
5. Render detectará automáticamente `render.yaml` o configura:
   - **Environment:** `Node`
   - **Build Command:** `npm install` *(el script `scripts/setup-binaries.js` se ejecuta automáticamente por el postinstall y descarga los binarios de Linux)*
   - **Start Command:** `node server.js`
   - **Plan:** `Free`
6. En la pestaña **Environment Variables**, puedes configurar de forma opcional:
   - `SPOTIFY_CLIENT_ID`: Tu Client ID de Spotify.
   - `SPOTIFY_CLIENT_SECRET`: Tu Client Secret de Spotify.
   - `SPOTIFY_REDIRECT_URI`: `https://tu-servicio.onrender.com/api/spotify/callback`
7. Haz clic en **Deploy Web Service**. ¡Listo!

---

## 🟢 Configuración de Spotify

Para conectar tu cuenta de Spotify a la aplicación:

1. Ve a [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) e inicia sesión con tu cuenta de Spotify.
2. Haz clic en **Create app**:
   - **App name:** `Conversor Chat Audio`
   - **App description:** `Sincronizador de música para el chat`
   - **Redirect URIs:** Agrega la URL indicada en la app:
     - Local: `http://localhost:3000/api/spotify/callback`
     - Render: `https://tu-servicio.onrender.com/api/spotify/callback`
   - Marca la casilla de los términos de Spotify y guarda.
3. En la sección **Settings** de tu app de Spotify, copia el **Client ID** y **Client Secret**.
4. Pégalos en el panel de la aplicación en la pestaña **🟢 Mi Spotify** o colócalos en tu archivo `.env`.
5. Presiona **Iniciar Sesión con Spotify** y autoriza los permisos.

---

## 💻 Ejecución en Local (Windows)

1. Instalar dependencias:
   ```bash
   npm install
   ```
2. Iniciar el servidor:
   ```bash
   npm start
   ```
3. Abre tu navegador en [http://localhost:3000](http://localhost:3000).

---

## 🔐 Autenticación y Cuentas
- La autenticación utiliza Supabase Auth conectado a la tabla `profiles` del chat.
- Sin modo invitado: solo usuarios registrados pueden iniciar sesión y subir música.
- Las contraseñas se validan contra el endpoint de Supabase Auth con dominio interno `@chatapp-users.com`.

---

## 📜 Historial de Versiones
- **v1.5.0**: Integración con Spotify (OAuth 2.0, Liked Songs, Playlists y migración a YouTube), soporte de despliegue en Render.com con `render.yaml` y descarga automática de binarios Linux.
- **v1.4.0**: Búsqueda extendida (hasta 40 resultados), barra flotante de pre-escucha interactiva y selector dinámico.
- **v1.3.0**: Mitigación de errores 403 de YouTube con `--js-runtimes node`, rotación de clientes y `safeFetchJson`.
- **v1.2.0**: Login idéntico al chat, soporte de playlists, modal comparador de nombres similares y gestión de álbumes.
- **v1.1.0**: Pipeline de conversión yt-dlp + FFmpeg con subida a R2 y registro en Supabase.
- **v1.0.0**: Inicialización y separación de módulos de base de datos y storage.
