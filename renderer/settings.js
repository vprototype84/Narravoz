/* ── Settings view ───────────────────────────────────────────────────────── */

let settingsState = {
  keepOriginalAudio: true,
  outputDir: '',
};

async function renderSettings() {
  const el = document.getElementById('view-settings');
  const paths = await window.electronAPI.getPaths();
  const version = await window.electronAPI.getVersion();

  let setupInfo = { ready: false, model: '', message: '' };
  try { setupInfo = await api('GET', '/setup/status'); } catch (_) {}

  settingsState.outputDir = paths.outputDir;

  el.innerHTML = `
    <div class="settings-layout">
      <div class="section-header" style="position:static;border-bottom:none;padding-left:0;padding-right:0">
        <h2>Opciones</h2>
      </div>

      <!-- Audio export -->
      <div class="settings-section">
        <h3>Exportación de vídeo</h3>
        <div class="settings-row">
          <div class="settings-row-label">
            <div class="label">Conservar audio original</div>
            <div class="desc">Mezcla la narración con el audio existente del vídeo. Si está desactivado, el audio original se silencia.</div>
          </div>
          <div class="settings-row-control">
            <label class="toggle">
              <input type="checkbox" id="s-keep-audio" ${settingsState.keepOriginalAudio ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <div class="label">Carpeta de destino</div>
            <div class="desc">Los vídeos generados se guardan aquí por defecto.</div>
          </div>
          <div class="settings-row-control">
            <div class="path-control">
              <span class="path-value" id="s-output-dir">${settingsState.outputDir}</span>
              <button class="btn btn-ghost btn-sm" id="s-change-dir">Cambiar…</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Model info -->
      <div class="settings-section">
        <h3>Motor de voz (XTTS v2)</h3>
        <div class="settings-row">
          <div class="settings-row-label">
            <div class="label">Estado del modelo</div>
          </div>
          <div class="settings-row-control" id="s-model-status-col">
            ${_renderModelStatus(setupInfo)}
          </div>
        </div>
        ${setupInfo.ready ? `
        <div class="settings-row">
          <div class="settings-row-label">
            <div class="label">Aceleración</div>
          </div>
          <div class="settings-row-control">
            <span class="text-sm" id="s-device">Detectando…</span>
          </div>
        </div>
        ` : `
        <div class="settings-row">
          <button class="btn btn-primary btn-sm" id="s-install-model">Instalar ahora (~1,8 GB)</button>
        </div>
        `}
      </div>

      <!-- Voices paths -->
      <div class="settings-section">
        <h3>Almacenamiento de voces</h3>
        <div class="settings-row">
          <div class="settings-row-label">
            <div class="label">Voces personalizadas</div>
          </div>
          <div class="settings-row-control">
            <div class="path-control">
              <span class="path-value">${paths.voicesUser}</span>
              <button class="btn btn-ghost btn-sm" id="s-open-voices-dir">Abrir</button>
            </div>
          </div>
        </div>
      </div>

      <!-- About -->
      <div class="settings-section">
        <h3>Acerca de</h3>
        <div class="info-block">
          <strong>NarraVoz</strong> v${version}<br>
          Motor de voz: XTTS v2 (Coqui TTS) — procesamiento 100% local.<br>
          Edición de vídeo: FFmpeg.<br><br>
          Todo el procesamiento ocurre en tu equipo. Ningún dato sale al exterior.
        </div>
      </div>
    </div>
  `;

  // Keep audio toggle
  el.querySelector('#s-keep-audio').addEventListener('change', e => {
    settingsState.keepOriginalAudio = e.target.checked;
    window.appState.keepOriginalAudio = e.target.checked;
    const cb = document.getElementById('keep-original-audio');
    if (cb) cb.checked = e.target.checked;
  });

  // Change output dir
  el.querySelector('#s-change-dir').addEventListener('click', async () => {
    const dir = await window.electronAPI.selectOutputDirectory();
    if (dir) {
      settingsState.outputDir = dir;
      el.querySelector('#s-output-dir').textContent = dir;
    }
  });

  // Open voices dir
  el.querySelector('#s-open-voices-dir').addEventListener('click', () => {
    window.electronAPI.openPath(paths.voicesUser);
  });

  // Install model
  el.querySelector('#s-install-model')?.addEventListener('click', () => {
    showSetupOverlay();
  });

  // Device info
  if (setupInfo.ready) {
    api('GET', '/setup/device').then(d => {
      const devEl = document.getElementById('s-device');
      if (devEl) devEl.textContent = d.device === 'cuda' ? `GPU (${d.gpu_name || 'CUDA'})` : 'CPU';
    }).catch(() => {});
  }

  // If model is loading, poll and update status live
  if (setupInfo.loading && !setupInfo.ready) {
    _pollSettingsModelStatus();
  }
}
window.renderSettings = renderSettings;

function _renderModelStatus(st) {
  if (st.ready) {
    return `<span class="text-success" style="font-size:13px">✓ Instalado y listo</span>`;
  }
  if (st.loading) {
    const pct = st.progress || 0;
    return `
      <div style="display:flex;flex-direction:column;gap:6px;min-width:160px">
        <span style="font-size:12px;color:var(--text-secondary)">${st.message || 'Cargando…'}</span>
        <div class="mini-progress-track">
          <div class="mini-progress-fill" style="width:${pct}%"></div>
        </div>
        <span style="font-size:11px;color:var(--text-muted)">${pct}%</span>
      </div>
    `;
  }
  return `<span class="text-warning" style="font-size:13px">⚠ No instalado</span>`;
}

function _pollSettingsModelStatus() {
  const interval = setInterval(async () => {
    const col = document.getElementById('s-model-status-col');
    if (!col) { clearInterval(interval); return; } // view unmounted
    try {
      const st = await api('GET', '/setup/status');
      col.innerHTML = _renderModelStatus(st);
      window.updateSidebarModelStatus?.(st.ready, st.loading, st.progress);
      if (st.ready || !st.loading) clearInterval(interval);
    } catch { clearInterval(interval); }
  }, 1000);
}

// Re-expose showSetupOverlay to settings (defined in app.js)
// This is fine because app.js is loaded before settings.js
