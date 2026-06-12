function renderWelcome() {
  const el = document.getElementById('view-welcome');
  el.innerHTML = `
    <div class="welcome-screen">
      <div class="logo-mark" style="width:64px;height:64px;border-radius:16px;font-size:22px;">NV</div>
      <div style="text-align:center">
        <h1>Bienvenido a NarraVoz</h1>
        <p>Añade narración con voz clonada a tus vídeos de captura de pantalla, directamente en tu equipo.</p>
      </div>
      <div class="welcome-options">
        <div class="welcome-card" id="welcome-use-builtin">
          <div class="card-icon">🎙️</div>
          <h3>Usar una voz incluida</h3>
          <p>Empieza de inmediato con una de las 6 voces predefinidas de alta calidad.</p>
        </div>
        <div class="welcome-card" id="welcome-add-own">
          <div class="card-icon">🎤</div>
          <h3>Añadir mi propia voz</h3>
          <p>Graba o sube un fragmento de audio para clonar tu voz o la de un locutor.</p>
        </div>
      </div>
    </div>
  `;

  el.querySelector('#welcome-use-builtin').addEventListener('click', () => {
    // Pick first builtin voice
    const builtin = window.appState.voices.find(v => v.type === 'builtin');
    if (builtin) window.appState.activeVoiceId = builtin.id;
    showView('editor');
    renderEditor();
  });

  el.querySelector('#welcome-add-own').addEventListener('click', () => {
    showView('voices');
    renderVoiceLibrary();
    // Slight delay so the view renders first
    setTimeout(() => openAddVoiceModal(), 100);
  });
}
window.renderWelcome = renderWelcome;
