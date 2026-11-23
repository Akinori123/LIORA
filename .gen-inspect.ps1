
$ErrorActionPreference = 'Stop';
$pidTarget = 0;
$target = 'notepad';

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LioraUi {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static string Describe(uint pid, bool includeHidden, IntPtr onlyWindow) {
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (pid != 0) { if (wpid != pid) return true; }
      if (onlyWindow != IntPtr.Zero) { if (h != onlyWindow) return true; }
      if (!includeHidden) { if (!IsWindowVisible(h)) return true; }
      var title = new StringBuilder(512); GetWindowText(h, title, 512);
      if (title.Length == 0) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      RECT r; GetWindowRect(h, out r);
      // Separador '|' (não TAB): o escape \\t dentro do template literal JS
      // chegava ao C# como barra invertida + 't' literal, e o parser da tool
      // nunca encontrava as colunas (janelas "não encontradas" com o script
      // funcionando perfeitamente no console).
      sb.Append("WINDOW|" + title.ToString() + "|" + cls.ToString() + "|" + wpid + "|" + r.Left + "," + r.Top + "," + (r.Right-r.Left) + "x" + (r.Bottom-r.Top) + "\n");
      int idx = 0;
      EnumChildWindows(h, (c, l2) => {
        var ct = new StringBuilder(512); GetWindowText(c, ct, 512);
        var cc = new StringBuilder(256); GetClassName(c, cc, 256);
        bool vis = IsWindowVisible(c);
        bool en = IsWindowEnabled(c);
        bool visAllowed = includeHidden ? true : vis;
        if (!visAllowed) return true;
        RECT cr; GetWindowRect(c, out cr);
        string ctext = ct.ToString();
        if (ctext.Length == 0) ctext = "-";
        sb.Append("CHILD|" + idx + "|" + ctext + "|" + cc.ToString() + "|" + (vis ? "1" : "0") + "|" + (en ? "1" : "0") + "|" + cr.Left + "," + cr.Top + "," + (cr.Right-cr.Left) + "x" + (cr.Bottom-cr.Top) + "\n");
        idx++;
        return true;
      }, IntPtr.Zero);
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
$onlyWindow = [IntPtr]::Zero;
if ($pidTarget -eq 0) { $onlyWindow = [LioraUi]::GetForegroundWindow(); }
$result = [LioraUi]::Describe([uint32]$pidTarget, $false, $onlyWindow)
Write-Output $result
