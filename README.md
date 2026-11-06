# Conversor YouTube y Spotify a MP3 - Supabase Chat

**Versión:** 1.6.0  
**Arquitectura:** Node.js (Express), yt-dlp, FFmpeg, Cloudflare R2, Supabase Auth/DB, Spotify Web API & Render.com  

---

## 🎯 Descripción General
Servicio integral y panel web moderno diseñado para sincronizar música desde **YouTube** y **Spotify** directamente con el perfil y almacenamiento del chat grupal en Supabase y Cloudflare R2.

### ✨ Novedades en la Versión 1.6.0
1. **🟢 Spotify Personal Multi-Perfil**:
   - Cada perfil de usuario (ej. `Marko` u otro usuario) conecta su **propia cuenta personal de Spotify** sin compartir ni mezclar sus canciones con otros perfiles.
   - Las sesiones de Spotify se guardan de forma aislada y persistente en el servidor indexadas por `userId`.
2. **📱 Vinculación Instantánea con Código QR**:
   - Generación automática de Código QR en pantalla.
   - El usuario escanea el QR desde su teléfono móvil y autoriza los permisos de Spotify en su celular.
   - La pantalla de la computadora detecta automáticamente la vinculación en tiempo real sin recargar la página.
3. **🛡️ Resiliencia de Puerto (Prevención de EADDRINUSE)**:
   - Manejador nativo del evento `error` en el servidor con diagnóstico claro si el puerto 3000 ya está ocupado por otra terminal.
4. **🚀 Preparado para Render.com**:
   - Soporte nativo para Linux/Windows, `render.yaml` y script automático de postinstall.

---

## 📱 ¿Cómo Conectar Spotify desde el Celular con QR?

1. En la aplicación web, inicia sesión con tu perfil (ej. **Marko**).
2. Ve a la pestaña **🟢 Mi Spotify**.
3. Verás en pantalla el **Código QR de Conexión Personal**.
4. Apunta con la cámara de tu teléfono móvil al QR.
5. Se abrirá la autorización de Spotify en tu celular: presiona **Aceptar**.
6. ¡Listo! La pantalla de tu computadora se conectará al instante y mostrará tus canciones y playlists.

---

## 💻 Solución al Error `listen EADDRINUSE: address already in use 0.0.0.0:3000`

Si al ejecutar `npm start` aparece este error en tu terminal:
```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3000
```
Significa que hay otra ventana o proceso de Node.js corriendo en segundo plano que no ha cerrado el puerto 3000.

**Para solucionarlo de inmediato en PowerShell:**
```powershell
Stop-Process -Name node -Force
npm start
```

---

## 📜 Historial de Versiones
- **v1.6.0**: Soporte de Spotify personal por perfil con Código QR para conexión desde el móvil, persistencia de sesiones de usuario y prevención de errores de puerto ocupado (`EADDRINUSE`).
- **v1.5.0**: Integración inicial con Spotify API (OAuth 2.0, Liked Songs, Playlists) y configuración de despliegue en Render.com (`render.yaml`).
- **v1.4.0**: Búsqueda extendida (hasta 40 resultados), barra flotante de pre-escucha interactiva y selector dinámico.
- **v1.3.0**: Mitigación de errores 403 de YouTube con `--js-runtimes node`, rotación de clientes y `safeFetchJson`.
- **v1.2.0**: Login idéntico al chat, soporte de playlists, modal comparador de nombres similares y gestión de álbumes.
- **v1.1.0**: Pipeline de conversión yt-dlp + FFmpeg con subida a R2 y registro en Supabase.
- **v1.0.0**: Inicialización y separación de módulos de base de datos y storage.
