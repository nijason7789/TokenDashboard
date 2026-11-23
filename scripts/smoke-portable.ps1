$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$artifact = (Resolve-Path "release/CodexQuotaMonitor-$version-windows-x64-portable.exe").Path
$staged = (Resolve-Path 'release/win-unpacked').Path
$profileDirectory = Join-Path ([IO.Path]::GetTempPath()) "quota-monitor-smoke-$([guid]::NewGuid())"
$null = New-Item -ItemType Directory -Path $profileDirectory
$preferences = Join-Path $profileDirectory 'preferences.json'
'{"settings":{"closeToTray":false}}' | Set-Content -LiteralPath $preferences
$launcher = $null
$main = $null
$runtime = $null

try {
    $launcher = Start-Process -FilePath $artifact -ArgumentList "--user-data-dir=`"$profileDirectory`"" -PassThru
    $deadline = [datetime]::UtcNow.AddSeconds(60)
    do {
        Start-Sleep -Milliseconds 250
        $launcher.Refresh()
        if ($launcher.HasExited) { throw "Portable launcher exited early ($($launcher.ExitCode))" }
        $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($launcher.Id) AND Name='CodexQuotaMonitor.exe'"
        if ($child) {
            $main = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
            $runtime = Split-Path $child.ExecutablePath
        }
    } until (($main -and $main.MainWindowHandle -ne 0) -or [datetime]::UtcNow -ge $deadline)
    if (!$main -or $main.MainWindowHandle -eq 0) { throw 'Portable window did not open' }
    if ($runtime -eq $staged -or $runtime -eq (Split-Path $artifact)) { throw 'Expected a separate Portable extraction directory' }

    $resources = Get-ChildItem -LiteralPath (Join-Path $runtime 'resources') -Force
    if (($resources.Name | Sort-Object) -join "," -ne "app.asar,elevate.exe") { throw 'Unexpected extracted app resources' }
    foreach ($file in @('CodexQuotaMonitor.exe', 'resources/app.asar', 'resources/elevate.exe')) {
        $expected = (Get-FileHash -LiteralPath (Join-Path $staged $file)).Hash
        $actual = (Get-FileHash -LiteralPath (Join-Path $runtime $file)).Hash
        if ($actual -ne $expected) { throw "Extracted payload differs: $file" }
    }

    $broadSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
    $writeMask = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    foreach ($path in @($profileDirectory, $preferences, $runtime)) {
        $rules = (Get-Acl -LiteralPath $path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -in $broadSids -and ($rule.FileSystemRights -band $writeMask)) {
                throw "Broad write permission on $path"
            }
        }
    }

    $title = $main.MainWindowTitle
    if (!$main.CloseMainWindow()) { throw 'Could not request graceful window close' }
    if (!$launcher.WaitForExit(20000)) { throw 'Portable launcher did not shut down' }
    if ($launcher.ExitCode -ne 0) { throw "Portable launcher exit code $($launcher.ExitCode)" }
    $cleanupDeadline = [datetime]::UtcNow.AddSeconds(10)
    do {
        $children = Get-Process -Name CodexQuotaMonitor -ErrorAction SilentlyContinue |
            Where-Object Path -Like "$runtime\*"
        $runtimeExists = Test-Path -LiteralPath $runtime
        if (!$children -and !$runtimeExists) { break }
        Start-Sleep -Milliseconds 250
    } until ([datetime]::UtcNow -ge $cleanupDeadline)
    if ($children -or $runtimeExists) { throw "Portable runtime files or processes remain after exit: $runtime" }
    $saved = Get-Content -LiteralPath $preferences -Raw | ConvertFrom-Json
    if (!$saved.bounds -or $saved.settings.closeToTray -ne $false) { throw 'Expected settings and bounds in the isolated userData directory' }
    Write-Output "Portable window ($title), payload hashes, runtime/profile ACLs, profile persistence and exit cleanup verified."
} finally {
    if ($runtime) {
        Get-Process -Name CodexQuotaMonitor -ErrorAction SilentlyContinue |
            Where-Object Path -Like "$runtime\*" | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    if ($launcher -and !$launcher.WaitForExit(5000)) { $launcher.Kill() }
}
