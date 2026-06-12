# NarraVoz — Instalador para Windows
# Uso (un solo comando en PowerShell):
#   irm https://raw.githubusercontent.com/vprototype84/Narravoz/master/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"
$REPO = "vprototype84/Narravoz"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  NarraVoz — Instalador"                    -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Obtener URL del último release ───────────────────────────────────────────
Write-Host "→ Comprobando última versión disponible..."
try {
    $release = Invoke-RestMethod "https://api.github.com/repos/$REPO/releases/latest" -UseBasicParsing
} catch {
    Write-Host "ERROR: No se pudo conectar a GitHub. Comprueba tu conexión." -ForegroundColor Red
    exit 1
}

$asset = $release.assets | Where-Object { $_.name -like "NarraVoz-Setup-*.exe" } | Select-Object -First 1
if (-not $asset) {
    Write-Host "ERROR: No se encontró el instalador en la release '$($release.tag_name)'." -ForegroundColor Red
    exit 1
}

$version = $release.tag_name
$sizeMB  = [math]::Round($asset.size / 1MB, 0)
Write-Host "✓ Versión $version ($sizeMB MB)"

# ── Descargar instalador ──────────────────────────────────────────────────────
$installer = "$env:TEMP\NarraVoz-Setup.exe"
Write-Host "→ Descargando..." -NoNewline

$wc = New-Object System.Net.WebClient
$lastPct = -1
$wc.DownloadProgressChanged += {
    $pct = $_.ProgressPercentage
    if ($pct -ne $lastPct -and $pct % 10 -eq 0) {
        Write-Host " $pct%" -NoNewline
        $script:lastPct = $pct
    }
}
$task = $wc.DownloadFileTaskAsync($asset.browser_download_url, $installer)
while (-not $task.IsCompleted) { Start-Sleep -Milliseconds 200 }
if ($task.IsFaulted) { throw $task.Exception }
Write-Host " ✓"

# ── Instalar silenciosamente (/S = modo NSIS sin wizard) ──────────────────────
Write-Host "→ Instalando..." -NoNewline
$target = "$env:LOCALAPPDATA\Programs\NarraVoz\NarraVoz.exe"

Start-Process -FilePath $installer -ArgumentList "/S" -Wait

# Esperar hasta que el ejecutable aparezca (máx. 60 s)
$waited = 0
while (-not (Test-Path $target) -and $waited -lt 60) {
    Start-Sleep -Seconds 2
    $waited += 2
    Write-Host "." -NoNewline
}
Write-Host ""

Remove-Item $installer -Force -ErrorAction SilentlyContinue

if (-not (Test-Path $target)) {
    Write-Host "AVISO: No se encontró NarraVoz en la ruta esperada." -ForegroundColor Yellow
    Write-Host "  $target" -ForegroundColor Yellow
    Write-Host "Comprueba el menú de inicio por si se instaló en otra ubicación." -ForegroundColor Yellow
    exit 0
}

# ── Crear acceso directo en escritorio si el instalador no lo hizo ────────────
$shortcut = "$env:USERPROFILE\Desktop\NarraVoz.lnk"
if (-not (Test-Path $shortcut)) {
    $sh = New-Object -ComObject WScript.Shell
    $sc = $sh.CreateShortcut($shortcut)
    $sc.TargetPath  = $target
    $sc.Description = "NarraVoz"
    $sc.Save()
}

# ── Fin ───────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  ✓ NarraVoz instalado correctamente."      -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Abre NarraVoz desde el escritorio o el menú de inicio."
Write-Host ""
Write-Host "La primera vez se descargará el motor de voz"
Write-Host "XTTS v2 (~2,3 GB, solo una vez)."
Write-Host ""
