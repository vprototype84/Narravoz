/* ── Voice library view ──────────────────────────────────────────────────── */

let mediaRecorder = null;
let recordedChunks = [];
let recordTimer   = null;
let recordSeconds = 0;
let analyser      = null;
let animFrame     = null;

// ── Render ─────────────────────────────────────────────────────────────────
function renderVoiceLibrary() {
  const el = document.getElementById('view-voices');

  const builtin = window.appState.voices.filter(v => v.type === 'builtin');
  const user    = window.appState.voices.filter(v => v.type !== 'builtin');

  el.innerHTML = `
    <div class="voices-layout">
      <div class="section-header">
        <h2>Biblioteca de voces</h2>
        <button class="btn btn-primary btn-sm" id="add-voice-btn">+ Añadir voz</button>
      </div>

      <div class="voices-section">
        <h3>Voces incluidas</h3>
        <div class="voices-grid" id="builtin-voices-grid">
          ${builtin.map(v => builtinVoiceCard(v)).join('') || '<p class="text-muted text-sm">No se encontraron voces incluidas.</p>'}
        </div>
      </div>

      <div class="voices-section" style="border-top:1px solid var(--border)">
        <h3>Mis voces</h3>
        <div class="voices-list" id="user-voices-list">
          ${user.length
            ? user.map(v => userVoiceRow(v)).join('')
            : `<div class="empty-state"><div class="es-icon">🎤</div><p>Aún no has añadido ninguna voz personalizada.</p></div>`}
        </div>
      </div>
    </div>
  `;

  el.querySelector('#add-voice-btn').addEventListener('click', openAddVoiceModal);

  // Builtin play buttons
  el.querySelectorAll('.play-builtin-btn').forEach(btn => {
    btn.addEventListener('click', () => playVoiceSample(btn.dataset.id));
  });

  // Use as active
  el.querySelectorAll('.use-voice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      window.appState.activeVoiceId = btn.dataset.id;
      refreshVoiceSelectors();
      showToast('Voz activa actualizada.', 'success');
      renderVoiceLibrary(); // re-render to update active highlights
    });
  });

  // User voice actions
  el.querySelectorAll('.play-user-btn').forEach(btn => {
    btn.addEventListener('click', () => playVoiceSample(btn.dataset.id));
  });
  el.querySelectorAll('.rename-user-btn').forEach(btn => {
    btn.addEventListener('click', () => renameVoice(btn.dataset.id, btn.dataset.name));
  });
  el.querySelectorAll('.delete-user-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteVoice(btn.dataset.id, btn.dataset.name));
  });
}
window.renderVoiceLibrary = renderVoiceLibrary;

function builtinVoiceCard(v) {
  const isActive = v.id === window.appState.activeVoiceId;
  return `
    <div class="voice-card builtin ${isActive ? 'active-voice' : ''}">
      <div class="voice-avatar">${voiceEmoji(v)}</div>
      <div class="voice-name">${v.name}</div>
      <div class="voice-style">${v.style || ''}</div>
      <div class="voice-actions">
        <button class="btn-icon play-builtin-btn" data-id="${v.id}" title="Escuchar muestra">
          <svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>
        </button>
        <button class="btn btn-ghost btn-sm use-voice-btn" data-id="${v.id}">Usar</button>
      </div>
    </div>
  `;
}

function userVoiceRow(v) {
  const isActive = v.id === window.appState.activeVoiceId;
  const icons = { mic: '🎤', audio: '🎵', video: '🎬' };
  const icon = icons[v.source] || '🎤';
  const date = v.created_at ? new Date(v.created_at).toLocaleDateString('es-ES') : '';
  return `
    <div class="voice-row ${isActive ? 'active-voice' : ''}">
      <div class="voice-row-icon">${icon}</div>
      <div class="voice-row-info">
        <div class="name">${v.name}</div>
        <div class="meta">${date}${isActive ? ' · <span style="color:var(--accent)">Voz activa</span>' : ''}</div>
      </div>
      <div class="voice-row-actions">
        <button class="btn-icon play-user-btn" data-id="${v.id}" title="Escuchar muestra">
          <svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>
        </button>
        <button class="btn btn-ghost btn-sm use-voice-btn" data-id="${v.id}">Usar</button>
        <button class="btn-icon rename-user-btn" data-id="${v.id}" data-name="${v.name}" title="Renombrar">
          <svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-icon delete-user-btn" data-id="${v.id}" data-name="${v.name}" title="Eliminar voz">
          <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6m5 0V4h4v2"/></svg>
        </button>
      </div>
    </div>
  `;
}

function voiceEmoji(v) {
  const map = { Carlos:'🎙', Elena:'🎤', David:'📢', Sofía:'💬', Marcos:'🎞', Lucía:'📖' };
  return map[v.name] || '🔊';
}

// ── Play sample ────────────────────────────────────────────────────────────
function playVoiceSample(voiceId) {
  const audio = new Audio(`http://localhost:8765/voices/${voiceId}/sample`);
  audio.play().catch(() => showToast('No se pudo reproducir la muestra.', 'error'));
}

// ── Rename ─────────────────────────────────────────────────────────────────
async function renameVoice(id, currentName) {
  const name = prompt('Nuevo nombre para la voz:', currentName);
  if (!name || name === currentName) return;
  try {
    await api('PATCH', `/voices/${id}`, { name });
    await loadVoices();
    renderVoiceLibrary();
    showToast('Voz renombrada.', 'success');
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────
async function deleteVoice(id, name) {
  if (!confirm(`¿Eliminar la voz "${name}"? Esta acción no se puede deshacer.`)) return;
  try {
    await api('DELETE', `/voices/${id}`);
    if (window.appState.activeVoiceId === id) {
      const fallback = window.appState.voices.find(v => v.id !== id);
      window.appState.activeVoiceId = fallback?.id || null;
    }
    await loadVoices();
    renderVoiceLibrary();
    showToast('Voz eliminada.', 'success');
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  }
}

// ── Add voice modal ────────────────────────────────────────────────────────
function openAddVoiceModal() {
  const closeModal = openModal(`
    <div class="modal">
      <div class="modal-header">
        <h3>Añadir voz</h3>
        <button class="modal-close">×</button>
      </div>
      <div class="modal-body">
        <div class="method-tabs">
          <button class="method-tab active" data-panel="record">🎤 Grabar</button>
          <button class="method-tab" data-panel="audio">🎵 Subir audio</button>
          <button class="method-tab" data-panel="video">🎬 Subir vídeo</button>
        </div>

        <!-- Record panel -->
        <div class="method-panel active" id="panel-record">
          <p class="text-sm text-muted" style="margin-bottom:12px">
            Lee el siguiente texto en voz natural. Usaremos tu grabación como muestra de voz.
          </p>
          <div class="record-text-box" id="record-text-box">Cargando texto…</div>
          <canvas class="waveform-canvas" id="waveform-canvas"></canvas>
          <div class="record-controls">
            <button class="btn btn-mic" id="record-start-btn">⏺ Iniciar grabación</button>
            <button class="btn btn-ghost hidden" id="record-stop-btn">⏹ Detener</button>
            <span class="record-timer hidden" id="record-timer">0:00</span>
            <button class="btn btn-ghost hidden" id="record-listen-btn">▶ Escuchar</button>
            <span class="record-status" id="record-status"></span>
          </div>
        </div>

        <!-- Audio panel -->
        <div class="method-panel" id="panel-audio">
          <div class="legal-notice">
            <strong>Aviso legal:</strong> Al subir audio, el usuario garantiza tener los derechos
            sobre la voz capturada. NarraVoz no se hace responsable del uso indebido de voces de terceros.
          </div>
          <p class="text-sm text-muted" style="margin-bottom:12px">
            Selecciona un archivo de audio (MP3, WAV, M4A, OGG). Mínimo recomendado: 15 segundos.
          </p>
          <button class="btn btn-ghost" id="pick-audio-btn">
            <svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Seleccionar archivo de audio
          </button>
          <p class="text-sm" id="audio-file-name" style="margin-top:8px;color:var(--text-secondary)"></p>
        </div>

        <!-- Video panel -->
        <div class="method-panel" id="panel-video">
          <div class="legal-notice">
            <strong>Aviso legal:</strong> Al subir vídeo, el usuario garantiza tener los derechos
            sobre la voz capturada. NarraVoz no se hace responsable del uso indebido de voces de terceros.
          </div>
          <p class="text-sm text-muted" style="margin-bottom:12px">
            Selecciona un vídeo (MP4, MOV, MKV). Se extraerá el audio automáticamente.
          </p>
          <button class="btn btn-ghost" id="pick-video-btn">
            <svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Seleccionar vídeo
          </button>
          <p class="text-sm" id="video-file-name" style="margin-top:8px;color:var(--text-secondary)"></p>
        </div>

        <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
          <label style="font-size:12px;font-weight:500;display:block;margin-bottom:6px">Nombre de la voz</label>
          <input type="text" id="voice-name-input" placeholder="Mi voz" style="width:100%">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost modal-close-btn">Cancelar</button>
        <button class="btn btn-primary" id="save-voice-btn" disabled>Guardar voz</button>
      </div>
    </div>
  `, { onClose: cleanupRecorder });

  // Tabs
  const modal = document.querySelector('.modal');
  let activePanel = 'record';
  let selectedFilePath = null;
  let recordedPath = null;
  let recordedBlob = null;

  modal.querySelectorAll('.method-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      modal.querySelectorAll('.method-tab').forEach(t => t.classList.remove('active'));
      modal.querySelectorAll('.method-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      activePanel = tab.dataset.panel;
      modal.querySelector(`#panel-${activePanel}`).classList.add('active');
      updateSaveBtn();
    });
  });

  // Load capture text
  fetch('http://localhost:8765/capture-text')
    .then(r => r.json())
    .then(d => { document.getElementById('record-text-box').textContent = d.text; })
    .catch(() => {});

  // Recording
  const startBtn  = document.getElementById('record-start-btn');
  const stopBtn   = document.getElementById('record-stop-btn');
  const timerEl   = document.getElementById('record-timer');
  const listenBtn = document.getElementById('record-listen-btn');
  const statusEl  = document.getElementById('record-status');
  const canvas    = document.getElementById('waveform-canvas');

  startBtn.addEventListener('click', startRecording);
  stopBtn.addEventListener('click', stopRecording);
  listenBtn.addEventListener('click', () => {
    if (recordedBlob) {
      const url = URL.createObjectURL(recordedBlob);
      new Audio(url).play();
    }
  });

  function startRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(stream => {
        const audioCtx = new AudioContext();
        const src = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);

        recordedChunks = [];
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
        mediaRecorder.onstop = async () => {
          recordedBlob = new Blob(recordedChunks, { type: 'audio/webm' });
          stream.getTracks().forEach(t => t.stop());
          stopBtn.classList.add('hidden');
          startBtn.classList.remove('hidden');
          timerEl.classList.add('hidden');
          listenBtn.classList.remove('hidden');
          statusEl.textContent = `Grabación lista (${recordSeconds}s)`;
          cancelAnimationFrame(animFrame);
          clearInterval(recordTimer);
          recordedPath = '__recorded__';
          updateSaveBtn();
        };
        mediaRecorder.start(100);
        recordSeconds = 0;
        startBtn.classList.add('hidden');
        stopBtn.classList.remove('hidden');
        timerEl.classList.remove('hidden');
        listenBtn.classList.add('hidden');
        statusEl.textContent = 'Grabando…';

        recordTimer = setInterval(() => {
          recordSeconds++;
          const m = Math.floor(recordSeconds / 60);
          const s = recordSeconds % 60;
          timerEl.textContent = `${m}:${String(s).padStart(2,'0')}`;
        }, 1000);

        drawWaveform(canvas, analyser);
      })
      .catch(() => showToast('No se pudo acceder al micrófono.', 'error'));
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  }

  // File pickers
  document.getElementById('pick-audio-btn').addEventListener('click', async () => {
    const p = await window.electronAPI.selectAudioFile();
    if (p) {
      selectedFilePath = p;
      document.getElementById('audio-file-name').textContent = p.split(/[\\/]/).pop();
      updateSaveBtn();
    }
  });
  document.getElementById('pick-video-btn').addEventListener('click', async () => {
    const p = await window.electronAPI.selectVideoForVoice();
    if (p) {
      selectedFilePath = p;
      document.getElementById('video-file-name').textContent = p.split(/[\\/]/).pop();
      updateSaveBtn();
    }
  });

  function updateSaveBtn() {
    const hasName = document.getElementById('voice-name-input').value.trim();
    const hasSource = (activePanel === 'record' && recordedPath)
      || (activePanel !== 'record' && selectedFilePath);
    document.getElementById('save-voice-btn').disabled = !(hasName && hasSource);
  }

  document.getElementById('voice-name-input').addEventListener('input', updateSaveBtn);

  // Save
  document.getElementById('save-voice-btn').addEventListener('click', async () => {
    const btn = document.getElementById('save-voice-btn');
    btn.disabled = true; btn.textContent = 'Guardando…';
    const name = document.getElementById('voice-name-input').value.trim();

    try {
      if (activePanel === 'record' && recordedBlob) {
        const arr = await recordedBlob.arrayBuffer();
        const tmpName = `rec_${Date.now()}.webm`;
        const tmpPath = await window.electronAPI.saveRecording(new Uint8Array(arr), tmpName);
        await api('POST', '/voices/from-audio', { name, source_path: tmpPath, source: 'mic' });
      } else if (activePanel === 'audio') {
        await api('POST', '/voices/from-audio', { name, source_path: selectedFilePath, source: 'audio' });
      } else if (activePanel === 'video') {
        await api('POST', '/voices/from-video', { name, source_path: selectedFilePath });
      }
      await loadVoices();
      renderVoiceLibrary();
      showToast(`Voz "${name}" añadida correctamente.`, 'success');
      closeModal();
    } catch (e) {
      showToast(`Error: ${e.message}`, 'error');
      btn.disabled = false; btn.textContent = 'Guardar voz';
    }
  });

  modal.querySelector('.modal-close-btn')?.addEventListener('click', closeModal);
}
window.openAddVoiceModal = openAddVoiceModal;

// ── Waveform visualizer ────────────────────────────────────────────────────
function drawWaveform(canvas, analyserNode) {
  if (!canvas || !analyserNode) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width  = W;
  canvas.height = H;

  const buf = new Uint8Array(analyserNode.frequencyBinCount);

  function frame() {
    animFrame = requestAnimationFrame(frame);
    analyserNode.getByteTimeDomainData(buf);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 2;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent-mic').trim();
    ctx.beginPath();
    const sl = W / buf.length;
    let x = 0;
    buf.forEach((v, i) => {
      const y = (v / 128) * (H / 2);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      x += sl;
    });
    ctx.stroke();
  }
  frame();
}

function cleanupRecorder() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  cancelAnimationFrame(animFrame);
  clearInterval(recordTimer);
  analyser = null;
}
