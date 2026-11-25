# Serves Remote PC over HTTPS on your tailnet with Tailscale Serve (secure address + smooth H.264 video).
#   powershell -ExecutionPolicy Bypass -File scripts\enable-https.ps1
# Needs HTTPS certificates (and Serve) enabled for your tailnet: https://login.tailscale.com/admin/dns
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = "$env:ProgramFiles\Tailscale\tailscale.exe" }
if (-not (Test-Path $ts)) { Write-Host "Tailscale isn't installed. Get it with: winget install Tailscale.Tailscale"; exit 1 }

$cfg = Join-Path $env:USERPROFILE '.remote-pc\config.json'
$port = 7420; $preview = 7421
if (Test-Path $cfg) { $c = Get-Content $cfg -Raw | ConvertFrom-Json; if ($c.port) { $port = $c.port }; if ($c.previewPort) { $preview = $c.previewPort } }

& $ts serve --bg $port
& $ts serve --bg --https=8443 "http://127.0.0.1:$preview"   # agent site previews
& $ts serve status
Write-Host "`nDone. Restart Remote PC, then pair again from http://localhost:$port/pair"
