# Conversor de YouTube a MP3 y Uploader de Audio (v1.1.0)

Sistema en **Node.js** para descargar, transcodificar videos de YouTube a **MP3 de alta fidelidad** y subirlos directamente al Storage (Cloudflare R2) de **Supabase Chat**, vinculándolos al perfil del usuario autenticado y gestionando sus álbumes.

---

## 🚀 Características Principales

- **Autenticación Integrada con Supabase Chat**: Inicio de sesión idéntico al chat y `uploader.html`, con selector dinámico de usuarios desde la tabla `profiles` y validación de contraseñas seguras.
- **Transcodificación a MP3 de Alto Rendimiento**: Emplea binarios locales optimizados de `yt-dlp` y `FFmpeg` para extraer el mejor stream de audio y codificar en MP3 sin depender de servicios externos de terceros.
- **Deduplicación Inteligente por Hash SHA-256**: Calcula el hash de cada archivo generado y consulta el procedimiento RPC `find_active_track_by_hash` de Supabase para evitar subidas duplicadas y optimizar almacenamiento y ancho de banda en Cloudflare R2.
- **Gestión Dinámica de Álbumes**: Crea álbumes nuevos en tu perfil o asocia canciones a álbumes existentes con autocompletado en tiempo real.
- **Reproductor de Audio Integrado**: Permite escuchar las canciones recién subidas directamente desde la interfaz mediante URLs firmadas temporales.
- **Arquitectura Limpia**: Separación estricta entre la lógica de conexión a la Base de Datos / Storage y el backend del conversor.

---

## 📁 Estructura del Proyecto

```text
├── bin/                 # Binarios locales de ejecución (yt-dlp.exe, ffmpeg.exe - excluidos de git)
├── js/                  # Módulos de conexión a Base de Datos y Storage
│   ├── auth.js          # Lógica de autenticación con Supabase
│   ├── config.js        # Configuración de URLs y credenciales públicas
│   └── media-api.js     # Cliente del Worker de Cloudflare R2 y firmado de URLs
├── public/              # Frontend web moderno en modo oscuro
│   ├── app.js           # Lógica cliente y orquestación con la API
│   ├── index.html       # Interfaz visual de conversión y gestión
│   └── styles.css       # Estilos CSS responsivos
├── temp_audio/          # Almacén de archivos temporales (limpieza automática)
├── chat_backup/         # Archivos originales del chat (excluidos de git)
├── server.js            # Servidor Express y pipeline de conversión
├── uploader.html        # Uploader alternativo para archivos MP3 locales
├── package.json         # Dependencias y scripts de ejecución (v1.1.0)
└── .gitignore           # Reglas de exclusión de Git
```

---

## 🛠️ Ejecución del Servidor

1. Instalar dependencias (si no se han instalado):
   ```bash
   npm install
   ```

2. Iniciar el servidor:
   ```bash
   npm start
   ```

3. Abrir en el navegador:
   ```text
   http://localhost:3000
   ```
