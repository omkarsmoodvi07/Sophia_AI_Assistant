$Root = Get-Location
$SkipDirs = @(".git","node_modules","dist","build",".next","vendor",".pnpm-store")
$BinaryExt = @(".png",".jpg",".jpeg",".gif",".ico",".webp",".woff",".woff2",".ttf",".eot",".otf",".zip",".tar",".gz",".7z",".pdf",".mp4",".mov",".mp3",".wasm",".so",".dll",".exe",".bin",".db",".sqlite")
$Replacements = @(
    @{old="SOPHIA"; new="SOPHIA"},
    @{old="Sophia"; new="Sophia"},
    @{old="sophia"; new="sophia"}
)

function Test-SkipDir($path) {
    foreach ($seg in $SkipDirs) { if ($path -match [regex]::Escape("\$seg\") -or $path -match [regex]::Escape("\$seg`$")) { return $true } }
    return $false
}

$changedFiles = 0
$scanned = 0
Get-ChildItem -Path $Root -Recurse -File | Where-Object { -not (Test-SkipDir $_.FullName) -and ($BinaryExt -notcontains $_.Extension.ToLower()) } | ForEach-Object {
    $scanned++
    try {
        $content = Get-Content -Raw -Encoding UTF8 -Path $_.FullName -ErrorAction Stop
    } catch { return }
    $new = $content
    foreach ($r in $Replacements) { $new = $new -creplace [regex]::Escape($r.old), $r.new }
    if ($new -cne $content) {
        Set-Content -Path $_.FullName -Value $new -NoNewline -Encoding UTF8
        $changedFiles++
    }
}
Write-Host "Content pass: scanned $scanned files, modified $changedFiles files."

$allPaths = Get-ChildItem -Path $Root -Recurse | Where-Object { -not (Test-SkipDir $_.FullName) } | Sort-Object { ($_.FullName -split '\\').Count } -Descending
$renamed = 0
foreach ($p in $allPaths) {
    if (-not (Test-Path $p.FullName)) { continue }
    $base = $p.Name
    $newBase = $base
    foreach ($r in $Replacements) { $newBase = $newBase -creplace [regex]::Escape($r.old), $r.new }
    if ($newBase -cne $base) {
        $newPath = Join-Path $p.DirectoryName $newBase
        if (Test-Path $newPath) { Write-Host "  SKIP (exists): $newPath"; continue }
        Rename-Item -Path $p.FullName -NewName $newBase
        $renamed++
    }
}
Write-Host "Rename pass: renamed $renamed files/folders."