const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const log = require('electron-log');

log.transports.file.level = 'info';
log.transports.console.level = 'debug';

const BACKEND_PORT = 8765;
const BACKEND_READY_TIMEOUT = 300000; // 5 minutes — model load can be slow on CPU

let mainWindow = null;
let backendProcess = null;
let backendReady = false;

// ── paths ──────────────────────────────────────────────────────────────────
function getPaths() {
  const isDev = !app.isPackaged;
  const root = isDev ? path.join(__dirname, '..') : process.resourcesPath;
  const userData = app.getPath('userData');
  const platform = process.platform;

  // Runtime (venv + modelo) viven FUERA de la carpeta de instalación para que
  // reinstalar la app no obligue a volver a descargarlos.
  const localAppData = process.env.LOCALAPPDATA
    || path.join(app.getPath('home'), 'AppData', 'Local');
  const runtimeDir = path.join(localAppData, 'NarraVoz', 'runtime');
  const venvPython = platform === 'win32'
    ? path.join(runtimeDir, 'venv', 'Scripts', 'python.exe')
    : path.join(runtimeDir, 'venv', 'bin', 'python3');
  const modelsDir = path.join(localAppData, 'NarraVoz', 'models');

  // Python a usar para el backend:
  //  - dev: el .venv del proyecto (o python del PATH)
  //  - prod: el venv provisionado en %LOCALAPPDATA%\NarraVoz\runtime
  let pythonBin;
  if (isDev) {
    const venvWin  = path.join(root, '.venv', 'Scripts', 'python.exe');
    const venvUnix = path.join(root, '.venv', 'bin', 'python3');
    if (platform === 'win32' && fs.existsSync(venvWin)) {
      pythonBin = venvWin;
    } else if (platform !== 'win32' && fs.existsSync(venvUnix)) {
      pythonBin = venvUnix;
    } else {
      pythonBin = platform === 'win32' ? 'python' : 'python3';
    }
  } else {
    pythonBin = venvPython;
  }

  // uv: provisiona Python + venv + deps. Empaquetado en resources/bin.
  const uvName = platform === 'win32' ? 'uv.exe' : 'uv';
  const uvCandidate = path.join(isDev ? path.join(root, 'resources') : process.resourcesPath, 'bin', uvName);
  const uvBin = fs.existsSync(uvCandidate) ? uvCandidate : uvName; // fallback al PATH en dev

  const ffmpegName  = platform === 'win32' ? 'ffmpeg.exe'  : 'ffmpeg';
  const ffprobeName = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const ffmpegBin = isDev
    ? ffmpegName  // expect ffmpeg in PATH during dev
    : path.join(process.resourcesPath, 'ffmpeg', ffmpegName);

  return {
    root,
    userData,
    isDev,
    platform,
    pythonBin,
    venvPython,
    uvBin,
    runtimeDir,
    modelsDir,
    ffmpegBin,
    backendScript: path.join(root, 'backend', 'main.py'),
    requirements: path.join(isDev ? root : process.resourcesPath, 'backend', 'requirements.txt'),
    voicesBuiltin: isDev
      ? path.join(root, 'assets', 'voices')
      : path.join(process.resourcesPath, 'voices'),
    voicesUser: path.join(userData, 'voices'),
    tempDir: path.join(userData, 'temp'),
    outputDir: path.join(app.getPath('videos'), 'NarraVoz'),
    scriptsDir: isDev
      ? path.join(root, 'scripts')
      : path.join(process.resourcesPath, 'scripts'),
    fontsDir: isDev
      ? path.join(root, 'assets', 'fonts')
      : path.join(process.resourcesPath, 'fonts'),
  };
}

// ── backend ────────────────────────────────────────────────────────────────
function startBackend(paths) {
  log.info('Starting FastAPI backend…');

  // Ensure user dirs exist
  [paths.voicesUser, paths.tempDir, paths.outputDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  const env = {
    ...process.env,
    NARRAVOZ_PORT: String(BACKEND_PORT),
    NARRAVOZ_VOICES_BUILTIN: paths.voicesBuiltin,
    NARRAVOZ_VOICES_USER: paths.voicesUser,
    NARRAVOZ_TEMP: paths.tempDir,
    NARRAVOZ_OUTPUT: paths.outputDir,
    NARRAVOZ_FFMPEG: paths.ffmpegBin,
    NARRAVOZ_SCRIPTS: paths.scriptsDir,
    NARRAVOZ_FONTS: paths.fontsDir,
    PYTHONUNBUFFERED: '1',
    COQUI_TOS_AGREED: '1',
  };
  // En producción el modelo XTTS vive en %LOCALAPPDATA%\NarraVoz\models (fuera de
  // la carpeta de la app) para sobrevivir reinstalaciones. En dev se respeta la
  // caché por defecto de Coqui (no fijamos TTS_HOME para no re-descargar).
  if (!paths.isDev) env.TTS_HOME = paths.modelsDir;

  backendProcess = spawn(paths.pythonBin, [paths.backendScript], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendProcess.stdout.on('data', (data) => {
    log.info('[backend]', data.toString().trim());
  });

  backendProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    // uvicorn logs to stderr — log at info level
    log.info('[backend-err]', msg);
  });

  backendProcess.on('close', (code) => {
    log.info(`Backend process exited with code ${code}`);
    if (mainWindow && !app.isQuitting) {
      mainWindow.webContents.send('backend-crashed', code);
    }
  });

  backendProcess.on('error', (err) => {
    log.error('Failed to start backend:', err);
    if (mainWindow) {
      mainWindow.webContents.send('backend-error', err.message);
    }
  });
}

function waitForBackend(timeout) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      // Use 127.0.0.1 explicitly — on Windows, 'localhost' may resolve to ::1 (IPv6)
      // while uvicorn only listens on 127.0.0.1 (IPv4), causing connection refused.
      const req = http.get(`http://127.0.0.1:${BACKEND_PORT}/health`, (res) => {
        res.resume(); // consume body so the socket is freed
        if (res.statusCode === 200) {
          log.info('Backend is ready');
          resolve();
        } else {
          retry();
        }
      });
      req.on('error', retry);
      req.setTimeout(3000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeout) {
        reject(new Error('Backend timed out'));
        return;
      }
      setTimeout(check, 800);
    };
    check();
  });
}

// ── Provisión del runtime (Python + deps) con uv ─────────────────────────────
// Idempotente: si el venv ya existe, no hace nada. Solo en producción.
function provisionRuntime(paths, onProgress) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(paths.venvPython)) { resolve(); return; }

    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const venvDir = path.join(paths.runtimeDir, 'venv');
    const env = {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: path.join(paths.runtimeDir, 'python'),
      UV_CACHE_DIR: path.join(paths.runtimeDir, 'uvcache'),
      UV_NO_PROGRESS: '1',
    };
    const CPU_INDEX = 'https://download.pytorch.org/whl/cpu';

    // Pasos secuenciales con progreso aproximado por etapa
    const steps = [
      { args: ['python', 'install', '3.11'], msg: 'Descargando Python…', pct: 8 },
      { args: ['venv', '--python', '3.11', venvDir], msg: 'Creando entorno…', pct: 18 },
      { args: ['pip', 'install', '--python', paths.venvPython,
               'torch', 'torchaudio', '--index-url', CPU_INDEX],
        msg: 'Instalando PyTorch (CPU)…', pct: 30 },
      { args: ['pip', 'install', '--python', paths.venvPython,
               '-r', paths.requirements, '--extra-index-url', CPU_INDEX],
        msg: 'Instalando dependencias de voz…', pct: 60 },
    ];

    let i = 0;
    const next = () => {
      if (i >= steps.length) {
        onProgress(100, 'Dependencias listas');
        resolve();
        return;
      }
      const step = steps[i++];
      onProgress(step.pct, step.msg);
      log.info('[uv] >', step.args.join(' '));
      const p = spawn(paths.uvBin, step.args, { env });
      let errBuf = '';
      p.stdout.on('data', d => log.info('[uv]', d.toString().trim()));
      p.stderr.on('data', d => { const s = d.toString(); errBuf += s; log.info('[uv-err]', s.trim()); });
      p.on('error', e => reject(new Error(`No se pudo ejecutar uv: ${e.message}`)));
      p.on('close', code => {
        if (code === 0) next();
        else reject(new Error(`Provisión falló (uv ${step.args[0]}, código ${code}): ${errBuf.slice(-400)}`));
      });
    };
    next();
  });
}

// Arranca el backend y espera a que esté listo; notifica al renderer.
async function bootBackend(paths) {
  startBackend(paths);
  try {
    await waitForBackend(BACKEND_READY_TIMEOUT);
    backendReady = true;
    if (mainWindow) mainWindow.webContents.send('backend-ready');
  } catch (err) {
    log.error('Backend failed to start:', err);
    if (mainWindow) mainWindow.webContents.send('backend-error', err.message);
  }
}

// ── window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize(); // arrancar ajustada a la pantalla
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC handlers ───────────────────────────────────────────────────────────
function registerIpcHandlers(paths) {
  ipcMain.handle('get-paths', () => ({
    voicesUser: paths.voicesUser,
    voicesBuiltin: paths.voicesBuiltin,
    outputDir: paths.outputDir,
    tempDir: paths.tempDir,
  }));

  // ── Provisión del runtime (primer arranque) ──────────────────────────────
  // El renderer pregunta si hace falta descargar el runtime (Python + deps).
  ipcMain.handle('get-provision-state', () => ({
    isDev: paths.isDev,
    needsRuntime: !paths.isDev && !fs.existsSync(paths.venvPython),
  }));

  // Tras el consentimiento del usuario, el renderer dispara la provisión.
  ipcMain.handle('provision-runtime', async () => {
    await provisionRuntime(paths, (progress, message) => {
      if (mainWindow) mainWindow.webContents.send('provision-progress', { progress, message });
    });
    // Runtime listo → arrancar el backend (lanza backend-ready/backend-error).
    bootBackend(paths);
    return { ok: true };
  });

  ipcMain.handle('quit-app', () => { app.isQuitting = true; app.quit(); });

  ipcMain.handle('is-first-run', () => {
    const marker = path.join(paths.userData, '.narravoz_initialized');
    const isFirst = !fs.existsSync(marker);
    if (isFirst) fs.writeFileSync(marker, new Date().toISOString());
    return isFirst;
  });

  ipcMain.handle('select-video-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar vídeo',
      filters: [{ name: 'Vídeos', extensions: ['mp4', 'mov', 'mkv', 'avi'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('select-audio-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar audio',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'ogg', 'flac'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('select-video-for-voice', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Seleccionar vídeo para extraer voz',
      filters: [{ name: 'Vídeos', extensions: ['mp4', 'mov', 'mkv', 'avi'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('select-output-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Carpeta de destino',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('save-generated-video', async (_, defaultName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar vídeo generado',
      defaultPath: path.join(paths.outputDir, defaultName || 'narravoz_output.mp4'),
      filters: [{ name: 'Vídeo MP4', extensions: ['mp4'] }],
    });
    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle('open-path', (_, filePath) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('backend-url', () => `http://localhost:${BACKEND_PORT}`);

  ipcMain.handle('get-version', () => app.getVersion());

  // Save raw audio blob from renderer (MediaRecorder)
  ipcMain.handle('save-recording', async (_, { buffer, filename }) => {
    const dest = path.join(paths.tempDir, filename);
    fs.writeFileSync(dest, Buffer.from(buffer));
    return dest;
  });

  // ── Setup info for macOS terminal dialog ──────────────────────────────
  ipcMain.handle('get-setup-info', () => {
    const packages = [
      'coqui-tts',
      '"torch>=2.1.0"',
      '"torchaudio>=2.1.0"',
      'fastapi==0.111.0',
      '"uvicorn[standard]==0.30.1"',
      'python-multipart==0.0.9',
      'aiofiles==23.2.1',
      'pydantic==2.7.4',
    ].join(' \\\n  ');

    const pythonCmd = process.platform === 'darwin' && !app.isPackaged
      ? 'python3'
      : `"${paths.pythonBin}"`;

    return {
      platform: process.platform,
      command: `${pythonCmd} -m pip install ${packages}`,
      isDev: !app.isPackaged,
    };
  });

  // ── Project file I/O ──────────────────────────────────────────────────────
  ipcMain.handle('save-project', async (_, { json, defaultName }) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar proyecto NarraVoz',
      defaultPath: path.join(app.getPath('documents'), defaultName || 'proyecto.nvproject'),
      filters: [{ name: 'Proyecto NarraVoz', extensions: ['nvproject'] }],
    });
    if (result.canceled) return null;
    fs.writeFileSync(result.filePath, json, 'utf8');
    return result.filePath;
  });

  ipcMain.handle('open-project', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Abrir proyecto NarraVoz',
      filters: [{ name: 'Proyecto NarraVoz', extensions: ['nvproject'] }],
      properties: ['openFile'],
    });
    if (result.canceled) return null;
    try {
      const json = fs.readFileSync(result.filePaths[0], 'utf8');
      return { path: result.filePaths[0], json };
    } catch (e) { return null; }
  });

  ipcMain.handle('read-file', async (_, filePath) => {
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  });

  // Open macOS Terminal
  ipcMain.handle('open-terminal', () => {
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:')  // fallback
        .catch(() => {});
      // Actually open Terminal.app
      const { exec } = require('child_process');
      exec('open -a Terminal');
    }
  });
}

// ── app lifecycle ──────────────────────────────────────────────────────────
let appPaths = null;

app.whenReady().then(async () => {
  appPaths = getPaths();
  registerIpcHandlers(appPaths);
  createWindow();

  // Si el runtime ya está (dev usa .venv; prod, venv ya provisionado) arrancamos
  // el backend directamente. Si falta (primer arranque en prod), esperamos a que
  // el renderer muestre el consentimiento y dispare la provisión vía IPC.
  if (appPaths.isDev || fs.existsSync(appPaths.venvPython)) {
    bootBackend(appPaths);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  if (backendProcess) {
    log.info('Stopping backend…');
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(backendProcess.pid), '/f', '/t']);
    } else {
      backendProcess.kill('SIGTERM');
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
