# Start Remote PC automatically (hidden) every time you log in.
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1          # install
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Admin   # install elevated (run from an admin PowerShell):
#                                                                           #   lets you control admin windows like Task Manager
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove  # uninstall
param([switch]$Remove, [switch]$Admin)
$name = 'RemotePC'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed autostart."
  return
}
$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node).Source
$log = Join-Path $env:USERPROFILE '.remote-pc\server.log'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$node`" `"$root\server.js`" > `"$log`" 2>&1`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel $(if ($Admin) { 'Highest' } else { 'Limited' })
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Remote PC will start hidden at every login$(if ($Admin) { ' (elevated)' }). Log: $log"
Write-Host "Start it now with: Start-ScheduledTask $name"
