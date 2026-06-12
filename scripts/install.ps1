# NarraVoz — Instalador de entorno de desarrollo (Windows)
# Uso (máquina limpia, un solo comando):
#   irm https://raw.githubusercontent.com/vprototype84/Narravoz/master/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"
$REPO_URL  = "https://github.com/vprototype84/Narravoz.git"
$DEST      = "$env:USERPROFILE\NarraVoz"

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  NarraVoz — Instalador de entorno de desarrollo" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Node.js 18+ ───────────────────────────────────────────────────────────
$nodeOk = $false
try {
    $nodeVer = (node --version 2>$null) -replace "v",""
    if ([version]$nodeVer -ge [version]"18.0") { $nodeOk = $true }
} catch {}

if (-not $nodeOk) {
    Write-Host "→ Node.js 18+ no encontrado. Intentando instalar con winget..." -ForegroundColor Yellow
    try {
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        # Recargar PATH para esta sesión
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
        $nodeVer = (node --version) -replace "v",""
        Write-Host "✓ Node.js v$nodeVer instalado"
    } catch {
        Write-Host ""
        Write-Host "ERROR: No se pudo instalar Node.js automáticamente." -ForegroundColor Red
        Write-Host "Instálalo manualmente desde https://nodejs.org y vuelve a ejecutar este script." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "✓ Node.js v$nodeVer"
}

# ── 2. Python 3.11+ ──────────────────────────────────────────────────────────
$python = $null
foreach ($cmd in @("python3.11","python3","python")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3\.(\d+)" -and [int]$Matches[1] -ge 11) {
            $python = $cmd; break
        }
    } catch {}
}

if (-not $python) {
    Write-Host "→ Python 3.11+ no encontrado. Intentando instalar con winget..." -ForegroundColor Yellow
    try {
        winget install Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
        $python = "python"
        Write-Host "✓ Python 3.11 instalado"
    } catch {
        Write-Host ""
        Write-Host "ERROR: No se pudo instalar Python automáticamente." -ForegroundColor Red
        Write-Host "Instálalo desde https://www.python.org/downloads/ y vuelve a ejecutar." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "✓ $(&$python --version)"
}

# ── 3. Clonar o actualizar el repositorio ────────────────────────────────────
if (Test-Path "$DEST\.git") {
    Write-Host "→ Repositorio ya existe en $DEST — actualizando..."
    Set-Location $DEST
    git pull
} else {
    $gitOk = $false
    try { git --version | Out-Null; $gitOk = $true } catch {}

    if ($gitOk) {
        Write-Host "→ Clonando repositorio en $DEST ..."
        git clone $REPO_URL $DEST
        Set-Location $DEST
    } else {
        # Sin git: descargar ZIP desde GitHub
        Write-Host "→ git no encontrado. Descargando ZIP desde GitHub..." -ForegroundColor Yellow
        $zip = "$env:TEMP\narravoz.zip"
        Invoke-WebRequest -Uri "https://github.com/vprototype84/Narravoz/archive/refs/heads/master.zip" `
                          -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath "$env:TEMP\narravoz_extract" -Force
        Move-Item "$env:TEMP\narravoz_extract\Narravoz-master" $DEST
        Remove-Item $zip, "$env:TEMP\narravoz_extract" -Recurse -Force -ErrorAction SilentlyContinue
        Set-Location $DEST
        Write-Host "✓ Código descargado en $DEST (sin historial git)"
    }
}

# ── 4. Ejecutar setup.ps1 (binarios + venv + npm) ────────────────────────────
Write-Host ""
Write-Host "→ Ejecutando setup completo..."
& "$DEST\scripts\setup.ps1"

# ── 5. Resultado final ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  ✓ NarraVoz listo en: $DEST" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Para iniciar la app:"
Write-Host "  cd $DEST"
Write-Host "  npm run dev"
Write-Host ""
Write-Host "NOTA: Al abrir la app por primera vez se descargará"
Write-Host "      el motor de voz XTTS v2 (~2,3 GB, solo una vez)."
Write-Host ""

$launch = Read-Host "¿Iniciar NarraVoz ahora? (s/n)"
if ($launch -match "^[sSyY]") {
    Set-Location $DEST
    npm run dev
}
