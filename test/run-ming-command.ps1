# Drives a real Pi process in RPC mode and keeps stdin open until the command settles.
# Usage: after installing the package in the working project, run
#   run-ming-command.ps1 -Command "/ming-image design prompts/hero-test.txt"
#
# RPC mode exits as soon as stdin closes, which kills a ~50s image generation before
# it finishes. The generated driver therefore keeps stdin open with a real sleep.

param(
    [Parameter(Mandatory = $true)][string]$Command,
    [int]$TimeoutSec = 240,
    [string]$WorkDir = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
# Invoke the installed CLI directly: piping JSON into the pi.ps1 npm shim can
# buffer stdin and prevent the RPC prompt from reaching Pi until shutdown.
$piShim = (Get-Command pi -ErrorAction Stop).Source
$cli = Join-Path (Split-Path -Parent $piShim) 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
if (-not (Test-Path -LiteralPath $cli)) { throw "Cannot locate the installed Pi CLI next to $piShim" }
$quotedCli = $cli.Replace("'", "''")
$id = [guid]::NewGuid().ToString('N')
$payloadFile = Join-Path $env:TEMP "ming-payload-$id.txt"
$driverFile = Join-Path $env:TEMP "ming-driver-$id.ps1"
$logFile = Join-Path $env:TEMP "ming-log-$id.txt"

try {
    $payload = [ordered]@{ id = '1'; type = 'prompt'; message = $Command } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($payloadFile, $payload, (New-Object Text.UTF8Encoding $false))

    $hold = $TimeoutSec + 60
    $driver = @"
`$ErrorActionPreference = 'Stop'
`$json = Get-Content -Raw -LiteralPath '$payloadFile'
& { `$json; Start-Sleep -Seconds $hold } | & node '$quotedCli' --approve --mode rpc --no-session
"@
    [IO.File]::WriteAllText($driverFile, $driver, (New-Object Text.UTF8Encoding $false))

    $proc = Start-Process -FilePath 'pwsh' `
        -ArgumentList @('-NoProfile', '-File', $driverFile) `
        -WorkingDirectory $WorkDir `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError "$logFile.err" `
        -NoNewWindow -PassThru

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $settled = $false
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 800
        $log = if (Test-Path $logFile) { Get-Content -Raw -LiteralPath $logFile -ErrorAction SilentlyContinue } else { '' }
        if ($log -match '"notifyType":"(success|error)"') { $settled = $true; break }
        if ($proc.HasExited) { break }
    }

    if (-not $proc.HasExited) { try { $proc.Kill($true) } catch {} }

    $log = if (Test-Path $logFile) { Get-Content -Raw -LiteralPath $logFile } else { '' }
    $notifications = @($log -split "`r?`n" | ForEach-Object {
        try {
            $event = $_ | ConvertFrom-Json -ErrorAction Stop
            if ($event.type -eq 'extension_ui_request' -and $event.method -eq 'notify') { $event }
        } catch { }
    })
    $terminal = $notifications | Where-Object { $_.notifyType -in @('success', 'error') } | Select-Object -Last 1
    if (-not $settled -or -not $terminal) {
        $stderrSize = if (Test-Path "$logFile.err") { (Get-Item "$logFile.err").Length } else { 0 }
        throw "Live command did not complete (stderr bytes: $stderrSize)."
    }
    if ($terminal.notifyType -eq 'error') {
        $code = if ($terminal.message -match '^([a-z_]+):') { $Matches[1] } else { 'unknown' }
        throw "Live command failed: $code"
    }
    if ($terminal.message -match '^(design|layer): (\d+) image\(s\) in ([^\r\n]+)') {
        Write-Output "$($Matches[1]): $($Matches[2]) image(s) in $($Matches[3])"
    } else {
        Write-Output 'Live command completed successfully.'
    }
}
finally {
    foreach ($f in @($payloadFile, $driverFile, $logFile, "$logFile.err")) {
        Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
    }
}
