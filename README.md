# Conversor de YouTube a MP3 y Uploader de Audio (v1.4.0)

Sistema en **Node.js** con arquitectura resiliente para buscar, escuchar vista previa antes de descargar, transcodificar videos y playlists de YouTube a **MP3 de alta fidelidad**, y subirlos al Storage (**Cloudflare R2**) de **Supabase Chat**.

---

## 🚀 Novedades de la Versión 1.4.0

1. **Búsqueda Extendida de Canciones (Más Resultados)**:
   - Se aumentó el límite de búsqueda a **25 resultados por defecto**, con selector dinámico para elegir **15, 25 o 40 resultados** por consulta.
   - Búsqueda ultra rápida en paralelo con `yt-dlp` en ~2 segundos.

2. **Pre-escucha Interactiva Antes de Descargar**:
   - Cada tarjeta de resultado incluye un botón **"▶ Probar"**.
   - Al presionarlo, se despliega una **barra de reproducción flotante** en la parte inferior de la pantalla donde puedes escuchar el audio/video original de inmediato para cerciorarte de que es exactamente la versión que deseas (en vivo, estudio, acústica, etc.) antes de iniciar la conversión y subida.
   - Permite pausar, adelantar o cerrar la barra sin interrumpir tu navegación por la lista de resultados.

3. **Mapeo Rápido a Conversión**:
   - Botón **"✔ Elegir"** que carga automáticamente la miniatura, canal, duración y título limpio en el formulario para asignarle álbum y convertirlo en 1 clic.

---

## 📁 Estructura del Proyecto

```text
├── bin/                 # Binarios locales de ejecución (yt-dlp.exe, ffmpeg.exe - excluidos de git)
├── js/                  # Módulos de conexión a Base de Datos y Storage
│   ├── auth.js          # Lógica de autenticación con Supabase
│   ├── config.js        # Configuración de URLs y credenciales públicas
│   └── media-api.js     # Cliente del Worker de Cloudflare R2 y firmado de URLs
├── public/              # Frontend web moderno v1.4.0
│   ├── app.js           # Lógica cliente con pre-escucha, búsqueda extendida y safeFetchJson
│   ├── index.html       # Interfaz visual con barra flotante de pre-escucha y selector de resultados
│   └── styles.css       # Estilos CSS con barra de previsualización flotante
├── temp_audio/          # Almacén de archivos temporales (limpieza automática)
├── chat_backup/         # Archivos originales del chat (excluidos de git)
├── server.js            # Servidor Express v1.4.0 con búsqueda extendida
├── uploader.html        # Uploader alternativo para archivos MP3 locales
├── package.json         # Dependencias y scripts de ejecución (v1.4.0)
└── .gitignore           # Reglas de exclusión de Git
```

---

## 🛠️ Ejecución del Servidor

Para aplicar los cambios:

```bash
npm start
```

Abre en tu navegador:
**`http://localhost:3000`**
