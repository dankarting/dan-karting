# Dan Karting - RentiX bridge (READ-ONLY).
# Reads the RentiX live timing feed (RMonitor, TCP 192.168.0.1:50000) and serves it ONLY on this computer
# at http://localhost:8787 for the staff page. It sends nothing to RentiX and changes no settings.
# Close this window to stop.
$RentixHost = '192.168.0.1'; $Port = 50000; $LocalPort = 8787

$ErrorActionPreference = 'Stop'
$records = [ordered]@{}                                   # latest record per key
$passings = [System.Collections.Generic.List[string]]::new()  # every $J (one per lap)
$state = @{ connected = $false; error = ''; at = 0 }
$utf8 = [System.Text.UTF8Encoding]::new($false, $true)
$latin = [System.Text.Encoding]::GetEncoding(28591)
try { $heb = [System.Text.Encoding]::GetEncoding(1255) } catch { $heb = $null }

function Decode([string]$raw) {
    $bytes = $latin.GetBytes($raw)
    try { return $utf8.GetString($bytes) } catch { if ($heb) { return $heb.GetString($bytes) } else { return $raw } }
}

function Add-Line([string]$line) {
    $state.at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($line -match '^\$I(,|$)') { $records.Clear(); $passings.Clear(); $records['I'] = $line; return }
    if ($line -match '^\$J,') { $passings.Add($line); if ($passings.Count -gt 4000) { $passings.RemoveAt(0) }; return }
    if ($line -match '^\$(A|COMP|G|H),"?([^",]*)"?,"?([^",]*)"?') {
        $key = if ($Matches[1] -eq 'G' -or $Matches[1] -eq 'H') { $Matches[1] + ':' + $Matches[3] } else { 'C:' + $Matches[2] }
        $records[$key] = $line; return
    }
    if ($line -match '^\$([A-Z]+)') { $records[$Matches[1]] = $line }
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$LocalPort/")
$listener.Start()
$ctxTask = $listener.GetContextAsync()

function Serve {
    if (-not $ctxTask.IsCompleted) { return }
    $ctx = $ctxTask.Result
    $script:ctxTask = $listener.GetContextAsync()
    $res = $ctx.Response
    $res.Headers.Add('Access-Control-Allow-Origin', '*')
    $res.Headers.Add('Access-Control-Allow-Private-Network', 'true')
    $res.Headers.Add('Access-Control-Allow-Methods', 'GET, OPTIONS')
    $res.Headers.Add('Access-Control-Allow-Headers', '*')
    $res.Headers.Add('Cache-Control', 'no-store')
    if ($ctx.Request.HttpMethod -eq 'OPTIONS') { $res.StatusCode = 204; $res.Close(); return }
    $all = @($records.Values) + @($passings.ToArray())
    $body = @{ connected = $state.connected; error = $state.error; at = $state.at; lines = $all } | ConvertTo-Json -Compress -Depth 3
    $buf = [System.Text.Encoding]::UTF8.GetBytes($body)
    $res.ContentType = 'application/json; charset=utf-8'
    $res.ContentLength64 = $buf.Length
    $res.OutputStream.Write($buf, 0, $buf.Length)
    $res.Close()
}

Write-Host "Dan Karting - RentiX bridge (read-only)."
Write-Host "Reading $RentixHost`:$Port. Open the staff page on THIS computer: https://dankarting.github.io/dan-karting/?staff"
Write-Host "Close this window to stop."

while ($true) {
    $client = $null; $reader = $null
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $conn = $client.ConnectAsync($RentixHost, $Port)
        $deadline = (Get-Date).AddSeconds(8)
        while (-not $conn.IsCompleted) { Serve; if ((Get-Date) -gt $deadline) { throw "No answer from RentiX at $RentixHost`:$Port" }; Start-Sleep -Milliseconds 30 }
        if ($conn.IsFaulted) { throw $conn.Exception.InnerException }
        $reader = [System.IO.StreamReader]::new($client.GetStream(), $latin)
        $state.connected = $true; $state.error = ''
        Write-Host ("Connected to RentiX " + (Get-Date -Format HH:mm:ss) + ". Waiting for timing data...")
        $pending = $reader.ReadLineAsync()
        $n = 0
        while ($true) {
            Serve
            if ($pending.Wait(30)) {
                $raw = $pending.Result
                if ($null -eq $raw) { throw 'RentiX closed the connection.' }
                if ($raw.Length -gt 0) { Add-Line (Decode $raw); $n++; if ($n % 50 -eq 1) { Write-Host ("Receiving data (" + $n + " lines) " + (Get-Date -Format HH:mm:ss)) } }
                $pending = $reader.ReadLineAsync()
            }
        }
    } catch {
        $state.connected = $false; $state.error = $_.Exception.Message
        Write-Warning ($state.error + ' - retrying in 3 seconds.')
    } finally {
        if ($reader) { $reader.Dispose() }
        if ($client) { $client.Close() }
    }
    $until = (Get-Date).AddSeconds(3)
    while ((Get-Date) -lt $until) { Serve; Start-Sleep -Milliseconds 30 }
}
