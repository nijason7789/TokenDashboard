$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/portable-smoke-profile.ps1')

$success = Invoke-WithPortableSmokeProfile {
    param($profile)
    $nested = New-Item -Path (Join-Path $profile 'nested') -ItemType Directory
    'fixture' | Set-Content -LiteralPath (Join-Path $nested.FullName 'fixture.txt')
    $profile
}
if (Test-Path -LiteralPath $success) { throw 'Successful smoke left its profile behind' }

Invoke-WithPortableSmokeProfile {
    param($outside)
    $sentinel = Join-Path $outside 'keep.txt'
    'fixture' | Set-Content -LiteralPath $sentinel

    $state = @{}
    try {
        Invoke-WithPortableSmokeProfile {
            param($profile)
            $state.Profile = $profile
            $null = New-Item -Path (Join-Path $profile 'junction') -ItemType Junction -Target $outside
            throw 'fixture smoke failure'
        }
    } catch {
        if ($_.Exception.Message -ne 'fixture smoke failure') { throw }
    }

    if (!$state.Profile -or (Test-Path -LiteralPath $state.Profile)) { throw 'Failed smoke left its profile behind' }
    if ((Get-Content -LiteralPath $sentinel -Raw).Trim() -ne 'fixture') { throw 'Cleanup changed a junction target' }
}
Write-Output 'Portable smoke profile cleanup passed on success, failure, and a nested junction.'
