import { execFileSync } from 'node:child_process';

// Reproduz EXATAMENTE o script gerado pela tool.
const ps = `
$ErrorActionPreference = 'Stop';
$pidTarget = 0;
$target = 'notepad';

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LioraUiT {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string Describe(uint pid) {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (pid != 0 && wpid != pid) return true;
      var title = new StringBuilder(512); GetWindowText(h, title, 512);
      if (title.Length > 0) sb.Append("WINDOW\\t" + title.ToString() + "\\n");
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
if ($pidTarget -eq 0 -and $target) {
  $cands = Get-Process -ErrorAction SilentlyContinue | Where-Object { ($_.ProcessName -like "*$target*") -or ($_.MainWindowTitle -like "*$target*") } | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1;
  if ($cands) { $pidTarget = [uint32]$cands.Id }
}
Write-Output ("PID_TARGET=" + $pidTarget)
Write-Output ([LioraUiT]::Describe([uint32]$pidTarget))
`;

try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  console.log('STDOUT:\n' + out);
} catch (e: any) {
  console.log('ERRO:', e.message);
  console.log('STDERR:\n' + String(e.stderr || '').slice(0, 1500));
  console.log('STDOUT:\n' + String(e.stdout || '').slice(0, 800));
}
