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
    Write-Host "Visita https://github.com/$REPO/releases para descargarlo manualmente." -ForegroundColor Yellow
    exit 1
}

$version  = $release.tag_name
$url      = $asset.browser_download_url
$sizeMB   = [math]::Round($asset.size / 1MB, 0)
Write-Host "✓ Versión $version encontrada ($sizeMB MB)"

# ── Descargar instalador ──────────────────────────────────────────────────────
$installer = "$env:TEMP\NarraVoz-Setup.exe"
Write-Host "→ Descargando $($asset.name)..."
Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
Write-Host "✓ Descarga completada"

# ── Ejecutar instalador ───────────────────────────────────────────────────────
Write-Host "→ Ejecutando instalador..."
Write-Host "   (Busca la ventana del asistente de NarraVoz en la barra de tareas)"
Write-Host ""
# -WindowStyle Normal fuerza la ventana al frente; sin -Wait para que el prompt no bloquee
$proc = Start-Process -FilePath $installer -WindowStyle Normal -PassThru
$proc.WaitForExit()
Remove-Item $installer -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Instalación completada."                   -ForegroundColor Green
Write-Host "  Abre NarraVoz desde el escritorio o"      -ForegroundColor Green
Write-Host "  el menú de inicio."                        -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "La primera vez que abras la app se descargará"
Write-Host "el motor de voz XTTS v2 (~2,3 GB, solo una vez)."
Write-Host ""
