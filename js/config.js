// js/config.js
const SUPABASE_URL = "https://avdklsfhaoznpzqlxapc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF2ZGtsc2ZoYW96bnB6cWx4YXBjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM4OTc2MTgsImV4cCI6MjEwOTQ3MzYxOH0.8piH_mC0qvfyka3Vrcc00Ij6DLSZxPFRuwkg5HkX9-Y";

// Inicialización única de la instancia global de Supabase.
// persistSession: false y autoRefreshToken: false hacen que la sesión NUNCA
// se guarde en el navegador (localStorage). Esto significa que al recargar
// la página, cerrar la pestaña o el navegador, la sesión desaparece y
// siempre habrá que volver a iniciar sesión con la contraseña.
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: false,
        autoRefreshToken: false
    }
});

// Correo interno fijo para el login del chat (no es secreto, es solo un
// identificador). Debes crear UNA cuenta con este correo exacto en tu panel
// de Supabase (Authentication > Users), con la contraseña que tú quieras.
// Cuando más adelante quieras chats privados con varias personas, aquí se
// puede volver a agregar un campo de correo real en vez de este valor fijo.
const CHAT_LOGIN_EMAIL = "chat@tuapp.com";

// Clave de la API pública de Giphy, usada por js/media-picker.js para buscar
// GIFs. Consigue una gratis en https://developers.giphy.com/ (plan "Free" /
// "Chat & Messaging") y pégala aquí. Sin una clave válida, la pestaña de
// GIFs mostrará un error al buscar (emojis y stickers funcionan igual).
const GIPHY_API_KEY = "https://developers.giphy.com";

// URL del Worker de Cloudflare que guarda y sirve audio/video en R2
// (ver cloudflare-worker/worker.js y LEEME_R2.md). Pega aquí la URL que te
// da Cloudflare al crear el Worker, SIN barra final.
const MEDIA_API_URL = "https://chat-media.latamdia4.workers.dev";


// Referencias a los elementos del DOM (chat)
const chatContainer = document.getElementById('chatContainer');
const messagesContainer = document.getElementById('chatMessages');
const form = document.getElementById('chatForm');
const fileInput = document.getElementById('fileInput');
const msgInput = document.getElementById('msgInput');
const previewContainer = document.getElementById('previewContainer');
const sendBtn = document.getElementById('sendBtn');
const guestLoginBtn = document.getElementById('guestLoginBtn');
const themeToggle = document.getElementById('themeToggle');
const adminToggle = document.getElementById('adminToggle');
const adminResetPwBtn = document.getElementById('adminResetPwBtn');
const hideChatBtn = document.getElementById('hideChatBtn');
const dimToggleBtn = document.getElementById('dimToggleBtn');
const dimIntensitySlider = document.getElementById('dimIntensitySlider');
const loadMoreBar = document.getElementById('loadMoreBar');
const prevTrackBtn = document.getElementById('prevTrackBtn');
const nextTrackBtn = document.getElementById('nextTrackBtn');
const shuffleBtn = document.getElementById('shuffleBtn');
const repeatBtn = document.getElementById('repeatBtn');
const musicProgressBar = document.getElementById('musicProgressBar');
const progressSlider = document.getElementById('progressSlider');
const progressCurrentTime = document.getElementById('progressCurrentTime');
const progressDuration = document.getElementById('progressDuration');

// Referencias a los elementos del DOM (bloqueo por contraseña)
const lockOverlay = document.getElementById('lockOverlay');
const lockPasswordInput = document.getElementById('lockPasswordInput');
const lockSubmitBtn = document.getElementById('lockSubmitBtn');
const lockError = document.getElementById('lockError');

// Referencias a los elementos del DOM (pestañas Invitado / Mi cuenta / Registro)
const lockTabGuest = document.getElementById('lockTabGuest');
const lockTabAccount = document.getElementById('lockTabAccount');
const accountForm = document.getElementById('accountForm');
const accountUsernameInput = document.getElementById('accountUsernameInput');
const accountPasswordInput = document.getElementById('accountPasswordInput');
const accountLoginBtn = document.getElementById('accountLoginBtn');
const showRegisterLink = document.getElementById('showRegisterLink');
const registerForm = document.getElementById('registerForm');
const registerUsernameInput = document.getElementById('registerUsernameInput');
const registerPasswordInput = document.getElementById('registerPasswordInput');
const registerBtn = document.getElementById('registerBtn');
const showLoginLink = document.getElementById('showLoginLink');

// Referencias a los elementos del DOM (radio / música)
const musicToggle = document.getElementById('musicToggle');
const musicPanel = document.getElementById('musicPanel');
const musicPlayerBar = document.getElementById('musicPlayerBar');
const musicInput = document.getElementById('musicInput');
const searchMusicBtn = document.getElementById('searchMusicBtn');
const radioResults = document.getElementById('radioResults');
const tabRadio = document.getElementById('tabRadio');
const tabShared = document.getElementById('tabShared');
const tabUploads = document.getElementById('tabUploads');
const musicSearchRow = document.getElementById('musicSearchRow');
const musicUploadRow = document.getElementById('musicUploadRow');
const uploadMusicInput = document.getElementById('uploadMusicInput');
const musicHint = document.getElementById('musicHint');
const currentTrackTitle = document.getElementById('currentTrackTitle');
const currentTrackTitleInner = document.getElementById('currentTrackTitleInner');
const albumInput = document.getElementById('albumInput');
const albumSuggestions = document.getElementById('albumSuggestions');
const audioPlayer = document.getElementById('audioPlayer');
const playPauseBtn = document.getElementById('playPauseBtn');
const volumeSlider = document.getElementById('volumeSlider');
const muteBtn = document.getElementById('muteBtn');

// Referencias a los elementos del DOM (panel de emojis / stickers / GIFs)
const emojiToggle = document.getElementById('emojiToggle');
const mediaPanel = document.getElementById('mediaPanel');
const tabEmoji = document.getElementById('tabEmoji');
const tabSticker = document.getElementById('tabSticker');
const tabGif = document.getElementById('tabGif');
const gifSearchRow = document.getElementById('gifSearchRow');
const gifInput = document.getElementById('gifInput');
const searchGifBtn = document.getElementById('searchGifBtn');
const mediaGrid = document.getElementById('mediaGrid');

// Referencias a los elementos del DOM (lightbox)
const lightboxModal = document.getElementById('lightboxModal');
const lightboxImg = document.getElementById('lightboxImg');
const lightboxClose = document.getElementById('lightboxClose');

// Referencias a los elementos del DOM (mensajes privados 1 a 1)
const dmToggle = document.getElementById('dmToggle');
const dmPanel = document.getElementById('dmPanel');
const dmBackBtn = document.getElementById('dmBackBtn');
const dmTitle = document.getElementById('dmTitle');
const dmCloseBtn = document.getElementById('dmCloseBtn');
const dmListView = document.getElementById('dmListView');
const dmSearchInput = document.getElementById('dmSearchInput');
const dmSearchBtn = document.getElementById('dmSearchBtn');
const dmResults = document.getElementById('dmResults');
const dmConversations = document.getElementById('dmConversations');
const dmChatView = document.getElementById('dmChatView');
const dmMessages = document.getElementById('dmMessages');
const dmMsgInput = document.getElementById('dmMsgInput');
const dmSendBtn = document.getElementById('dmSendBtn');

// Variables de estado del Chat y Sesión
const mySessionId = Math.random().toString(36).substring(2, 9);
let queueFiles = [];
let isAdmin = false;

// true = solo puede ver el chat (login con la contraseña compartida de invitado);
// false = inició sesión con su propia cuenta (usuario+contraseña) y puede chatear.
let isGuest = true;
let myUsername = null;

// isAdmin (arriba en config.js original) es SOLO cosmético (contraseña local,
// ver passwords.js) — permite ocultar mensajes del chat general, que ya era
// semi-público. myIsRealAdmin es la marca REAL en la base de datos
// (profiles.is_admin), verificada por RLS en el servidor; solo esta habilita
// ver los DMs de otros usuarios y resetear contraseñas.
let myIsRealAdmin = false;

// Variables de estado para el Zoom de Imágenes
let zoomScale = 1;
let isDragging = false;
let startX, startY, translateX = 0, translateY = 0;
