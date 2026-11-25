# Optional hardening: let Remote PC's ports through the Windows firewall on the Tailscale network only.
# Run from an admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\firewall.ps1           # add the rule
#   powershell -ExecutionPolicy Bypass -File scripts\firewall.ps1 -Remove   # remove it
param([switch]$Remove)
$name = 'Remote PC (Tailscale only)'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Please run this from an admin PowerShell.'; exit 1
}
Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
if ($Remove) { Write-Host "Removed '$name'."; return }

$cfg = Join-Path $env:USERPROFILE '.remote-pc\config.json'
$ports = @(7420, 7421)
if (Test-Path $cfg) {
  $c = Get-Content $cfg -Raw | ConvertFrom-Json
  $ports = @($(if ($c.port) { $c.port } else { 7420 }), $(if ($c.previewPort) { $c.previewPort } else { 7421 }))
}

New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $ports -InterfaceAlias 'Tailscale' | Out-Null
Write-Host "Allowed TCP $($ports -join ', ') on the Tailscale interface only."
Write-Host 'Tip: if Windows asked to allow Node.js on other networks earlier, remove that rule in "Windows Defender Firewall > Allowed apps".'
