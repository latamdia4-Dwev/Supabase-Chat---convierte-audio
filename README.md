# Conversor YouTube y Spotify a MP3 - Supabase Chat

**Versión:** 1.7.0  
**Arquitectura:** Node.js (Express), yt-dlp, FFmpeg, Cloudflare R2, Supabase Auth/DB, Spotify Web API & Render.com  

---

## 🎯 Descripción General
Servicio integral y panel web moderno diseñado para sincronizar música desde **YouTube** y **Spotify** directamente con el perfil y almacenamiento del chat grupal en Supabase y Cloudflare R2.

### ✨ Novedades en la Versión 1.7.0
1. **🔒 Spotify Exclusivo para Marko y Administradores**:
   - La pestaña y los módulos de Spotify solo se muestran y están disponibles cuando se inicia sesión como **Marko** o con un usuario administrador (`is_admin === true`).
   - Para todos los demás usuarios, la pestaña de Spotify permanece totalmente oculta e inaccesible (protección tanto en interfaz como a nivel de endpoints backend con `403 Forbidden`).
2. **🛡️ Privacidad en el Inicio de Sesión**:
   - El selector desplegable de usuarios (`▾`) en la pantalla de login filtra y oculta los nombres de los demás usuarios del chat, mostrando únicamente a **Marko** y administradores.
3. **📱 Código QR con IP Wi-Fi Real (`192.168.50.249`)**:
   - Detección precisa de la interfaz de red física descartando adaptadores virtuales y APIPA (`169.254.x.x`).
4. **⚙️ Corrección de Redirect URI**:
   - Prevención de desvíos hacia GitHub Pages (`github.io`).

---

## ⚙️ Configuración Obligatoria en Spotify Developer

En [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), en los **Settings** de tu App:
1. En **Redirect URIs**, asegúrate de tener:
   ```text
   http://localhost:3000/api/spotify/callback
   http://192.168.50.249:3000/api/spotify/callback
   ```
2. Guarda los cambios (**Save**).

---

## 🚀 Cómo Iniciar el Servidor

```powershell
npm start
```
Abre en tu navegador:
👉 **[http://localhost:3000](http://localhost:3000)**
Inicia sesión con tu cuenta **Marko** y verás la pestaña **🟢 Mi Spotify** lista para conectar con 1 clic en PC o con Código QR desde tu celular.
