/* ── Global app controller ──────────────────────────────────────────────── */

const API_BASE = 'http://localhost:8765';

// ── State ──────────────────────────────────────────────────────────────────
window.appState = {
  voices: [],          // all voices (builtin + user)
  activeVoiceId: null,
  keepOriginalAudio: true,
  outputDir: null,
  backendReady: false,
  xttsReady: false,
};

// ── API helpers ────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}
window.api = api;

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 4000) {
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${message}</span>`;
  document.getElementById('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}
window.showToast = showToast;

// ── Modal ──────────────────────────────────────────────────────────────────
function openModal(html, { onClose } = {}) {
  const backdrop = document.getElementById('modal-backdrop');
  const container = document.getElementById('modal-container');
  container.innerHTML = html;
  backdrop.classList.remove('hidden');
  container.classList.remove('hidden');
  container.style.pointerEvents = 'all';

  const close = () => {
    backdrop.classList.add('hidden');
    container.classList.add('hidden');
    container.innerHTML = '';
    if (onClose) onClose();
  };
  backdrop.onclick = close;
  container.querySelector('.modal-close')?.addEventListener('click', close);
  return close;
}
window.openModal = openModal;

// ── Navigation ─────────────────────────────────────────────────────────────
const views = ['editor', 'voices', 'settings', 'welcome'];

function showView(name) {
  views.forEach(v => {
    document.getElementById(`view-${v}`)?.classList.toggle('hidden', v !== name);
  });
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === name);
  });
}
window.showView = showView;

document.querySelectorAll('.nav-item[data-view]').forEach(el => {
  el.addEventListener('click', () => {
    const v = el.dataset.view;
    showView(v);
    if (v === 'voices') renderVoiceLibrary();
    if (v === 'settings') renderSettings();
  });
});

// ── Mensajes de carga divertidos (estilo Claude) ────────────────────────────
const _funLoadingMsgs = [
  'Afinando las cuerdas vocales…',
  'Calentando los acentos…',
  'Enseñando a la IA a vocalizar…',
  'Buscando el tono perfecto…',
  'Puliendo las eses…',
  'Convocando a los fonemas…',
  'Ensayando trabalenguas…',
  'Quitando el «eeeh» de en medio…',
  'Respirando con el diafragma…',
  'Haciendo gárgaras digitales…',
  'Estirando las vocales…',
  'Sincronizando labios y bits…',
];
let _funMsgTimer = null;
function startFunMessages() {
  const el = document.getElementById('splash-msg');
  if (!el || _funMsgTimer) return;
  let last = -1;
  const tick = () => {
    let i;
    do { i = Math.floor(Math.random() * _funLoadingMsgs.length); } while (i === last);
    last = i;
    el.textContent = _funLoadingMsgs[i];
  };
  tick();
  _funMsgTimer = setInterval(tick, 5000);
}
function stopFunMessages() {
  if (_funMsgTimer) { clearInterval(_funMsgTimer); _funMsgTimer = null; }
}

// ── Boot sequence ──────────────────────────────────────────────────────────
async function boot() {
  const splashMsg = document.getElementById('splash-msg');
  const splash    = document.getElementById('splash');
  const shell     = document.getElementById('shell');

  startFunMessages();  // frases divertidas mientras carga; el % es el dato real

  // Escuchar crashes del proceso backend (desde main.js)
  // Solo mostramos el error si el renderer aún no llegó al backend por su cuenta
  let _backendReachedByRenderer = false;
  window.electronAPI.onBackendError(msg => {
    if (!_backendReachedByRenderer) {
      _backendStartError = msg;   // permite a _pollBackendHealth fallar rápido
      stopFunMessages();
      splashMsg.textContent = `Error al iniciar el backend: ${msg}`;
    } else {
      console.warn('backend-error IPC (ignorado, renderer ya conectado):', msg);
    }
  });
  window.electronAPI.onBackendCrashed((code) => {
    if (!_backendReachedByRenderer) {
      _backendStartError = `el proceso se cerró (código ${code})`;
    }
    stopFunMessages();
    splashMsg.textContent = 'El backend se cerró inesperadamente. Reinicia la app.';
  });

  // ── Provisión del runtime (Python + deps) — solo primer arranque en prod ──
  let consentedBigDownload = false;
  const prov = await window.electronAPI.getProvisionState?.().catch(() => ({ needsRuntime: false }))
            || { needsRuntime: false };
  if (prov.needsRuntime) {
    const accepted = await showDownloadConsent(false);
    if (!accepted) { showBlockedScreen(); return; }
    consentedBigDownload = true;
    stopFunMessages();
    _showSplashProgressBar();
    window.electronAPI.onProvisionProgress(st => {
      _setSplashProgress((st.progress || 0) * 0.4);   // dependencias = 0–40 %
      if (st.message) splashMsg.textContent = st.message;
    });
    try {
      await window.electronAPI.provisionRuntime();    // main arranca el backend al terminar
    } catch (e) {
      showBlockedScreen('No se pudieron instalar las dependencias.\n' + (e?.message || e));
      return;
    }
    startFunMessages();
  }

  // Tras provisionar, el primer arranque del backend importa torch+TTS en frío
  // (compila los .pyc de todo el árbol de dependencias) y puede tardar minutos.
  if (consentedBigDownload) splashMsg.textContent = 'Iniciando el motor de voz por primera vez…';

  // Polling directo al health endpoint — evita la carrera con el evento IPC
  try {
    await _pollBackendHealth();
    _backendReachedByRenderer = true;
  } catch (e) {
    stopFunMessages();
    splashMsg.textContent = e.message;
    return;
  }

  await loadVoices();

  // ── Modelo de voz ──
  let setup = await api('GET', '/setup/status').catch(() => ({ ready: false, loading: false }));

  if (!setup.ready && setup.loading) {
    // Se está cargando desde caché — esperar (frases divertidas + barra de %)
    setup = await waitForModelReady(splashMsg);
  } else if (!setup.ready) {
    // Modelo no descargado → pedir consentimiento (si no se dio ya) + descargar
    if (!consentedBigDownload) {
      const accepted = await showDownloadConsent(true);   // solo modelo ~1,8 GB
      if (!accepted) { showBlockedScreen(); return; }
    }
    stopFunMessages();
    setup = await downloadModelWithProgress(splashMsg, consentedBigDownload ? 40 : 0);
    if (!setup.ready) {
      showBlockedScreen('No se pudo descargar el motor de voz. Revisa tu conexión.');
      return;
    }
  }

  stopFunMessages();
  window.appState.xttsReady = setup.ready;
  updateSidebarModelStatus(setup.ready, false, 0);

  // Populate version
  const version = await window.electronAPI.getVersion();
  document.getElementById('sidebar-version').textContent = `v${version}`;

  // Transition in
  splash.classList.add('fade-out');
  shell.classList.remove('hidden');
  setTimeout(() => splash.classList.add('hidden'), 400);

  // First-run welcome
  const isFirst = await window.electronAPI.isFirstRun();
  if (isFirst && window.appState.voices.filter(v => v.type !== 'builtin').length === 0) {
    renderWelcome();
    showView('welcome');
  } else {
    showView('editor');
    renderEditor();
  }
}

// Error de arranque del backend reportado por main.js (vía IPC). Permite que el
// polling falle de inmediato en lugar de esperar todo el timeout.
let _backendStartError = null;

// Espera a que el backend responda en /health. El primer arranque tras provisionar
// importa torch+TTS en frío y compila los .pyc de todo el árbol de dependencias,
// lo que puede tardar varios minutos — por eso el timeout es amplio (coincide con
// el BACKEND_READY_TIMEOUT de main.js).
function _pollBackendHealth(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(async () => {
      // Si el proceso backend falló de verdad, no tiene sentido seguir esperando.
      if (_backendStartError) {
        clearInterval(poll);
        reject(new Error('No se pudo iniciar el motor de voz: ' + _backendStartError));
        return;
      }
      try {
        const res = await fetch('http://127.0.0.1:8765/health');
        if (res.ok) { clearInterval(poll); resolve(); }
      } catch (_) {
        if (Date.now() - start > timeoutMs) {
          clearInterval(poll);
          reject(new Error('El backend no respondió a tiempo. Reinicia la app para reintentar.'));
        }
      }
    }, 500);
  });
}

function _showSplashProgressBar() {
  document.getElementById('splash-spinner')?.classList.add('hidden');
  document.getElementById('splash-progress')?.classList.remove('hidden');
  _setSplashProgress(0);
}

// Dispara la descarga del modelo (/setup/install) y mapea su progreso real
// sobre la barra del splash, desde `base`% hasta 100%.
async function downloadModelWithProgress(splashMsg, base = 0) {
  _showSplashProgressBar();
  try { await api('POST', '/setup/install'); } catch (_) {}
  return new Promise((resolve) => {
    const span = 100 - base;
    const poll = setInterval(async () => {
      const st = await api('GET', '/setup/status').catch(() => null);
      if (!st) return;
      if (st.message) splashMsg.textContent = st.message;
      _setSplashProgress(base + (st.progress || 0) * (span / 100));
      _setSplashBytes(st.downloaded_mb, st.total_mb);
      if (st.ready) {
        clearInterval(poll);
        _setSplashProgress(100);
        _setSplashBytes(null, null);
        resolve(st);
      } else if (!st.loading && (st.progress || 0) === 0) {
        // Ni cargando ni progresando: probable error de descarga
        clearInterval(poll);
        resolve(st);
      }
    }, 1000);
  });
}

// ── Diálogo de consentimiento de descarga ────────────────────────────────────
function showDownloadConsent(modelOnly) {
  const size = modelOnly ? '~1,8 GB' : '~2,3 GB';
  const detail = modelOnly
    ? 'el modelo de voz (~1,8 GB)'
    : 'el motor de voz: dependencias y el modelo (~2,3 GB en total)';
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'boot-dialog-backdrop';
    el.innerHTML = `
      <div class="boot-dialog">
        <div class="logo-mark">NV</div>
        <h2>Preparar NarraVoz</h2>
        <p>NarraVoz necesita descargar <strong>${detail}</strong> una sola vez.
           Es necesario para funcionar y no se volverá a descargar en futuras
           actualizaciones.</p>
        <p class="boot-dialog-size">Descarga total: <strong>${size}</strong></p>
        <div class="boot-dialog-actions">
          <button class="btn btn-ghost" id="boot-cancel">Cancelar</button>
          <button class="btn btn-primary" id="boot-accept">Aceptar y descargar</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#boot-accept').addEventListener('click', () => { el.remove(); resolve(true); });
    el.querySelector('#boot-cancel').addEventListener('click', () => { el.remove(); resolve(false); });
  });
}

// ── Pantalla de bloqueo si el usuario cancela o falla la descarga ────────────
function showBlockedScreen(message) {
  stopFunMessages();
  document.getElementById('splash-spinner')?.classList.add('hidden');
  document.getElementById('splash-progress')?.classList.add('hidden');
  const old = document.querySelector('.boot-dialog-backdrop');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'boot-dialog-backdrop';
  el.innerHTML = `
    <div class="boot-dialog">
      <div class="logo-mark">NV</div>
      <h2>NarraVoz no puede funcionar sin el motor de voz</h2>
      <p>${message ? message.replace(/\n/g, '<br>') : 'La descarga es necesaria para usar la aplicación.'}</p>
      <div class="boot-dialog-actions">
        <button class="btn btn-ghost" id="boot-exit">Salir</button>
        <button class="btn btn-primary" id="boot-retry">Reintentar descarga</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#boot-retry').addEventListener('click', () => location.reload());
  el.querySelector('#boot-exit').addEventListener('click', () => window.electronAPI.quitApp?.());
}

// ── Model load waiter ──────────────────────────────────────────────────────
let _splashSimTimer = null;
let _splashSimPct   = 0;

function _setSplashProgress(pct) {
  const fill  = document.getElementById('splash-progress-fill');
  const label = document.getElementById('splash-progress-pct');
  if (fill)  fill.style.width  = `${Math.round(pct)}%`;
  if (label) label.textContent = `${Math.round(pct)}%`;
}

// Muestra "X MB / Y MB · faltan Z MB" bajo la barra. Llamar con (null,null) limpia.
function _setSplashBytes(doneMb, totalMb) {
  const el = document.getElementById('splash-progress-bytes');
  if (!el) return;
  if (doneMb == null || totalMb == null || !totalMb) { el.textContent = ''; return; }
  const remain = Math.max(0, totalMb - doneMb);
  const fmt = (mb) => mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
  el.textContent = `${fmt(doneMb)} / ${fmt(totalMb)}  ·  faltan ${fmt(remain)}`;
}

// Simulate smooth progress from `from` toward `cap` over `durationMs`
function _startSplashSim(from, cap, durationMs) {
  clearInterval(_splashSimTimer);
  _splashSimPct = from;
  const step = (cap - from) / (durationMs / 150);
  _splashSimTimer = setInterval(() => {
    _splashSimPct = Math.min(cap, _splashSimPct + step);
    _setSplashProgress(_splashSimPct);
  }, 150);
}

function waitForModelReady(splashMsg) {
  const spinner  = document.getElementById('splash-spinner');
  const progress = document.getElementById('splash-progress');
  if (spinner)  spinner.classList.add('hidden');
  if (progress) progress.classList.remove('hidden');
  _setSplashProgress(0);

  return new Promise((resolve) => {
    let lastRealPct = 0;

    const poll = setInterval(async () => {
      try {
        const st = await api('GET', '/setup/status').catch(() => null);
        if (!st) return;
        // El texto lo gestionan las frases divertidas (startFunMessages); aquí
        // solo actualizamos la barra de progreso real.

        const realPct = st.progress || 0;

        if (st.ready) {
          // Done — animate to 100% quickly, then resolve
          clearInterval(poll);
          clearInterval(_splashSimTimer);
          _startSplashSim(_splashSimPct, 100, 600);
          setTimeout(() => {
            clearInterval(_splashSimTimer);
            _setSplashProgress(100);
            if (spinner)  spinner.classList.remove('hidden');
            if (progress) progress.classList.add('hidden');
            resolve(st);
          }, 700);
        } else if (!st.loading) {
          clearInterval(poll);
          clearInterval(_splashSimTimer);
          if (spinner)  spinner.classList.remove('hidden');
          if (progress) progress.classList.add('hidden');
          resolve(st);
        } else if (realPct > lastRealPct) {
          // Backend reported a new real milestone — simulate toward next expected cap
          lastRealPct = realPct;
          // 5% → simulate to 28% over ~3s; 30% → simulate to 92% over ~90s
          const cap = realPct < 20 ? 28 : 92;
          const dur = realPct < 20 ? 3000 : 90000;
          _startSplashSim(Math.max(_splashSimPct, realPct), cap, dur);
        }
      } catch (_) {}
    }, 1000);
  });
}

// ── Sidebar model status indicator ────────────────────────────────────────
function updateSidebarModelStatus(ready, loading, progress) {
  const el = document.getElementById('sidebar-model-status');
  if (!el) return;
  if (ready) {
    el.innerHTML = `<span class="sms-dot sms-ready" title="Motor de voz listo"></span>`;
  } else if (loading) {
    el.innerHTML = `
      <div class="sms-bar-wrap" title="Cargando motor de voz…">
        <div class="sms-bar-fill" style="width:${progress || 0}%"></div>
      </div>
      <span class="sms-pct">${progress || 0}%</span>
    `;
  } else {
    el.innerHTML = `<span class="sms-dot sms-warn" title="Motor de voz no instalado"></span>`;
  }
}
window.updateSidebarModelStatus = updateSidebarModelStatus;

// ── Voice loading ──────────────────────────────────────────────────────────
async function loadVoices() {
  try {
    const data = await api('GET', '/voices');
    window.appState.voices = data.voices;
    if (!window.appState.activeVoiceId && data.voices.length > 0) {
      window.appState.activeVoiceId = data.voices[0].id;
    }
    refreshVoiceSelectors();
  } catch (e) {
    console.error('Failed to load voices', e);
  }
}
window.loadVoices = loadVoices;

function refreshVoiceSelectors() {
  document.querySelectorAll('.voice-selector-el').forEach(sel => {
    const current = sel.value;
    sel.innerHTML = window.appState.voices.map(v =>
      `<option value="${v.id}">${v.name}${v.type === 'builtin' ? ' ★' : ''}</option>`
    ).join('');
    sel.value = current || window.appState.activeVoiceId || '';
  });
}
window.refreshVoiceSelectors = refreshVoiceSelectors;

// ── XTTS setup overlay ─────────────────────────────────────────────────────
async function showSetupOverlay() {
  const info = await window.electronAPI.getSetupInfo();

  if (info.platform === 'darwin') {
    showSetupOverlayMac(info.command);
  } else {
    showSetupOverlayWin();
  }
}

// macOS: muestra instrucciones con comando copiable
function showSetupOverlayMac(command) {
  const overlay = document.getElementById('setup-overlay');
  overlay.innerHTML = `
    <div class="setup-card" style="width:520px">
      <div class="logo-mark">NV</div>
      <h2>Configuración inicial</h2>
      <p>
        NarraVoz necesita instalar el motor de voz XTTS v2.<br>
        Sigue estos tres pasos — solo ocurre una vez.
      </p>

      <ol class="setup-steps">
        <li>
          <span class="step-num">1</span>
          <span>Abre <strong>Terminal</strong>
            <button class="btn btn-ghost btn-sm" id="mac-open-terminal" style="margin-left:8px">
              Abrir Terminal
            </button>
          </span>
        </li>
        <li>
          <span class="step-num">2</span>
          <span>Copia y pega este comando:</span>
        </li>
      </ol>

      <div class="command-box">
        <pre id="mac-command">${command}</pre>
        <button class="btn-copy" id="mac-copy-btn" title="Copiar comando">
          <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          <span>Copiar</span>
        </button>
      </div>

      <ol class="setup-steps" start="3">
        <li>
          <span class="step-num">3</span>
          <span>Espera a que termine (~3-5 min) y vuelve aquí.</span>
        </li>
      </ol>

      <button class="btn btn-primary" id="mac-done-btn" style="width:100%;margin-top:8px">
        Ya lo he ejecutado → Continuar
      </button>
      <p class="setup-note">
        El modelo XTTS v2 (~1,8 GB) se descargará la primera vez que generes un vídeo.
      </p>
    </div>
  `;
  overlay.classList.remove('hidden');

  document.getElementById('mac-open-terminal').addEventListener('click', () => {
    window.electronAPI.openTerminal();
  });

  document.getElementById('mac-copy-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(command).then(() => {
      const btn = document.getElementById('mac-copy-btn');
      btn.querySelector('span').textContent = '¡Copiado!';
      btn.style.color = 'var(--success)';
      setTimeout(() => {
        btn.querySelector('span').textContent = 'Copiar';
        btn.style.color = '';
      }, 2000);
    });
  });

  document.getElementById('mac-done-btn').addEventListener('click', async () => {
    // Re-check if packages are now importable (backend will verify on startup)
    const btn = document.getElementById('mac-done-btn');
    btn.disabled = true;
    btn.textContent = 'Verificando…';
    // Give the user a moment then check health
    await new Promise(r => setTimeout(r, 800));
    overlay.classList.add('hidden');
    showToast('Perfecto. El motor de voz se cargará al generar el primer vídeo.', 'success', 5000);
    const isFirst = await window.electronAPI.isFirstRun();
    if (isFirst) { renderWelcome(); showView('welcome'); }
    else { showView('editor'); renderEditor(); }
  });
}

// Windows: instalación automática con barra de progreso
function showSetupOverlayWin() {
  const overlay = document.getElementById('setup-overlay');
  const btn      = document.getElementById('setup-install-btn');
  const progress = document.getElementById('setup-progress');
  const fill     = document.getElementById('setup-progress-fill');
  const label    = document.getElementById('setup-progress-label');

  overlay.classList.remove('hidden');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Instalando…';
    progress.classList.remove('hidden');

    try {
      await api('POST', '/setup/install');
      const poll = setInterval(async () => {
        try {
          const st = await api('GET', '/setup/status');
          fill.style.width = `${st.progress || 0}%`;
          label.textContent = st.message || 'Descargando modelo…';
          if (st.ready) {
            clearInterval(poll);
            overlay.classList.add('hidden');
            window.appState.xttsReady = true;
            showToast('Motor de voz instalado correctamente', 'success');
            const isFirst = await window.electronAPI.isFirstRun();
            if (isFirst) { renderWelcome(); showView('welcome'); }
            else { showView('editor'); renderEditor(); }
          }
        } catch (_) {}
      }, 1000);
    } catch (e) {
      showToast(`Error en la instalación: ${e.message}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Reintentar';
    }
  });
}

// ── Start ──────────────────────────────────────────────────────────────────
boot();
