# Sets the app version everywhere it is recorded, ready for a release:
#   powershell -ExecutionPolicy Bypass -File scripts\bump-version.ps1 0.9.2
# tauri.conf.json is the version the installer and the updater use; Cargo.toml is what the app
# shows in its About/system info; ui/package.json is kept in step for consistency.
param([Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Update-File($path, $pattern, $replacement) {
    $full = Join-Path $root $path
    $text = [IO.File]::ReadAllText($full)
    $new = [regex]::Replace($text, $pattern, $replacement, 'Multiline')
    if ($new -eq $text -and -not ($text -match [regex]::Escape($Version))) { throw "No version found to update in $path" }
    [IO.File]::WriteAllText($full, $new, (New-Object Text.UTF8Encoding $false))
    Write-Host "$path -> $Version"
}

Update-File 'src-tauri\tauri.conf.json' '^(  "version": ")[^"]+(")' "`${1}$Version`${2}"
Update-File 'Cargo.toml' '^(version = ")[^"]+(")' "`${1}$Version`${2}"
Update-File 'ui\package.json' '^(  "version": ")[^"]+(")' "`${1}$Version`${2}"
Write-Host "Next: describe the changes in RELEASE_NOTES.md, commit, then: git tag v$Version; git push origin main v$Version"
