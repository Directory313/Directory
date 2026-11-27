# Reproducible Windows release build: frontend, Rust (release), NSIS + MSI installers and a
# portable ZIP. Run from any folder:  powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
Set-Location $root

if (-not (Test-Path 'src-tauri\resources\ffmpeg\ffmpeg.exe')) { & "$PSScriptRoot\setup-ffmpeg.ps1" }

Push-Location ui
if (-not (Test-Path node_modules)) { npm ci --no-audit --no-fund }
npm run build
Pop-Location

if (-not $SkipTests) {
    cargo test --workspace --exclude veyra --release
    if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed' }
}

# Run the Tauri CLI from the repo root so it discovers src-tauri/tauri.conf.json.
& (Join-Path $root 'ui\node_modules\.bin\tauri.cmd') build
if ($LASTEXITCODE -ne 0) { throw 'tauri build failed' }

# Portable build: the release exe plus its resources, runnable without installing.
$out = Join-Path $root 'release'
$portable = Join-Path $out 'Directory-Beta-portable'
Remove-Item -Recurse -Force $portable -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$portable\ffmpeg", "$portable\blender" | Out-Null
$exe = if (Test-Path 'target\release\Directory.exe') { 'target\release\Directory.exe' } else { 'target\release\veyra.exe' }
Copy-Item $exe "$portable\Directory.exe"
Copy-Item 'src-tauri\resources\ffmpeg\*' "$portable\ffmpeg\"
Copy-Item 'src-tauri\resources\blender\*' "$portable\blender\"
Copy-Item 'README.md', 'docs\USER_GUIDE.md', 'docs\KNOWN_LIMITATIONS.md' $portable -ErrorAction SilentlyContinue
Set-Content "$portable\PORTABLE.txt" "Directory Beta portable build. Requires the Microsoft Edge WebView2 runtime (preinstalled on Windows 10/11). Run Directory.exe." -Encoding utf8
Compress-Archive -Path "$portable\*" -DestinationPath (Join-Path $out 'Directory-Beta-portable.zip') -Force
Get-ChildItem 'target\release\bundle' -Recurse -Include *.exe, *.msi | Copy-Item -Destination $out
Get-ChildItem $out | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
