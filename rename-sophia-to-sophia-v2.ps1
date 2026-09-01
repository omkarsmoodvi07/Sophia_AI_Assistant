$Root = Get-Location
$SkipDirs = @(".git","node_modules","dist","build",".next","vendor",".pnpm-store")
$Replacements = @(
    @{old="MEMOH"; new="SOPHIA"},
    @{old="Memoh"; new="Sophia"},
    @{old="memoh"; new="sophia"}
)

function Test-SkipDir($path) {
    foreach ($seg in $SkipDirs) { if ($path -match [regex]::Escape("\$seg\")) { return $true } }
    return $false
}

$allPaths = Get-ChildItem -Path $Root -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object {
        -not (Test-SkipDir $_.FullName) -and
        $_.DirectoryName -and
        -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
    } |
    Sort-Object { ($_.FullName -split '\\').Count } -Descending

$renamed = 0
$skipped = 0
foreach ($p in $allPaths) {
    try {
        if (-not (Test-Path -LiteralPath $p.FullName)) { continue }
        $base = $p.Name
        $newBase = $base
        foreach ($r in $Replacements) { $newBase = $newBase -creplace [regex]::Escape($r.old), $r.new }
        if ($newBase -cne $base) {
            $dir = $p.DirectoryName
            if (-not $dir) { $skipped++; continue }
            $newPath = Join-Path $dir $newBase
            if (Test-Path -LiteralPath $newPath) { Write-Host "  SKIP (exists): $newPath"; continue }
            Rename-Item -LiteralPath $p.FullName -NewName $newBase -ErrorAction Stop
            $renamed++
        }
    } catch {
        Write-Host "  SKIP (error): $($p.FullName) -> $($_.Exception.Message)"
        $skipped++
    }
}
Write-Host "Rename pass: renamed $renamed, skipped $skipped."