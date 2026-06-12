/* ── Editor — multi-track timeline (CapCut-style) ────────────────────────── */

// Colors assigned per voice — deterministic so same voice always = same color
const VOICE_COLORS = ['#1f6feb','#e94560','#3fb950','#d29922','#8b5cf6','#06b6d4','#f97316','#14b8a6'];
const PPS_BASE     = 80;   // pixels per second at zoom 1
const DEFAULT_DUR  = 4;    // default new-block duration (s)
const MIN_DUR      = 0.5;

let editorState = {
  videoPath:    null,
  videoDuration: 0,
  blocks:       [],   // { id, text, voiceId, start, duration, color }
  selectedId:   null,
  zoom:         1,
  keepOrigAudio: true,
  generatingTask: null,
  subtitles:    defaultSubtitles(),
};

// Preferencias de subtítulos (estilo Shorts). fontSize en px sobre vídeo 720p de referencia.
function defaultSubtitles() {
  return {
    enabled:      false,
    fontFamily:   'Anton',
    color:        '#FFFFFF',
    outlineColor: '#000000',
    emphasisColor:'#39FF14',  // verde neón para palabras de énfasis
    fontSize:     'large',   // small | medium | large
    position:     'bottom',  // bottom | center | top
  };
}

// Mapa de tamaño relativo → px (altura de referencia 720). Se escala al alto real del overlay.
const SUB_SIZE_PX = { small: 26, medium: 34, large: 46 };
const SUB_MAX_WORDS = 4;  // palabras por frase en pantalla (look Shorts, baja densidad)

// ── Subtítulos: marcado de énfasis y troceo (compartido con el backend) ─────
// Texto hablado: quita el marcado *énfasis* para que la voz no lea los asteriscos.
function spokenText(text) {
  return (text || '').replace(/\*(.+?)\*/g, '$1');
}

// Tokeniza en palabras con flag de énfasis. Un tramo *...* marca todas sus palabras.
function tokenizeEmphasis(text) {
  const tokens = [];
  const re = /\*([^*]+)\*|(\S+)/g;  // *grupo enfatizado* | palabra normal
  let m;
  while ((m = re.exec(text || '')) !== null) {
    if (m[1] != null) {
      m[1].trim().split(/\s+/).forEach(w => w && tokens.push({ word: w, emph: true }));
    } else if (m[2] != null) {
      tokens.push({ word: m[2], emph: false });
    }
  }
  return tokens;
}

// Trocea el texto de un bloque en frases cortas con su ventana temporal.
// Devuelve [{ tokens:[{word,emph}], start, end }] dentro de [blockStart, blockEnd].
function chunkSubtitles(text, blockStart, blockEnd) {
  const tokens = tokenizeEmphasis(text);
  if (!tokens.length) return [];
  const groups = [];
  for (let i = 0; i < tokens.length; i += SUB_MAX_WORDS) {
    groups.push(tokens.slice(i, i + SUB_MAX_WORDS));
  }
  // Reparto proporcional al nº de caracteres de cada grupo
  const weights = groups.map(g => g.reduce((s, t) => s + t.word.length + 1, 0));
  const totalW  = weights.reduce((a, b) => a + b, 0) || 1;
  const span    = Math.max(0.001, blockEnd - blockStart);
  let acc = blockStart;
  return groups.map((g, i) => {
    const dur = span * (weights[i] / totalW);
    const seg = { tokens: g, start: acc, end: acc + dur };
    acc += dur;
    return seg;
  });
}

// Pista discreta del marcado *énfasis*: se muestra hasta que el usuario lo usa una vez.
function emphasisHintSeen() { return localStorage.getItem('nv_emphasis_hint_seen') === '1'; }
function refreshEmphasisHint() {
  document.getElementById('bp-emphasis-hint')?.classList.toggle('hidden', emphasisHintSeen());
}
function maybeDismissEmphasisHint(text) {
  if (!emphasisHintSeen() && /\*[^*]+\*/.test(text || '')) {
    localStorage.setItem('nv_emphasis_hint_seen', '1');
    refreshEmphasisHint();
  }
}

let _dragState = null;  // { blockId, type:'move'|'resize', startX, origStart, origDur }
let _rafId     = null;  // animation frame for playhead

// ── Narration audio cache ──────────────────────────────────────────────────
const _blockAudioCache = {};  // blockId → { url: blobUrl, duration: number|null }
const _genDebounce     = {};  // blockId → setTimeout handle for auto-generation
let   _playTimers      = [];  // setTimeout IDs for scheduled narration playback
let   _playingAudios   = [];  // Audio elements currently playing
let   _activeGens      = 0;   // blocks currently being synthesised in background
let   _genSimTimer     = null; // setInterval for simulated TTS progress
let   _genSimPct       = 0;    // current simulated percentage

// ── Computed helpers ───────────────────────────────────────────────────────
function getPPS()      { return PPS_BASE * editorState.zoom; }
function tX(t)         { return t * getPPS(); }
function xT(x)         { return x / getPPS(); }
function uid()         { return `b${Date.now()}${Math.random().toString(36).slice(2,5)}`; }
function getBlock(id)  { return editorState.blocks.find(b => b.id === id); }
function getSelected() { return getBlock(editorState.selectedId); }

// Deterministic color per voice ID so same voice always gets the same color
function voiceColor(voiceId) {
  if (!voiceId) return VOICE_COLORS[0];
  let h = 0;
  for (let i = 0; i < voiceId.length; i++) h = ((h << 5) - h + voiceId.charCodeAt(i)) | 0;
  return VOICE_COLORS[Math.abs(h) % VOICE_COLORS.length];
}

// ── Narration audio helpers ────────────────────────────────────────────────

// Generate TTS for a block, cache the blob URL, return cache entry (or null)
async function generateBlockAudio(block) {
  if (!block.text.trim()) return null;
  if (!window.appState.xttsReady) return null;
  try {
    const voiceId = block.voiceId || window.appState.activeVoiceId;
    const res = await api('POST', '/tts/preview', { text: spokenText(block.text), voice_id: voiceId });
    const audioResp = await fetch(`http://localhost:8765${res.audio_url}`);
    if (!audioResp.ok) throw new Error(`Audio fetch ${audioResp.status}`);
    const blob = await audioResp.blob();
    if (_blockAudioCache[block.id]) URL.revokeObjectURL(_blockAudioCache[block.id].url);
    const url = URL.createObjectURL(blob);
    // Resolve real duration via loadedmetadata
    const duration = await new Promise(resolve => {
      const a = new Audio(url);
      a.addEventListener('loadedmetadata', () => resolve(a.duration), { once: true });
      a.addEventListener('error', () => resolve(null), { once: true });
    });
    _blockAudioCache[block.id] = { url, duration };
    updateBlockReadyState(block.id, true);
    return _blockAudioCache[block.id];
  } catch (e) {
    console.warn('generateBlockAudio failed:', e);
    return null;
  }
}

// After user stops typing (1.5 s debounce) auto-generate TTS and cache it
function scheduleBlockGeneration(block) {
  updateBlockReadyState(block.id, false);
  block.audioLocked = false; // el texto cambió: el audio previo quedó obsoleto
  document.getElementById(`nbl-${block.id}`)?.classList.add('narr-block-provisional');
  clearTimeout(_genDebounce[block.id]);
  if (!block.text.trim()) return;
  _genDebounce[block.id] = setTimeout(async () => {
    document.getElementById(`nbl-${block.id}`)?.classList.add('narr-block-generating');
    _activeGens++;
    _updateGenBarAudio();
    const cache = await generateBlockAudio(block);
    document.getElementById(`nbl-${block.id}`)?.classList.remove('narr-block-generating');
    _activeGens = Math.max(0, _activeGens - 1);
    _updateGenBarAudio();
    if (cache?.duration && isFinite(cache.duration)) {
      // Duración bloqueada a la voz: el bloque SIEMPRE mide lo que dura el audio
      // (+ pequeña cola para que el trim del backend nunca corte la voz).
      block.duration = Math.max(MIN_DUR, cache.duration + 0.12);
      block.audioLocked = true; // ya no es estimación provisional
      const el = document.getElementById(`nbl-${block.id}`);
      if (el) {
        el.classList.remove('narr-block-provisional');
        positionBlockEl(el, block);
        updateBlockOverflowStyle(block, el);
      }
      redrawTimeline();
      if (editorState.selectedId === block.id) updateBlockDurationDisplay(block);
      updateGenNarrTotal();
    }
  }, 1500);
}

// Estimated TTS generation time: sum of active blocks * 1.3 factor, min 15s
function _estimatedGenMs() {
  let total = 0;
  editorState.blocks.forEach(b => {
    if (document.getElementById(`nbl-${b.id}`)?.classList.contains('narr-block-generating'))
      total += estimateAudioDuration(b.text) * 1.3;
  });
  return Math.max(15, total) * 1000;
}

// Update the generate-bar chip — simulates smooth 0→92% progress while generating
function _updateGenBarAudio() {
  const el = document.getElementById('gen-model-status');
  if (!el) return;

  if (_activeGens > 0) {
    if (!_genSimTimer) {
      // Start simulation: 0 → 92% over estimated duration, updated every 150 ms
      _genSimPct = 0;
      const estMs  = _estimatedGenMs();
      const step   = 92 / (estMs / 150);
      _genSimTimer = setInterval(() => {
        _genSimPct = _genSimPct < 92
          ? Math.min(92, _genSimPct + step)
          : Math.min(99, _genSimPct + 0.008); // slow crawl while XTTS is slower than estimated
        _renderGenBar();
      }, 150);
    }
  } else {
    // Generation finished — snap to 100%, then restore after 1.2 s
    clearInterval(_genSimTimer); _genSimTimer = null;
    _genSimPct = 100;
    _renderGenBar();
    setTimeout(() => { if (_activeGens === 0) initGenModelStatus(); }, 1200);
  }
}

function _renderGenBar() {
  const el = document.getElementById('gen-model-status');
  if (!el) return;
  const pct = Math.round(_genSimPct);
  const label = pct < 100 ? `Generando audio${_activeGens > 1 ? ` (${_activeGens})` : ''}…` : 'Audio listo';
  el.innerHTML = `
    <div class="gms-loading">
      <span class="gms-msg">${label}</span>
      <div class="gms-track"><div class="gms-fill" style="width:${pct}%"></div></div>
      <span class="gms-pct">${pct}%</span>
    </div>`;
}

// Toggle green-dot indicator on the block element
function updateBlockReadyState(id, ready) {
  document.getElementById(`nbl-${id}`)?.classList.toggle('narr-block-cached', ready);
}

// Cancel all pending narration timers and stop any playing audio
function stopAllNarrationAudio() {
  _playTimers.forEach(id => clearTimeout(id));
  _playTimers = [];
  _playingAudios.forEach(a => { try { a.pause(); } catch (_) {} });
  _playingAudios = [];
}

// Schedule each cached block's audio to fire at the right video timestamp.
// If the video is already past a block's start, seeks into the audio to sync.
function scheduleNarrationPlayback(video) {
  stopAllNarrationAudio();
  const now = video.currentTime;
  let willPlay = 0;
  let uncached  = 0;

  editorState.blocks.forEach(block => {
    if (!block.text.trim()) return;
    const cache = _blockAudioCache[block.id];
    if (!cache) { uncached++; return; }

    // offsetSec > 0 → we're already past the block's start; seek into the audio
    const offsetSec = now - block.start;

    // Skip only if we're completely past the audio's end
    if (cache.duration && offsetSec >= cache.duration) return;

    const delayMs = Math.max(0, (block.start - now) * 1000);
    willPlay++;

    const timer = setTimeout(() => {
      if (video.paused) return;
      const audio = new Audio(cache.url);
      if (offsetSec > 0.1) audio.currentTime = offsetSec; // resume mid-audio
      _playingAudios.push(audio);
      audio.play().catch(console.error);
    }, delayMs);
    _playTimers.push(timer);
  });

  if (uncached > 0 && willPlay === 0) {
    showToast('Los bloques aún no tienen audio listo. Pulsa "▶ Preview" o espera unos segundos.', 'info', 5000);
  }
}

// ── Render shell ───────────────────────────────────────────────────────────
function renderEditor() {
  // Remove stale global listeners before re-rendering
  document.removeEventListener('mousemove', _onDragMove);
  document.removeEventListener('mouseup',   _onDragEnd);
  cancelAnimationFrame(_rafId);
  const prevEl = document.getElementById('view-editor');
  if (prevEl?._keyHandler) document.removeEventListener('keydown', prevEl._keyHandler);

  const el = document.getElementById('view-editor');
  el.innerHTML = `
    <div class="editor-layout">

      <!-- Voice bar -->
      <div class="voice-bar">
        <label>Voz activa:</label>
        <select class="voice-selector voice-selector-el" id="ed-voice-sel"></select>
        <button class="btn btn-ghost btn-sm" id="ed-go-voices">Gestionar voces</button>
        <div style="flex:1"></div>
        <button class="btn btn-ghost btn-sm" id="proj-new-btn">Nuevo</button>
        <button class="btn btn-ghost btn-sm" id="proj-history-btn">Recientes</button>
        <button class="btn btn-ghost btn-sm" id="proj-open-btn">Abrir proyecto</button>
        <button class="btn btn-ghost btn-sm" id="proj-save-btn">Guardar proyecto</button>
      </div>

      <!-- Drop zone -->
      <div id="ed-dropzone" class="drop-zone">
        <div class="dz-icon">🎬</div>
        <h3>Arrastra un vídeo aquí</h3>
        <p>O pulsa para seleccionar (MP4, MOV, MKV, AVI)</p>
      </div>

      <!-- Video player -->
      <div id="ed-video-wrap" class="ed-video-wrap hidden">
        <div class="ed-video-stage" id="ed-video-stage">
          <video id="ed-video" preload="metadata"></video>
          <div class="subtitle-overlay hidden" id="subtitle-overlay"></div>
        </div>
        <div class="vid-overlay">
          <button class="ctrl-btn" id="ctrl-rewind" title="Inicio">⏮</button>
          <button class="ctrl-btn" id="ctrl-play">▶</button>
          <span class="ctrl-time" id="ctrl-time">0:00 / 0:00</span>
          <div style="flex:1"></div>
          <button class="btn btn-primary btn-sm" id="add-block-btn">+ Narración</button>
        </div>
      </div>

      <!-- Timeline -->
      <div id="ed-timeline-section" class="tl-section hidden">
        <div class="tl-tracks-row">
          <div class="tl-labels">
            <div class="tl-label-ruler"></div>
            <div class="tl-label">🎬<span>Vídeo</span></div>
            <div class="tl-label" id="tl-audio-lbl" title="Clic para silenciar">🔊<span>Audio</span></div>
            <div class="tl-label tl-label-narr">🎙<span>Narración</span></div>
          </div>
          <div class="tl-scroll" id="tl-scroll">
            <div class="tl-inner" id="tl-inner">
              <canvas class="tl-ruler" id="tl-ruler" height="24"></canvas>
              <div class="tl-track" id="tl-video-track"></div>
              <div class="tl-track" id="tl-audio-track"></div>
              <div class="tl-track tl-narr-track" id="tl-narr-track"></div>
              <div class="tl-playhead" id="tl-playhead"></div>
            </div>
          </div>
        </div>
        <div class="tl-footer">
          <div class="tl-zoom-bar">
            <span class="tl-zoom-icon">🔍</span>
            <button class="tl-zoom-btn" id="tl-zoom-out" title="Alejar">−</button>
            <input type="range" id="tl-zoom-slider" class="tl-zoom-slider"
              min="-2.74" max="3.32" step="0.02" value="0">
            <button class="tl-zoom-btn" id="tl-zoom-in" title="Acercar">+</button>
            <span class="tl-zoom-label" id="zoom-label">1×</span>
            <button class="btn btn-ghost btn-xs" id="tl-fit-btn" title="Ajustar todo el contenido">Ajustar</button>
          </div>
        </div>
      </div>

      <!-- Block text editor (shows when a block is selected) -->
      <div id="ed-block-panel" class="ed-block-panel hidden">
        <div class="block-panel-inner">
          <div class="block-panel-left">
            <div class="block-panel-label">TEXTO DE NARRACIÓN <span id="bp-duration" class="bp-duration-hint"></span>
              <span id="bp-emphasis-hint" class="bp-emphasis-hint hidden">💡 Rodea una palabra con <b>*asteriscos*</b> para resaltarla en el subtítulo</span>
            </div>
            <textarea id="bp-text" class="block-text" rows="2"
              placeholder="Escribe el texto que se narrará en este bloque…"></textarea>
          </div>
          <div class="block-panel-right">
            <select id="bp-voice" class="voice-selector-el"
              style="font-size:12px;padding:5px 8px;width:160px"></select>
            <button class="btn btn-ghost btn-sm" id="bp-preview">▶ Preview</button>
            <button class="btn-icon" id="bp-delete" title="Eliminar bloque">
              <svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14H6L5 6m5 0V4h4v2"/></svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Subtitle controls bar -->
      <div id="ed-subtitle-bar" class="subtitle-bar hidden">
        <label class="subtitle-opt">
          <input type="checkbox" id="sub-enabled">
          <span>Subtítulos</span>
        </label>
        <div class="subtitle-fields" id="subtitle-fields">
          <label class="sub-field">Fuente
            <select id="sub-font">
              <optgroup label="Estilo Shorts (incluidas)">
                <option>Anton</option>
                <option>Bebas Neue</option>
                <option>Montserrat Black</option>
              </optgroup>
              <optgroup label="Del sistema">
                <option>Impact</option>
                <option>Arial Black</option>
                <option>Bahnschrift</option>
                <option>Arial</option>
                <option>Verdana</option>
                <option>Tahoma</option>
                <option>Trebuchet MS</option>
                <option>Georgia</option>
                <option>Comic Sans MS</option>
              </optgroup>
            </select>
          </label>
          <label class="sub-field">Texto
            <input type="color" id="sub-color" value="#FFFFFF" title="Color del texto">
          </label>
          <label class="sub-field">Contorno
            <input type="color" id="sub-outline" value="#000000" title="Color del contorno">
          </label>
          <label class="sub-field">Énfasis
            <input type="color" id="sub-emphasis" value="#39FF14" title="Color de las palabras resaltadas (*texto*)">
          </label>
          <label class="sub-field">Tamaño
            <select id="sub-size">
              <option value="small">Pequeño</option>
              <option value="medium">Mediano</option>
              <option value="large">Grande</option>
            </select>
          </label>
          <label class="sub-field">Posición
            <select id="sub-pos">
              <option value="bottom">Abajo</option>
              <option value="center">Centro</option>
              <option value="top">Arriba</option>
            </select>
          </label>
        </div>
      </div>

      <!-- Generate bar -->
      <div id="ed-gen-bar" class="generate-bar hidden">
        <label class="original-audio-opt">
          <input type="checkbox" id="keep-original-audio" checked>
          Conservar audio original
        </label>
        <span id="gen-narr-total" class="gen-narr-total"></span>
        <div class="gen-model-status" id="gen-model-status"></div>
        <button class="btn btn-primary" id="gen-btn">
          <svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9V3z"/></svg>
          Generar vídeo
        </button>
      </div>

      <!-- Progress overlay -->
      <div class="progress-overlay hidden" id="gen-overlay"
           style="position:absolute;inset:0;z-index:50">
        <h3>Generando narración…</h3>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" id="gen-fill"></div>
        </div>
        <p class="progress-label" id="gen-label">Iniciando…</p>
        <button class="btn btn-ghost btn-sm" id="gen-cancel">Cancelar</button>
      </div>

    </div>
  `;

  // ── Wire static controls ─────────────────────────────────────────────────
  refreshVoiceSelectors();
  const voiceSel = el.querySelector('#ed-voice-sel');
  voiceSel.value = window.appState.activeVoiceId || '';
  voiceSel.addEventListener('change', () => {
    window.appState.activeVoiceId = voiceSel.value;
  });

  el.querySelector('#ed-go-voices').addEventListener('click', () => {
    showView('voices'); renderVoiceLibrary();
  });

  el.querySelector('#proj-new-btn').addEventListener('click', newProject);
  el.querySelector('#proj-save-btn').addEventListener('click', saveProject);
  el.querySelector('#proj-open-btn').addEventListener('click', openProjectDialog);
  el.querySelector('#proj-history-btn').addEventListener('click', showProjectHistory);

  // Drop zone
  const dz = el.querySelector('#ed-dropzone');
  dz.addEventListener('click', pickVideo);
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) loadVideoFile(f.path);
  });

  // Playback
  el.querySelector('#ctrl-play').addEventListener('click', togglePlay);
  el.querySelector('#ctrl-rewind').addEventListener('click', () => {
    document.getElementById('ed-video').currentTime = 0;
    stopAllNarrationAudio();
  });

  // Zoom (timeline footer controls)
  el.querySelector('#tl-zoom-in').addEventListener('click', () => {
    editorState.zoom = Math.min(10, editorState.zoom * 1.5);
    redrawTimeline();
    updateZoomLabel();
  });
  el.querySelector('#tl-zoom-out').addEventListener('click', () => {
    editorState.zoom = Math.max(0.15, editorState.zoom / 1.5);
    redrawTimeline();
    updateZoomLabel();
  });
  el.querySelector('#tl-zoom-slider').addEventListener('input', e => {
    editorState.zoom = Math.pow(2, +e.target.value);
    redrawTimeline();
    updateZoomLabel();
  });
  el.querySelector('#tl-fit-btn').addEventListener('click', fitZoom);

  // Add block — always appended after the last existing block
  el.querySelector('#add-block-btn').addEventListener('click', () => addBlock());

  // Delete selected block with keyboard
  el._keyHandler = (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && editorState.selectedId) {
      const tag = document.activeElement?.tagName;
      if (tag !== 'TEXTAREA' && tag !== 'INPUT') {
        deleteBlock(editorState.selectedId);
        e.preventDefault();
      }
    }
  };
  document.addEventListener('keydown', el._keyHandler);

  // Audio track label toggle
  el.querySelector('#tl-audio-lbl').addEventListener('click', () => {
    const v = document.getElementById('ed-video');
    if (!v) return;
    v.muted = !v.muted;
    editorState.keepOrigAudio = !v.muted;
    el.querySelector('#tl-audio-lbl').innerHTML =
      (v.muted ? '🔇' : '🔊') + '<span>' + (v.muted ? 'Silenciado' : 'Audio') + '</span>';
    el.querySelector('#keep-original-audio').checked = !v.muted;
    document.getElementById('tl-audio-track').style.opacity = v.muted ? '0.35' : '1';
  });

  // Timeline seek on click (ruler or track areas)
  el.querySelector('#tl-scroll').addEventListener('click', e => {
    const tgt = e.target;
    if (!tgt.classList.contains('tl-track') &&
        !tgt.classList.contains('tl-narr-track') &&
        !tgt.classList.contains('tl-ruler') &&
        tgt.id !== 'tl-inner') return;
    seekToX(e);
  });

  // Narration track: click empty area → create a block AT the clicked position
  el.querySelector('#tl-narr-track').addEventListener('click', e => {
    if (e.target !== e.currentTarget) return;
    const scroll = document.getElementById('tl-scroll');
    const rect   = scroll.getBoundingClientRect();
    const x      = e.clientX - rect.left + scroll.scrollLeft;
    addBlock(Math.max(0, xT(x)));
  });

  // Block panel — text input: update label + auto-expand + trigger background TTS gen
  el.querySelector('#bp-text').addEventListener('input', e => {
    const b = getSelected();
    if (!b) return;
    b.text = e.target.value;
    updateBlockLabel(b.id);
    autoExpandBlock(b);
    updateBlockDurationDisplay(b);
    updateGenNarrTotal();
    updateSubtitleOverlay();
    maybeDismissEmphasisHint(b.text);
    scheduleBlockGeneration(b);
  });
  el.querySelector('#bp-voice').addEventListener('change', e => {
    const b = getSelected();
    if (!b) return;
    setBlockVoice(b, e.target.value);
  });
  el.querySelector('#bp-preview').addEventListener('click', previewSelected);
  el.querySelector('#bp-delete').addEventListener('click', () => {
    if (editorState.selectedId) deleteBlock(editorState.selectedId);
  });

  // Model status chip in generate bar
  initGenModelStatus();

  // Subtitle controls
  initSubtitleControls();

  // Generate
  el.querySelector('#gen-btn').addEventListener('click', startGeneration);
  el.querySelector('#gen-cancel').addEventListener('click', cancelGeneration);
  el.querySelector('#keep-original-audio').addEventListener('change', e => {
    editorState.keepOrigAudio = e.target.checked;
  });

  // Global drag handlers
  document.addEventListener('mousemove', _onDragMove);
  document.addEventListener('mouseup',   _onDragEnd);

  // Restore state if returning to editor (also used after loading a project)
  if (editorState.videoPath) {
    const v = document.getElementById('ed-video');
    v.src = `file:///${editorState.videoPath.replace(/\\/g, '/')}`;
    v.addEventListener('loadedmetadata', () => {
      editorState.videoDuration = v.duration;
      document.getElementById('keep-original-audio').checked = editorState.keepOrigAudio;
      showVideoArea();
      redrawTimeline();
      renderAllBlocks();
      startPlayheadAnim();
      updateZoomLabel();
    }, { once: true });
    v.addEventListener('error', () => {
      showToast('No se encontró el archivo de vídeo. Puede que haya sido movido.', 'warning');
      editorState.videoPath = null;
    }, { once: true });
    v.addEventListener('timeupdate', updateTimeDisplay);
    v.addEventListener('ended', () => {
      document.getElementById('ctrl-play').textContent = '▶';
      _playTimers.forEach(id => clearTimeout(id));
      _playTimers = [];
    });
    v.addEventListener('seeked', () => {
      if (!v.paused) scheduleNarrationPlayback(v);
      else stopAllNarrationAudio();
    });
  }
}
window.renderEditor = renderEditor;

// ── Video loading ──────────────────────────────────────────────────────────
async function pickVideo() {
  const p = await window.electronAPI.selectVideoFile();
  if (p) loadVideoFile(p);
}

function loadVideoFile(path) {
  // Clear audio cache from the previous video
  Object.values(_blockAudioCache).forEach(c => URL.revokeObjectURL(c.url));
  Object.keys(_blockAudioCache).forEach(k => delete _blockAudioCache[k]);
  Object.keys(_genDebounce).forEach(k => { clearTimeout(_genDebounce[k]); delete _genDebounce[k]; });
  stopAllNarrationAudio();

  editorState.videoPath  = path;
  editorState.blocks     = [];
  editorState.selectedId = null;

  const v = document.getElementById('ed-video');
  v.src = `file:///${path.replace(/\\/g, '/')}`;

  v.addEventListener('loadedmetadata', () => {
    editorState.videoDuration = v.duration;
    showVideoArea();
    redrawTimeline();
    renderAllBlocks();
    startPlayheadAnim();
  }, { once: true });

  v.addEventListener('timeupdate', updateTimeDisplay);

  // When video ends: cancel scheduled timers but let currently-playing audio finish
  v.addEventListener('ended', () => {
    document.getElementById('ctrl-play').textContent = '▶';
    _playTimers.forEach(id => clearTimeout(id));
    _playTimers = [];
  });
  v.addEventListener('seeked', () => {
    if (!v.paused) scheduleNarrationPlayback(v);
    else stopAllNarrationAudio();
  });
}

function showVideoArea() {
  document.getElementById('ed-dropzone').classList.add('hidden');
  document.getElementById('ed-video-wrap').classList.remove('hidden');
  document.getElementById('ed-timeline-section').classList.remove('hidden');
  document.getElementById('ed-subtitle-bar').classList.remove('hidden');
  document.getElementById('ed-gen-bar').classList.remove('hidden');
}

function togglePlay() {
  const v   = document.getElementById('ed-video');
  const btn = document.getElementById('ctrl-play');
  if (!v) return;
  if (v.paused) {
    v.play();
    btn.textContent = '⏸';
    scheduleNarrationPlayback(v);
  } else {
    v.pause();
    btn.textContent = '▶';
    stopAllNarrationAudio();
  }
}

function updateTimeDisplay() {
  const v  = document.getElementById('ed-video');
  const el = document.getElementById('ctrl-time');
  if (!v || !el) return;
  el.textContent = `${fmt(v.currentTime)} / ${fmt(v.duration || 0)}`;
}

function fmt(s) {
  if (!s && s !== 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return `${m}:${sec}`;
}
window.secondsToTime = fmt;
window.timeToSeconds = t => {
  if (!t) return 0;
  const p = String(t).split(':');
  return p.length === 2 ? +p[0] * 60 + +p[1] : +t;
};

function updateZoomLabel() {
  const z = editorState.zoom;
  const label = document.getElementById('zoom-label');
  if (label) label.textContent = z >= 1 ? `${z.toFixed(1)}×` : `${z.toFixed(2)}×`;
  const slider = document.getElementById('tl-zoom-slider');
  if (slider) slider.value = Math.log2(z);
}

function fitZoom() {
  const scroll = document.getElementById('tl-scroll');
  if (!scroll) return;
  const maxEnd = Math.max(
    editorState.videoDuration,
    editorState.blocks.reduce((m, b) => Math.max(m, b.start + b.duration), 0)
  );
  if (maxEnd <= 0) return;
  editorState.zoom = Math.max(0.15, Math.min(10, (scroll.clientWidth - 24) / (maxEnd * PPS_BASE)));
  redrawTimeline();
  updateZoomLabel();
}

// ── Timeline rendering ─────────────────────────────────────────────────────
function totalWidth() {
  const minW = document.getElementById('tl-scroll')?.clientWidth || 600;
  // Include any narration blocks that extend past video duration
  const maxBlockEnd = editorState.blocks.reduce(
    (max, b) => Math.max(max, b.start + b.duration), editorState.videoDuration);
  return Math.max(minW, tX(maxBlockEnd) + 80);
}

function redrawTimeline() {
  const dur   = editorState.videoDuration;
  const pps   = getPPS();
  const W     = totalWidth();

  // Size inner container
  const inner = document.getElementById('tl-inner');
  if (!inner) return;
  inner.style.width = W + 'px';

  // Ruler
  drawRuler(W, dur, pps);

  // Video bar
  const vt = document.getElementById('tl-video-track');
  if (vt) {
    vt.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'tl-fill-video';
    bar.style.width = tX(dur) + 'px';
    vt.appendChild(bar);
  }

  // Audio bar
  const at = document.getElementById('tl-audio-track');
  if (at) {
    at.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'tl-fill-audio';
    bar.style.width = tX(dur) + 'px';
    at.appendChild(bar);
  }

  // Re-position all existing block elements
  editorState.blocks.forEach(b => {
    const el = document.getElementById(`nbl-${b.id}`);
    if (el) positionBlockEl(el, b);
  });

  // Video-end marker line
  let endLine = document.getElementById('tl-end-line');
  if (!endLine) {
    endLine = document.createElement('div');
    endLine.id  = 'tl-end-line';
    endLine.className = 'tl-end-line';
    inner.appendChild(endLine);
  }
  endLine.style.left = tX(dur) + 'px';
}

function drawRuler(W, dur, pps) {
  const canvas = document.getElementById('tl-ruler');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width  = W + 'px';
  canvas.width        = W * dpr;
  canvas.height       = 24 * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const bg    = getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim();
  const text  = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim();
  const border= getComputedStyle(document.documentElement).getPropertyValue('--border').trim();

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, 24);
  ctx.fillStyle = text;
  ctx.font = '10px system-ui';
  ctx.textBaseline = 'middle';

  // Choose tick interval so ticks aren't too dense
  const rawStep = 80 / pps;
  const step    = Math.max(1, Math.ceil(rawStep / 5) * 5);

  for (let t = 0; t <= dur + step; t += step) {
    const x = tX(t);
    if (x > W) break;
    ctx.fillStyle = border;
    ctx.fillRect(x, 14, 1, 10);
    ctx.fillStyle = text;
    ctx.fillText(fmt(t), x + 3, 10);
  }
}

// ── Playhead animation ─────────────────────────────────────────────────────
function startPlayheadAnim() {
  cancelAnimationFrame(_rafId);
  function frame() {
    const v  = document.getElementById('ed-video');
    const ph = document.getElementById('tl-playhead');
    if (v && ph) {
      const x = tX(v.currentTime);
      ph.style.left = x + 'px';

      // Auto-scroll to keep playhead in view
      const scroll = document.getElementById('tl-scroll');
      if (scroll && !v.paused) {
        const vw = scroll.clientWidth;
        if (x > scroll.scrollLeft + vw - 60) scroll.scrollLeft = x - 60;
        if (x < scroll.scrollLeft + 20)      scroll.scrollLeft = Math.max(0, x - 60);
      }

      // Subtítulo en vivo sincronizado con el tiempo actual
      updateSubtitleOverlay();
    }
    _rafId = requestAnimationFrame(frame);
  }
  frame();
}

function seekToX(e) {
  const scroll = document.getElementById('tl-scroll');
  const rect   = scroll.getBoundingClientRect();
  const x      = e.clientX - rect.left + scroll.scrollLeft;
  const t      = Math.max(0, Math.min(xT(x), editorState.videoDuration));
  const v      = document.getElementById('ed-video');
  if (v) v.currentTime = t;
}

// ── Block management ───────────────────────────────────────────────────────
// Crea una narración en `atSeconds` (por defecto, la posición del cursor de
// reproducción). Si ese punto cae dentro de un bloque existente, se empuja al
// final de ese bloque para no solapar.
function addBlock(atSeconds) {
  const vidDur = editorState.videoDuration || 60;
  const v = document.getElementById('ed-video');

  let start = atSeconds != null ? atSeconds : (v ? v.currentTime : 0);
  start = Math.max(0, Math.min(start, vidDur - MIN_DUR));

  // Resolver solapes: si el punto está dentro de un bloque, ir tras él.
  // Empujar hacia delante mientras caiga dentro de algún bloque.
  const sorted = [...editorState.blocks].sort((a, b) => a.start - b.start);
  let moved = true;
  while (moved) {
    moved = false;
    for (const b of sorted) {
      if (start >= b.start - 0.01 && start < b.start + b.duration - 0.01) {
        start = b.start + b.duration;
        moved = true;
      }
    }
  }

  if (start >= vidDur - MIN_DUR) {
    showToast('No hay espacio libre en ese punto para añadir narración.', 'warning');
    return;
  }

  const vId = window.appState.activeVoiceId || '';
  const block = {
    id:       uid(),
    text:     '',
    voiceId:  vId,
    start,
    duration: Math.min(DEFAULT_DUR, vidDur - start),
    color:    voiceColor(vId),
  };
  editorState.blocks.push(block);
  createBlockEl(block);
  selectBlock(block.id);
  // Foco inmediato en el texto para empezar a escribir
  setTimeout(() => document.getElementById('bp-text')?.focus(), 0);

  // Scroll timeline to show the new block
  const scroll = document.getElementById('tl-scroll');
  if (scroll) {
    const x = tX(start);
    if (x > scroll.scrollLeft + scroll.clientWidth - 100) {
      scroll.scrollLeft = Math.max(0, x - 40);
    }
  }

  // Popover rápido para elegir/escuchar la voz del nuevo fragmento
  showVoicePopover(block);
}

// Popover ligero anclado al panel del bloque: elegir voz + escucharla
function showVoicePopover(block) {
  closeVoicePopover();
  const anchor = document.getElementById('bp-voice') || document.getElementById('ed-block-panel');
  if (!anchor) return;

  const pop = document.createElement('div');
  pop.className = 'voice-popover';
  pop.id = 'voice-popover';
  const options = window.appState.voices.map(v =>
    `<option value="${v.id}">${v.name}${v.type === 'builtin' ? ' ★' : ''}</option>`).join('');
  pop.innerHTML = `
    <div class="vp-title">Voz de esta narración</div>
    <div class="vp-row">
      <select class="vp-select">${options}</select>
      <button class="btn btn-ghost btn-sm vp-preview">▶ Probar</button>
    </div>
    <div class="vp-actions">
      <button class="btn btn-primary btn-sm vp-done">Hecho</button>
    </div>`;
  document.body.appendChild(pop);

  const sel = pop.querySelector('.vp-select');
  sel.value = block.voiceId || window.appState.activeVoiceId || '';

  // Posicionar sobre el panel del bloque, alineado al selector de voz
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.round(Math.min(r.left, window.innerWidth - pop.offsetWidth - 12)) + 'px';
  pop.style.top  = Math.round(r.top - pop.offsetHeight - 10) + 'px';

  sel.addEventListener('change', () => {
    setBlockVoice(block, sel.value);
    const bpVoice = document.getElementById('bp-voice');
    if (bpVoice) bpVoice.value = sel.value;
  });
  pop.querySelector('.vp-preview').addEventListener('click', e =>
    previewVoice(sel.value, e.currentTarget));
  pop.querySelector('.vp-done').addEventListener('click', closeVoicePopover);

  // Cerrar al hacer clic fuera
  setTimeout(() => document.addEventListener('mousedown', _voicePopoverOutside), 0);
}

function _voicePopoverOutside(e) {
  const pop = document.getElementById('voice-popover');
  if (pop && !pop.contains(e.target)) closeVoicePopover();
}

function closeVoicePopover() {
  document.removeEventListener('mousedown', _voicePopoverOutside);
  document.getElementById('voice-popover')?.remove();
}

// Aplica una voz a un bloque (color + invalidar cache + regenerar). Compartido panel/popover.
function setBlockVoice(block, voiceId) {
  block.voiceId = voiceId;
  block.color   = voiceColor(voiceId);
  const blockEl = document.getElementById(`nbl-${block.id}`);
  if (blockEl) blockEl.style.background = block.color;
  if (_blockAudioCache[block.id]) {
    URL.revokeObjectURL(_blockAudioCache[block.id].url);
    delete _blockAudioCache[block.id];
  }
  if (block.text.trim()) scheduleBlockGeneration(block);
}

function deleteBlock(id) {
  if (_blockAudioCache[id]) { URL.revokeObjectURL(_blockAudioCache[id].url); delete _blockAudioCache[id]; }
  clearTimeout(_genDebounce[id]); delete _genDebounce[id];
  editorState.blocks = editorState.blocks.filter(b => b.id !== id);
  document.getElementById(`nbl-${id}`)?.remove();
  if (editorState.selectedId === id) {
    editorState.selectedId = null;
    document.getElementById('ed-block-panel').classList.add('hidden');
  }
  updateGenNarrTotal();
}

// ── Audio duration estimation ──────────────────────────────────────────────
function estimateAudioDuration(text) {
  text = spokenText(text);  // ignorar el marcado *énfasis* en la estimación
  if (!text || !text.trim()) return DEFAULT_DUR;
  const words  = text.trim().split(/\s+/).length;
  const pauses = (text.match(/[.!?;,]/g) || []).length;
  // XTTS v2 Spanish: ~170 wpm = 2.83 w/s; small silence per pause
  return Math.max(MIN_DUR, (words / 2.83) + (pauses * 0.15) + 0.15);
}

// Duración PROVISIONAL mientras se escribe (sin audio aún): crece Y encoge con
// la estimación. Cuando el audio real existe (audioLocked), no se toca.
function autoExpandBlock(block) {
  if (block.audioLocked) return; // el audio manda; no sobrescribir
  const estimated = estimateAudioDuration(block.text);

  // Acotado solo por el siguiente bloque — NO por la duración del vídeo
  // (los bloques pueden sobresalir del final; la timeline se expande para mostrarlos)
  const next = editorState.blocks
    .filter(b => b.id !== block.id && b.start >= block.start + MIN_DUR)
    .sort((a, c) => a.start - c.start)[0] ?? null;

  block.duration = next
    ? Math.max(MIN_DUR, Math.min(estimated, next.start - block.start))
    : estimated;

  const el = document.getElementById(`nbl-${block.id}`);
  if (el) {
    positionBlockEl(el, block);
    el.classList.add('narr-block-provisional');
    updateBlockOverflowStyle(block, el);
  }

  redrawTimeline(); // re-dibuja regla/línea de fin según el nuevo tamaño
}

function renderAllBlocks() {
  const track = document.getElementById('tl-narr-track');
  if (!track) return;
  // Use innerHTML instead of selective removal to avoid stale elements
  track.innerHTML = '';
  editorState.blocks.forEach(b => createBlockEl(b));
}

function createBlockEl(block) {
  const track = document.getElementById('tl-narr-track');
  if (!track) return;
  // Guard against duplicates if called while element already exists
  document.getElementById(`nbl-${block.id}`)?.remove();

  const el = document.createElement('div');
  el.className = 'narr-block';
  el.id = `nbl-${block.id}`;
  el.style.background = block.color;
  el.innerHTML = `
    <span class="narr-block-label">${block.text || '…'}</span>
    <span class="narr-block-overflow-badge"></span>
    <span class="narr-block-del" title="Eliminar">×</span>
  `;
  if (!block.audioLocked && block.text.trim()) el.classList.add('narr-block-provisional');
  positionBlockEl(el, block);

  el.querySelector('.narr-block-del').addEventListener('click', e => {
    e.stopPropagation();
    deleteBlock(block.id);
  });

  // Click → seleccionar / mover (la duración está bloqueada al audio: sin resize)
  el.addEventListener('mousedown', e => {
    if (e.target.classList.contains('narr-block-del')) return;
    startDrag(e, block.id, 'move');
    selectBlock(block.id);
    e.stopPropagation();
  });

  track.appendChild(el);
}

function positionBlockEl(el, block) {
  el.style.left  = tX(block.start) + 'px';
  el.style.width = Math.max(16, tX(block.duration)) + 'px';
  updateBlockOverflowStyle(block, el);
}

function updateBlockOverflowStyle(block, el) {
  const vidDur = editorState.videoDuration || 0;
  const over   = (block.start + block.duration) - vidDur;
  const overflows = vidDur > 0 && over > 0.05;
  el.classList.toggle('narr-block-overflow', overflows);
  const badge = el.querySelector('.narr-block-overflow-badge');
  if (badge) badge.textContent = overflows ? `↦ +${over.toFixed(1)}s` : '';
}

function updateBlockLabel(id) {
  const b  = getBlock(id);
  const el = document.getElementById(`nbl-${id}`);
  if (el && b) {
    el.querySelector('.narr-block-label').textContent = b.text || '…';
  }
}

// Show estimated (or real) duration in the block panel
function updateBlockDurationDisplay(block) {
  const el = document.getElementById('bp-duration');
  if (!el) return;
  if (!block || !block.text.trim()) { el.textContent = ''; return; }
  const cache = _blockAudioCache[block.id];
  if (cache?.duration && isFinite(cache.duration)) {
    el.textContent = `· ${cache.duration.toFixed(1)} s`;
  } else {
    el.textContent = `· ~${estimateAudioDuration(block.text).toFixed(1)} s`;
  }
}

// Show total narration time in the generate bar
function updateGenNarrTotal() {
  const el = document.getElementById('gen-narr-total');
  if (!el) return;
  const blocks = editorState.blocks.filter(b => b.text.trim());
  if (!blocks.length) { el.textContent = ''; return; }
  const totalSec = blocks.reduce((sum, b) => {
    const cache = _blockAudioCache[b.id];
    return sum + (cache?.duration && isFinite(cache.duration) ? cache.duration : estimateAudioDuration(b.text));
  }, 0);
  const n = blocks.length;
  el.textContent = `${n} bloque${n !== 1 ? 's' : ''} · ${fmt(totalSec)} narración`;
}

function selectBlock(id) {
  // Deselect previous
  document.querySelectorAll('.narr-block.selected').forEach(el =>
    el.classList.remove('selected'));

  editorState.selectedId = id;
  const b   = getBlock(id);
  const el  = document.getElementById(`nbl-${id}`);
  if (!b || !el) return;

  el.classList.add('selected');

  // Populate panel
  const panel = document.getElementById('ed-block-panel');
  panel.classList.remove('hidden');

  document.getElementById('bp-text').value = b.text;
  updateBlockDurationDisplay(b);
  refreshEmphasisHint();
  refreshVoiceSelectors();
  const voiceSel = document.getElementById('bp-voice');
  voiceSel.value = b.voiceId || window.appState.activeVoiceId || '';
}

// ── Drag & drop ────────────────────────────────────────────────────────────
function startDrag(e, blockId, type) {
  const b = getBlock(blockId);
  if (!b) return;
  _dragState = {
    blockId,
    type,
    startX:    e.clientX,
    origStart: b.start,
    origDur:   b.duration,
  };
  e.preventDefault();
}

function _onDragMove(e) {
  if (!_dragState) return;
  const { blockId, type, startX, origStart, origDur } = _dragState;
  const b  = getBlock(blockId);
  const el = document.getElementById(`nbl-${blockId}`);
  if (!b || !el) return;

  const dx     = e.clientX - startX;
  const dt     = xT(dx);
  const vidDur = editorState.videoDuration || 9999;

  // Other blocks sorted by start
  const others = editorState.blocks
    .filter(ob => ob.id !== blockId)
    .sort((a, c) => a.start - c.start);

  // Blocks originally to the left/right of the dragged block (based on origStart)
  const leftNeighbor  = others.filter(o => o.start + o.duration <= origStart + 0.01)
                               .sort((a, c) => c.start - a.start)[0] ?? null;
  const rightNeighbor = others.filter(o => o.start >= origStart + origDur - 0.01)
                               .sort((a, c) => a.start - c.start)[0] ?? null;

  // Solo movimiento: la duración está bloqueada al audio.
  // El inicio se acota al bloque previo y a 0; la cola PUEDE sobresalir del
  // final del vídeo (el inicio llega como mucho hasta vidDur).
  const lo = leftNeighbor ? leftNeighbor.start + leftNeighbor.duration : 0;
  const hi = rightNeighbor ? rightNeighbor.start - b.duration : vidDur;
  b.start = Math.max(lo, Math.min(hi, origStart + dt));

  positionBlockEl(el, b);
  if (b.start + b.duration > editorState.videoDuration) redrawTimeline();
}

function _onDragEnd() {
  _dragState = null;
}

// ── Block preview — always plays a fixed test phrase with the selected voice ─
const VOICE_PREVIEW_TEXT =
  'Hola, esta es una prueba de la voz seleccionada para tu narración.';

function previewSelected() {
  const b = getSelected();
  if (!b) return;
  const voiceId = b.voiceId || window.appState.activeVoiceId;
  previewVoice(voiceId, document.getElementById('bp-preview'));
}

// Reproduce la frase de prueba con una voz concreta (reutilizable: panel y popover)
async function previewVoice(voiceId, btn) {
  if (!voiceId) { showToast('Selecciona una voz primero.', 'warning'); return; }

  const orig = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  let url = null;
  try {
    const res  = await api('POST', '/tts/preview', { text: VOICE_PREVIEW_TEXT, voice_id: voiceId });
    const resp = await fetch(`http://localhost:8765${res.audio_url}`);
    if (!resp.ok) throw new Error(`Audio fetch ${resp.status}`);
    const blob = await resp.blob();
    url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.addEventListener('ended', () => { URL.revokeObjectURL(url); }, { once: true });
    await audio.play();
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    showToast(`Error: ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

// ── Generate-bar model status ──────────────────────────────────────────────
function initGenModelStatus() {
  async function update() {
    const el = document.getElementById('gen-model-status');
    if (!el) return; // view unmounted
    try {
      const st = await api('GET', '/setup/status');
      if (st.ready) {
        el.innerHTML = `<span class="gms-ready">Motor listo</span>`;
      } else if (st.loading) {
        const pct = st.progress || 0;
        el.innerHTML = `
          <div class="gms-loading">
            <span class="gms-msg">🎙 ${st.message || 'Cargando voz…'}</span>
            <div class="gms-track"><div class="gms-fill" style="width:${pct}%"></div></div>
            <span class="gms-pct">${pct}%</span>
          </div>`;
        window.updateSidebarModelStatus?.(false, true, pct);
        setTimeout(update, 1000); // keep polling while loading
      } else {
        el.innerHTML = `<span class="gms-warn">Motor no instalado</span>`;
      }
    } catch { /* backend not ready yet */ }
  }
  update();
}

// ── Subtítulos ──────────────────────────────────────────────────────────────
function initSubtitleControls() {
  const s = editorState.subtitles || (editorState.subtitles = defaultSubtitles());
  const $ = id => document.getElementById(id);
  const enabled  = $('sub-enabled');
  const font     = $('sub-font');
  const color    = $('sub-color');
  const outline  = $('sub-outline');
  const emphasis = $('sub-emphasis');
  const size     = $('sub-size');
  const pos      = $('sub-pos');
  if (!enabled) return;

  // Reflejar estado actual en los controles
  enabled.checked = !!s.enabled;
  font.value      = s.fontFamily;
  color.value     = s.color;
  outline.value   = s.outlineColor;
  if (emphasis) emphasis.value = s.emphasisColor || '#39FF14';
  size.value      = s.fontSize;
  pos.value       = s.position;
  document.getElementById('subtitle-fields').classList.toggle('disabled', !s.enabled);

  const onChange = () => {
    s.enabled       = enabled.checked;
    s.fontFamily    = font.value;
    s.color         = color.value;
    s.outlineColor  = outline.value;
    s.emphasisColor = emphasis ? emphasis.value : s.emphasisColor;
    s.fontSize      = size.value;
    s.position      = pos.value;
    document.getElementById('subtitle-fields').classList.toggle('disabled', !s.enabled);
    updateSubtitleOverlay();
  };
  [enabled, font, color, outline, emphasis, size, pos].filter(Boolean).forEach(elm =>
    elm.addEventListener('input', onChange));

  updateSubtitleOverlay();
}

// Devuelve el bloque activo en el tiempo `t` (con texto), o null
function blockAtTime(t) {
  return editorState.blocks.find(b =>
    b.text.trim() && t >= b.start && t < b.start + b.duration) || null;
}

// Clave del último chunk renderizado, para re-disparar el pop-in solo al cambiar
let _subLastChunkKey = null;

// Refresca el overlay de subtítulos en vivo según el tiempo actual del vídeo
function updateSubtitleOverlay() {
  const ov = document.getElementById('subtitle-overlay');
  const v  = document.getElementById('ed-video');
  if (!ov || !v) return;
  const s = editorState.subtitles;

  if (!s || !s.enabled) { ov.classList.add('hidden'); _subLastChunkKey = null; return; }

  const blk = blockAtTime(v.currentTime);
  if (!blk) { ov.classList.add('hidden'); _subLastChunkKey = null; return; }

  // Trocear el bloque y localizar el chunk activo
  const chunks = chunkSubtitles(blk.text, blk.start, blk.start + blk.duration);
  const t = v.currentTime;
  const chunk = chunks.find(c => t >= c.start && t < c.end) || null;
  if (!chunk) { ov.classList.add('hidden'); _subLastChunkKey = null; return; }

  const key = `${blk.id}#${chunk.start.toFixed(3)}`;
  ov.classList.remove('hidden');

  // Reconstruir solo si cambió el chunk (evita reanimar en cada frame)
  if (key !== _subLastChunkKey) {
    _subLastChunkKey = key;
    ov.innerHTML = chunk.tokens.map(tk =>
      `<span class="sub-word"${tk.emph ? ` style="color:${s.emphasisColor || '#39FF14'}"` : ''}>${escapeHtml(tk.word)}</span>`
    ).join(' ');
    // Re-disparar la animación pop-in
    ov.classList.remove('sub-pop');
    void ov.offsetWidth; // reflow para reiniciar la animación
    ov.classList.add('sub-pop');
  }

  // Estilo en vivo
  const stage = document.getElementById('ed-video-stage');
  const refH  = stage ? stage.clientHeight : 480;
  const px    = Math.round((SUB_SIZE_PX[s.fontSize] || 34) * (refH / 720));
  const stroke = Math.max(1, Math.round(px / 11));
  ov.style.fontFamily = `"${s.fontFamily}", system-ui, sans-serif`;
  ov.style.fontSize   = px + 'px';
  ov.style.color      = s.color;
  ov.style.webkitTextStroke = `${stroke}px ${s.outlineColor}`;
  ov.style.textShadow = `2px 3px 0 rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.5)`;
  ov.classList.remove('subtitle-pos-center', 'subtitle-pos-top');
  if (s.position === 'center') ov.classList.add('subtitle-pos-center');
  else if (s.position === 'top') ov.classList.add('subtitle-pos-top');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ── Project management ─────────────────────────────────────────────────────
const PROJECT_VERSION = 1;
const MAX_HISTORY     = 10;

function getProjectHistory() {
  try { return JSON.parse(localStorage.getItem('narravoz_projects') || '[]'); }
  catch { return []; }
}

function addToHistory(entry) {
  const list = getProjectHistory().filter(e => e.projectPath !== entry.projectPath);
  list.unshift(entry);
  localStorage.setItem('narravoz_projects', JSON.stringify(list.slice(0, MAX_HISTORY)));
}

function newProject() {
  const hasContent = editorState.videoPath || editorState.blocks.some(b => b.text.trim());

  if (!hasContent) {
    // Nothing to lose — just reset directly
    applyProjectData({ videoPath: null, blocks: [], keepOrigAudio: true, zoom: 1 }, null);
    return;
  }

  // Ask the user what to do
  const close = openModal(`
    <div class="modal" style="width:400px">
      <div class="modal-header">
        <h3>Nuevo proyecto</h3>
        <button class="modal-close">×</button>
      </div>
      <div class="modal-body" style="padding:20px 24px 8px">
        <p style="color:var(--text-secondary);font-size:13px">
          ¿Qué quieres hacer con el proyecto actual?
        </p>
      </div>
      <div class="modal-footer" style="flex-direction:column;align-items:stretch;gap:8px">
        <button class="btn btn-primary" id="np-save">Guardar proyecto y crear nuevo</button>
        <button class="btn btn-ghost"   id="np-discard">Crear nuevo sin guardar</button>
        <button class="btn btn-ghost"   id="np-cancel">Volver al proyecto actual</button>
      </div>
    </div>
  `);

  document.getElementById('np-save').onclick = async () => {
    close();
    await saveProject();
    applyProjectData({ videoPath: null, blocks: [], keepOrigAudio: true, zoom: 1 }, null);
  };
  document.getElementById('np-discard').onclick = () => {
    close();
    applyProjectData({ videoPath: null, blocks: [], keepOrigAudio: true, zoom: 1 }, null);
  };
  document.getElementById('np-cancel').onclick = () => close();
}

async function saveProject() {
  if (!editorState.videoPath && editorState.blocks.length === 0) {
    showToast('No hay ningún proyecto para guardar.', 'warning');
    return;
  }
  const defaultName = editorState.videoPath
    ? editorState.videoPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') + '.nvproject'
    : 'proyecto.nvproject';
  const json = JSON.stringify({
    version:       PROJECT_VERSION,
    savedAt:       new Date().toISOString(),
    videoPath:     editorState.videoPath,
    blocks:        editorState.blocks,
    keepOrigAudio: editorState.keepOrigAudio,
    zoom:          editorState.zoom,
    subtitles:     editorState.subtitles,
  }, null, 2);

  const projectPath = await window.electronAPI.saveProject(json, defaultName);
  if (!projectPath) return;
  addToHistory({
    name: projectPath.split(/[\\/]/).pop(),
    projectPath,
    savedAt: new Date().toISOString(),
  });
  showToast(`Proyecto guardado: ${projectPath}`, 'success', 5000);
}

async function openProjectDialog() {
  const result = await window.electronAPI.openProject();
  if (!result) return;
  try {
    await applyProjectData(JSON.parse(result.json), result.path);
  } catch {
    showToast('El archivo de proyecto no es válido.', 'error');
  }
}

async function applyProjectData(data, projectPath) {
  // Clear caches from the current session
  Object.values(_blockAudioCache).forEach(c => URL.revokeObjectURL(c.url));
  Object.keys(_blockAudioCache).forEach(k => delete _blockAudioCache[k]);
  Object.keys(_genDebounce).forEach(k => { clearTimeout(_genDebounce[k]); delete _genDebounce[k]; });
  stopAllNarrationAudio();

  editorState.videoPath     = data.videoPath || null;
  editorState.blocks        = (data.blocks || []).map(b => ({ ...b, id: b.id || uid() }));
  editorState.selectedId    = null;
  editorState.keepOrigAudio = data.keepOrigAudio ?? true;
  editorState.zoom          = data.zoom || 1;
  editorState.subtitles     = { ...defaultSubtitles(), ...(data.subtitles || {}) };
  editorState.videoDuration = 0;

  if (projectPath) {
    addToHistory({
      name: projectPath.split(/[\\/]/).pop(),
      projectPath,
      savedAt: new Date().toISOString(),
    });
  }
  renderEditor(); // restore-state block at end of renderEditor() loads the video
}

function showProjectHistory() {
  const history = getProjectHistory();
  if (history.length === 0) {
    showToast('No hay proyectos recientes.', 'info');
    return;
  }
  const items = history.map((e, i) => `
    <div class="proj-hist-item" data-index="${i}">
      <div class="phi-name">${e.name}</div>
      <div class="phi-path">${e.projectPath}</div>
      <div class="phi-date">${new Date(e.savedAt).toLocaleString('es-ES')}</div>
    </div>
  `).join('');

  const close = openModal(`
    <div class="modal" style="width:580px">
      <div class="modal-header">
        <h3>Proyectos recientes</h3>
        <button class="modal-close">×</button>
      </div>
      <div class="modal-body" style="padding:12px;max-height:420px;overflow-y:auto">
        <div class="proj-hist-list">${items}</div>
      </div>
    </div>
  `);

  document.querySelectorAll('.proj-hist-item').forEach(el => {
    el.addEventListener('click', async () => {
      const entry = history[+el.dataset.index];
      const json  = await window.electronAPI.readFile(entry.projectPath);
      if (!json) {
        showToast('No se encontró el archivo. ¿Ha sido movido o eliminado?', 'error');
        return;
      }
      try {
        close();
        await applyProjectData(JSON.parse(json), entry.projectPath);
      } catch {
        showToast('El archivo de proyecto no es válido.', 'error');
      }
    });
  });
}

// ── Generation ─────────────────────────────────────────────────────────────
async function startGeneration() {
  if (!editorState.videoPath) { showToast('Carga un vídeo primero.', 'warning'); return; }
  const withText = editorState.blocks.filter(b => b.text.trim());
  if (!withText.length) { showToast('Añade al menos un bloque con texto.', 'warning'); return; }

  // Overlap check
  const sorted = [...withText].sort((a, b) => a.start - b.start);
  let overlap = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i-1].start + sorted[i-1].duration) { overlap = true; break; }
  }
  if (overlap && !confirm('Hay bloques solapados. El audio se mezclará. ¿Continuar?')) return;

  const overlay = document.getElementById('gen-overlay');
  const fill    = document.getElementById('gen-fill');
  const label   = document.getElementById('gen-label');
  overlay.classList.remove('hidden');

  try {
    const task = await api('POST', '/generate', {
      video_path:          editorState.videoPath,
      keep_original_audio: editorState.keepOrigAudio,
      subtitles:           editorState.subtitles?.enabled ? editorState.subtitles : null,
      blocks: withText.map(b => ({
        start:    b.start,
        end:      b.start + b.duration,
        text:     b.text,
        voice_id: b.voiceId || window.appState.activeVoiceId,
      })),
    });
    editorState.generatingTask = task.task_id;

    await new Promise((resolve, reject) => {
      const poll = setInterval(async () => {
        try {
          const st = await api('GET', `/generate/status/${task.task_id}`);
          fill.style.width  = `${st.progress || 0}%`;
          label.textContent = st.message || '';
          if (st.status === 'done')  { clearInterval(poll); resolve(st.output_path); }
          if (st.status === 'error') { clearInterval(poll); reject(new Error(st.message)); }
        } catch (e) { clearInterval(poll); reject(e); }
      }, 800);
    }).then(outputPath => {
      overlay.classList.add('hidden');
      showPreviewModal(outputPath);
    });
  } catch (e) {
    overlay.classList.add('hidden');
    showToast(`Error al generar: ${e.message}`, 'error');
  }
}

async function cancelGeneration() {
  if (editorState.generatingTask)
    await api('DELETE', `/generate/${editorState.generatingTask}`).catch(() => {});
  document.getElementById('gen-overlay').classList.add('hidden');
}

function showPreviewModal(outputPath) {
  const filename = outputPath.split(/[\\/]/).pop();
  const close = openModal(`
    <div class="modal">
      <div class="modal-header">
        <h3>¡Vídeo generado!</h3>
        <button class="modal-close">×</button>
      </div>
      <div class="modal-body" style="padding:24px 24px 8px;display:flex;flex-direction:column;gap:8px">
        <p style="color:var(--text-secondary);font-size:13px">
          El vídeo se ha generado correctamente.<br>
          <span style="color:var(--text-muted);font-size:11px;word-break:break-all">${outputPath}</span>
        </p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" id="prev-folder">Mostrar en carpeta</button>
        <button class="btn btn-ghost" id="prev-new">Nuevo vídeo</button>
        <button class="btn btn-primary" id="prev-save">Guardar como…</button>
      </div>
    </div>
  `);
  document.getElementById('prev-folder').onclick = () => window.electronAPI.openPath(outputPath);
  document.getElementById('prev-new').onclick = () => {
    close();
    applyProjectData({ videoPath: null, blocks: [], keepOrigAudio: true, zoom: 1 }, null);
  };
  document.getElementById('prev-save').onclick = async () => {
    const dest = await window.electronAPI.saveGeneratedVideo(filename);
    if (dest) {
      await api('POST', '/file/copy', { src: outputPath, dst: dest });
      showToast(`Vídeo guardado: ${dest}`, 'success', 6000);
      close();
    }
  };
}
