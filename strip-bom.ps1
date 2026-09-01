$Root = Get-Location
$SkipDirs = @(".git","node_modules","dist","build",".next","vendor",".pnpm-store")
$BinaryExt = @(".png",".jpg",".jpeg",".gif",".ico",".webp",".woff",".woff2",".ttf",".eot",".otf",".zip",".tar",".gz",".7z",".pdf",".mp4",".mov",".mp3",".wasm",".so",".dll",".exe",".bin",".db",".sqlite")

function Test-SkipDir($path) {
    foreach ($seg in $SkipDirs) { if ($path -match [regex]::Escape("\$seg\")) { return $true } }
    return $false
}

$bom = [byte[]](0xEF,0xBB,0xBF)
$fixed = 0
$scanned = 0

Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { -not (Test-SkipDir $_.FullName) -and ($BinaryExt -notcontains $_.Extension.ToLower()) } |
  ForEach-Object {
    $scanned++
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq $bom[0] -and $bytes[1] -eq $bom[1] -and $bytes[2] -eq $bom[2]) {
        $stripped = $bytes[3..($bytes.Length - 1)]
        [System.IO.File]::WriteAllBytes($_.FullName, $stripped)
        $fixed++
    }
  }

Write-Host "Scanned $scanned files, stripped BOM from $fixed files."