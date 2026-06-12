# NarraVoz — Configuración del entorno de desarrollo (Windows)
# Uso: .\scripts\setup.ps1
#
# Qué hace:
#   1. Comprueba Node.js 18+
#   2. npm install
#   3. Descarga uv.exe a resources/bin/ (necesario para el build del instalador)
#   4. Descarga ffmpeg.exe/ffprobe.exe a resources/ffmpeg/ (necesario para dev y build)
#   5. Crea .venv con PyTorch CPU + dependencias
#   6. Genera placeholders de voces

$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\.."

Write-Host "=== NarraVoz — Setup ===" -ForegroundColor Cyan

# 1. Node.js 18+
try { $nodeVer = (node --version) -replace "v","" } catch { throw "Node.js no encontrado. Instálalo desde https://nodejs.org (v18+)" }
if ([version]$nodeVer -lt [version]"18.0") { throw "Se requiere Node.js 18+. Versión actual: v$nodeVer" }
Write-Host "✓ Node.js v$nodeVer"

# 2. Dependencias npm
Write-Host "→ Instalando dependencias npm..."
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install falló" }

# 3. uv.exe (para building del instalador)
$uvDest = "resources\bin\uv.exe"
if (-not (Test-Path $uvDest)) {
    Write-Host "→ Descargando uv.exe..."
    New-Item -ItemType Directory -Force -Path "resources\bin" | Out-Null
    $uvZip = "$env:TEMP\nv_uv.zip"
    $uvUrl = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
    Invoke-WebRequest -Uri $uvUrl -OutFile $uvZip -UseBasicParsing
    $uvExtract = "$env:TEMP\nv_uv_extract"
    Expand-Archive -Path $uvZip -DestinationPath $uvExtract -Force
    $uvExe = Get-ChildItem $uvExtract -Recurse -Filter "uv.exe" | Select-Object -First 1
    Copy-Item $uvExe.FullName $uvDest
    Remove-Item $uvZip, $uvExtract -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "✓ uv.exe descargado"
} else {
    Write-Host "✓ uv.exe ya existe"
}

# 4. ffmpeg + ffprobe (para dev y build)
$ffDest = "resources\ffmpeg\ffmpeg.exe"
if (-not (Test-Path $ffDest)) {
    Write-Host "→ Descargando ffmpeg estático (puede tardar, ~100 MB)..."
    New-Item -ItemType Directory -Force -Path "resources\ffmpeg" | Out-Null
    $ffZip = "$env:TEMP\nv_ffmpeg.zip"
    $ffUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    Invoke-WebRequest -Uri $ffUrl -OutFile $ffZip -UseBasicParsing
    $ffExtract = "$env:TEMP\nv_ffmpeg_extract"
    Expand-Archive -Path $ffZip -DestinationPath $ffExtract -Force
    $ffExe     = Get-ChildItem $ffExtract -Recurse -Filter "ffmpeg.exe"  | Select-Object -First 1
    $ffpExe    = Get-ChildItem $ffExtract -Recurse -Filter "ffprobe.exe" | Select-Object -First 1
    Copy-Item $ffExe.FullName  "resources\ffmpeg\ffmpeg.exe"
    Copy-Item $ffpExe.FullName "resources\ffmpeg\ffprobe.exe"
    Remove-Item $ffZip, $ffExtract -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "✓ ffmpeg descargado"
} else {
    Write-Host "✓ ffmpeg ya existe"
}

# 5. Python 3.11+
$python = $null
foreach ($cmd in @("python3.11","python3","python")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3\.(\d+)") {
            if ([int]$Matches[1] -ge 11) { $python = $cmd; break }
        }
    } catch {}
}
if (-not $python) {
    throw "Python 3.11+ no encontrado. Instálalo desde https://www.python.org/downloads/"
}
Write-Host "✓ $(&$python --version)"

# Crear o actualizar .venv
$venvPy = ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    Write-Host "→ Creando entorno virtual..."
    & $python -m venv .venv
} else {
    Write-Host "✓ Entorno virtual ya existe"
}

Write-Host "→ Instalando dependencias Python (PyTorch CPU, puede tardar)..."
& .venv\Scripts\pip install --quiet --upgrade pip
& .venv\Scripts\pip install --quiet torch torchaudio --index-url https://download.pytorch.org/whl/cpu
& .venv\Scripts\pip install --quiet -r backend\requirements.txt

# 6. Voces placeholder
Write-Host "→ Generando placeholders de voces..."
& .venv\Scripts\python scripts\first_run.py

Write-Host ""
Write-Host "✓ Setup completado." -ForegroundColor Green
Write-Host ""
Write-Host "Para iniciar la app en modo desarrollo:"
Write-Host "  npm run dev"
Write-Host ""
Write-Host "Para compilar el instalador Windows:"
Write-Host "  npm run build:win"
Write-Host ""
Write-Host "NOTA: Al abrir la app por primera vez se te pedirá descargar"
Write-Host "      el modelo XTTS v2 (~2,3 GB). Solo se descarga una vez."
