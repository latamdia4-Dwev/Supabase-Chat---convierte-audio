# Conversor YouTube y Spotify a MP3 - Supabase Chat

**Versión:** 1.6.1  
**Arquitectura:** Node.js (Express), yt-dlp, FFmpeg, Cloudflare R2, Supabase Auth/DB, Spotify Web API & Render.com  

---

## 🎯 Descripción General
Servicio integral y panel web moderno diseñado para sincronizar música desde **YouTube** y **Spotify** directamente con el perfil y almacenamiento del chat grupal en Supabase y Cloudflare R2.

### ✨ Novedades en la Versión 1.6.1
1. **🛡️ Corrección Crítica de Redirect URI**:
   - Corrección del fallo donde Spotify redirigía al chat de GitHub Pages (`github.io`) en lugar de al servidor local `/api/spotify/callback`.
   - Normalización automática de URIs para procesar los tokens de forma segura e independiente por perfil.
2. **📱 Código QR con IP Wi-Fi Real**:
   - Detección precisa de la interfaz de red física (`192.168.50.249`) descartando adaptadores virtuales y APIPA (`169.254.x.x`).
   - El escaneo desde el celular móvil ya no marca 404 y conecta directamente al servidor.
3. **🟢 Spotify Personal Multi-Perfil**:
   - Cada perfil de usuario (ej. `Marko`) conecta su **propia cuenta personal de Spotify** sin compartir ni mezclar sus canciones con otros perfiles.
4. **💻 Botón Directo para PC**:
   - Autenticación instantánea en el navegador de la computadora con 1 clic mediante `btnSpotifyAuth`.

---

## ⚙️ Configuración Obligatoria en Spotify Developer

Para que Spotify permita la conexión sin errores, ve a [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard):
1. Abre tu App y ve a **Settings**.
2. En la sección **Redirect URIs**, agrega estas dos direcciones exactas:
   ```text
   http://localhost:3000/api/spotify/callback
   http://192.168.50.249:3000/api/spotify/callback
   ```
3. Guarda los cambios (**Save**).
*(Nota: No pongas la URL de `github.io` en este campo, ya que Spotify necesita llamar a este servidor para procesar tus listas).*

---

## 🚀 Cómo Iniciar el Servidor

```powershell
npm start
```
Abre en tu navegador:
👉 **[http://localhost:3000](http://localhost:3000)**
Inicia sesión con **Marko** y haz clic en **"Iniciar Sesión en esta PC"** o escanea el QR desde tu celular.
