# Places ffmpeg.exe / ffprobe.exe into src-tauri/resources/ffmpeg so they are bundled with VEYRA.
# Order: an existing FFmpeg on PATH (hard-linked to save disk space, copied across drives),
# otherwise installs the gyan.dev full GPL build via winget.
param([switch]$Copy)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dst = Join-Path $root 'src-tauri\resources\ffmpeg'
New-Item -ItemType Directory -Force $dst | Out-Null

$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ff) {
    Write-Host 'FFmpeg not found; installing Gyan.FFmpeg (full build) with winget...'
    winget install --id Gyan.FFmpeg -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'User') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'Machine')
    $ff = Get-Command ffmpeg -ErrorAction Stop
}
$src = Split-Path $ff.Source
foreach ($f in 'ffmpeg.exe', 'ffprobe.exe') {
    $target = Join-Path $dst $f
    if (Test-Path $target) { Remove-Item $target -Force }
    $sameDrive = ([IO.Path]::GetPathRoot($src) -eq [IO.Path]::GetPathRoot($dst))
    if ($sameDrive -and -not $Copy) { New-Item -ItemType HardLink -Path $target -Target (Join-Path $src $f) | Out-Null }
    else { Copy-Item (Join-Path $src $f) $target }
}
$lic = Join-Path (Split-Path $src) 'LICENSE'
if (Test-Path $lic) { Copy-Item $lic (Join-Path $dst 'LICENSE-FFmpeg.txt') -Force }
& (Join-Path $dst 'ffmpeg.exe') -hide_banner -version | Select-Object -First 1
Write-Host "Bundled media engine ready in $dst"
