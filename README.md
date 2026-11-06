# Conversor de YouTube a MP3 y Uploader de Audio (v1.3.0)

Sistema en **Node.js** con arquitectura resiliente para descargar, transcodificar videos y playlists de YouTube a **MP3 de alta fidelidad**, subirlos al Storage (**Cloudflare R2**) de **Supabase Chat**, con deduplicación por hash SHA-256, comparador de canciones similares y organización por álbumes idéntica al chat original.

---

## 🚀 Novedades de la Versión 1.3.0

1. **Resolución de Advertencia de JS Runtime en YouTube**:
   - Se configuró `--js-runtimes node` para que `yt-dlp` utilice el motor de Node.js instalado en el sistema para descifrar n-tokens y firmas de JavaScript de YouTube, eliminando la advertencia *"No supported JavaScript runtime could be found"*.

2. **Pipeline de Reintentos Automáticos ante Error 403 Forbidden**:
   - En lugar de fallar al primer intento, el servidor ejecuta un bucle de **3 intentos automáticos** con retroceso exponencial (backoff) y **rotación de clientes de YouTube** (`android,web` ➔ `web,android` ➔ `mweb`).
   - Si un formato o cliente es bloqueado temporalmente por YouTube con 403, el siguiente intento conmuta de cliente automáticamente sin requerir que el usuario vuelva a presionar el botón.

3. **Protección contra Errores de Respuesta HTML (`safeFetchJson`)**:
   - Se implementó `safeFetchJson()` en el cliente frontend. Ahora analiza el `Content-Type` antes de parsear, erradicando por completo el fallo `Unexpected token '<', "<!DOCTYPE "...`.
   - Se añadió un manejador global en Express para que cualquier ruta responda siempre en formato JSON.

---

## 📁 Estructura del Proyecto

```text
├── bin/                 # Binarios locales de ejecución (yt-dlp.exe, ffmpeg.exe - excluidos de git)
├── js/                  # Módulos de conexión a Base de Datos y Storage
│   ├── auth.js          # Lógica de autenticación con Supabase
│   ├── config.js        # Configuración de URLs y credenciales públicas
│   └── media-api.js     # Cliente del Worker de Cloudflare R2 y firmado de URLs
├── public/              # Frontend web moderno v1.3.0
│   ├── app.js           # Lógica cliente con safeFetchJson, buscador, comparador y álbumes
│   ├── index.html       # Interfaz visual con login original del chat y acordeones
│   └── styles.css       # Estilos CSS idénticos al chat original
├── temp_audio/          # Almacén de archivos temporales (limpieza automática)
├── chat_backup/         # Archivos originales del chat (excluidos de git)
├── server.js            # Servidor Express v1.3.0 con retry loop y soporte JS runtime
├── uploader.html        # Uploader alternativo para archivos MP3 locales
├── package.json         # Dependencias y scripts de ejecución (v1.3.0)
└── .gitignore           # Reglas de exclusión de Git
```

---

## 🛠️ Ejecución del Servidor

Para aplicar los cambios en el servidor:

```bash
npm start
```

Abre en tu navegador:
**`http://localhost:3000`**
