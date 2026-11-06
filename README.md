# Conversor de YouTube a MP3 y Uploader de Audio (v1.2.0)

Sistema integral en **Node.js** para descargar, transcodificar videos y listas de reproducción de YouTube a **MP3 de alta fidelidad**, subirlos al Storage (**Cloudflare R2**) de **Supabase Chat**, con deduplicación por hash SHA-256, comparador de canciones similares y organización por álbumes idéntica al chat original.

---

## 🚀 Novedades de la Versión 1.2.0

1. **Pantalla de Bloqueo y Login Idéntica al Chat**:
   - Mismo diseño visual oscuro (`lock-box`, inputs centrados y redondeados, botón verde `#3ecf8e`).
   - Soporte para inicio de sesión y registro de nuevas cuentas personales mediante Supabase Auth.
   - Pestaña de invitados eliminada completamente.
   - Botón `▾` para autocompletar usuarios existentes desde la tabla `profiles`.

2. **Buscador de Canciones en YouTube Integrado**:
   - Permite buscar directamente canciones por título o artista sin necesidad de abrir YouTube externamente.
   - Muestra resultados interactivos con miniatura, canal, duración y botón para seleccionar en 1 clic.

3. **Soporte para Playlists (Listas de Reproducción)**:
   - Detecta automáticamente si un enlace corresponde a una lista de YouTube.
   - Lista todas las canciones con checkboxes de selección y preasigna el nombre de la playlist como Álbum.
   - Procesa y sube todas las canciones de la lista en cola automática.

4. **Comparación Inteligente de Canciones Similares**:
   - Analiza el título de la canción contra tu biblioteca antes de subirla (ej. detecta si vas a subir *"Lagrimas Negras"* teniendo ya *"Lagrimas Negras - Black Winter Rock (192k)"*).
   - Abre un **Modal de Comparación Visual** con los datos de ambas canciones, reproductor para escuchar la que ya tienes y opciones para:
     - Subir de todos modos.
     - Cambiar de nombre.
     - Cancelar la subida.

5. **Vista de Canciones Separadas por Álbum (Idéntica al Chat Original)**:
   - Acordeones colapsables para cada álbum (`💿 [Nombre Álbum]` y `📁 Sin álbum`).
   - Botones globales para "Desplegar todo" y "Colapsar todo".
   - Filtro buscador en tiempo real para encontrar canciones al instante en tu biblioteca.

6. **Eliminación de Canciones**:
   - Botón `🗑️` en cada canción con confirmación visual de eliminación inmediata en Supabase.

---

## 📁 Estructura del Proyecto

```text
├── bin/                 # Binarios locales de ejecución (yt-dlp.exe, ffmpeg.exe - excluidos de git)
├── js/                  # Módulos de conexión a Base de Datos y Storage
│   ├── auth.js          # Lógica de autenticación con Supabase
│   ├── config.js        # Configuración de URLs y credenciales públicas
│   └── media-api.js     # Cliente del Worker de Cloudflare R2 y firmado de URLs
├── public/              # Frontend web moderno v1.2.0
│   ├── app.js           # Lógica cliente, buscador, comparador y álbumes
│   ├── index.html       # Interfaz visual con login original del chat y acordeones
│   └── styles.css       # Estilos CSS idénticos al chat original
├── temp_audio/          # Almacén de archivos temporales (limpieza automática)
├── chat_backup/         # Archivos originales del chat (excluidos de git)
├── server.js            # Servidor Express v1.2.0 con endpoints de búsqueda y playlists
├── uploader.html        # Uploader alternativo para archivos MP3 locales
├── package.json         # Dependencias y scripts de ejecución (v1.2.0)
└── .gitignore           # Reglas de exclusión de Git
```

---

## 🛠️ Ejecución del Servidor

```bash
npm start
```

Abre en tu navegador:
**`http://localhost:3000`**
