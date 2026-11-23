function Remove-SmokeDirectory {
    param([string]$Directory)

    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force -ErrorAction Stop) {
        if (!$item.PSIsContainer) {
            [IO.File]::Delete($item.FullName)
        } elseif ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            [IO.Directory]::Delete($item.FullName, $false)
        } else {
            Remove-SmokeDirectory $item.FullName
        }
    }
    [IO.Directory]::Delete($Directory, $false)
}

function Invoke-WithPortableSmokeProfile {
    param([Parameter(Mandatory)][scriptblock]$Smoke)

    $temp = Split-Path (Join-Path (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath "profile")
    $path = Join-Path $temp "quota-monitor-smoke-$([guid]::NewGuid())"
    # New-Item without -Force refuses an existing directory.
    $profile = New-Item -Path $path -ItemType Directory -ErrorAction Stop
    try {
        & $Smoke $profile.FullName
    } finally {
        $profile.Refresh()
        if ($profile.Exists) {
            $resolved = (Resolve-Path -LiteralPath $profile.FullName -ErrorAction Stop).ProviderPath
            if ($resolved -ne $path -or (Split-Path $resolved) -ne $temp -or
                ($profile.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'Refusing to remove a changed smoke profile path'
            }
            Remove-SmokeDirectory $resolved
        }
    }
}
