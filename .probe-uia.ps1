Start-Process notepad
Start-Sleep -Milliseconds 2500
$target = 'notepad'
$cands = Get-Process -ErrorAction SilentlyContinue | Where-Object { ($_.ProcessName -like "*$target*" -or $_.MainWindowTitle -like "*$target*") -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if ($cands) { Write-Output "RESOLVEU PID=$($cands.Id) nome=$($cands.ProcessName)" } else { Write-Output 'NAO_RESOLVEU' }
# lista candidatos para entender
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*note*' } | ForEach-Object { Write-Output ("CAND: " + $_.ProcessName + " pid=" + $_.Id + " hwnd=" + $_.MainWindowHandle) }
Stop-Process -Name notepad -Force -ErrorAction SilentlyContinue
