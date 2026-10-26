$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw | ConvertFrom-Json
$releaseRoot = Join-Path $projectRoot 'release'
New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
$stage = Join-Path $releaseRoot ('stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
# Explicit allowlist: never ship tests, browser profiles, docs, secrets or dependencies.
$runtime = @('manifest.json', 'background.js', 'popup.html', 'popup.css', 'popup.js', 'i18n.js', 'content', 'shared', 'worker', 'locales', 'assets/icons')
foreach ($entry in $runtime) {
  $source = Join-Path $projectRoot $entry
  $destination = Join-Path $stage $entry
  New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Recurse
}
$zip = Join-Path $releaseRoot ('warera-tactical-' + $manifest.version + '.zip')
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
  $required = @('manifest.json', $manifest.background.service_worker, $manifest.action.default_popup)
  $required += @($manifest.icons.PSObject.Properties.Value)
  foreach ($script in $manifest.content_scripts) { $required += @($script.js); $required += @($script.css) }
  foreach ($file in $required) { if ($file -and $names -notcontains $file) { throw "ZIP is missing $file" } }
} finally { $archive.Dispose() }
# Verify the exact generated target stays inside release before recursive cleanup.
$resolvedStage = [IO.Path]::GetFullPath($stage)
if ((Split-Path $resolvedStage -Parent) -ne $releaseRoot -or (Split-Path $resolvedStage -Leaf) -notmatch '^stage-[a-f0-9]{32}$') { throw 'Unsafe staging path' }
Remove-Item -LiteralPath $resolvedStage -Recurse -Force
$stream = [IO.File]::OpenRead($zip)
$sha = [Security.Cryptography.SHA256]::Create()
try { $checksum = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $sha.Dispose() }
Write-Output "SHA256: $checksum"
Write-Output "Upload: $zip"
