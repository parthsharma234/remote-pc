# Window helper: one command per line on stdin, one reply line on stdout.
# Lists app windows, moves/resizes them, and sends clicks, scrolls and typing to them.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false   # window titles with emoji / symbols arrive intact
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static void TypeText(string s) {
    foreach (char c in s) {
      if (c == '\n') { Key(0x0D, false); Key(0x0D, true); continue; }
      if (c == '\r') continue;
      var a = new INPUT[2];
      a[0].type = 1; a[0].u.ki.wScan = c; a[0].u.ki.dwFlags = 0x0004;
      a[1].type = 1; a[1].u.ki.wScan = c; a[1].u.ki.dwFlags = 0x0004 | 0x0002;
      SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
    }
  }
  public static void Key(byte vk, bool up) {
    uint f = up ? 0x0002u : 0u;
    if ((vk >= 0x21 && vk <= 0x2E) || vk == 0x5B) f |= 0x0001;
    keybd_event(vk, 0, f, UIntPtr.Zero);
  }

  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT v, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  public static List<IntPtr> TopWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;
      int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) return true;
      list.Add(h); return true;
    }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  // the visible frame (GetWindowRect includes invisible resize borders on Windows 10/11)
  public static RECT Visible(IntPtr h) { RECT r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r); return r; }
  public static void Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    if (GetForegroundWindow() == h) return;
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
  }
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  // the web page area inside a Chromium browser window (largest visible render widget)
  public static RECT Page(IntPtr p) {
    RECT best = new RECT(); long area = 0;
    EnumChildWindows(p, (h, l) => {
      var sb = new StringBuilder(64); GetClassName(h, sb, 64);
      if (sb.ToString() != "Chrome_RenderWidgetHostHWND" || !IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r); long a = (long)(r.R - r.L) * (r.B - r.T);
      if (a > area) { area = a; best = r; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  // put the *visible* frame exactly at x,y,w,h
  public static void Place(IntPtr h, int x, int y, int w, int hh) {
    if (IsZoomed(h) || IsIconic(h)) ShowWindow(h, 9);
    SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x0040 | 0x0004);
    RECT outer; GetWindowRect(h, out outer); RECT vis = Visible(h);
    int l = vis.L - outer.L, t = vis.T - outer.T, r = outer.R - vis.R, b = outer.B - vis.B;
    if (l != 0 || t != 0 || r != 0 || b != 0) SetWindowPos(h, IntPtr.Zero, x - l, y - t, w + l + r, hh + t + b, 0x0040 | 0x0004);
  }
}
"@
[W]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes

$VK = @{ enter=0x0D; esc=0x1B; tab=0x09; backspace=0x08; delete=0x2E; space=0x20; up=0x26; down=0x28; left=0x25; right=0x27; home=0x24; end=0x23; pageup=0x21; pagedown=0x22; ctrl=0x11; alt=0x12; shift=0x10; win=0x5B; f5=0x74 }
$iconCache = @{}
function Get-Icon([string]$path) {
  if (-not $path) { return $null }
  if ($iconCache.ContainsKey($path)) { return $iconCache[$path] }
  $uri = $null
  try {
    $ico = [Drawing.Icon]::ExtractAssociatedIcon($path); $bmp = $ico.ToBitmap(); $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $uri = 'data:image/png;base64,' + [Convert]::ToBase64String($ms.ToArray())
    $bmp.Dispose(); $ico.Dispose(); $ms.Dispose()
  } catch {}
  $iconCache[$path] = $uri; return $uri
}
function Reply([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
function Get-Hwnd($s) { [IntPtr][long]$s }
function Click([int]$x, [int]$y, [string]$b, [int]$n) {
  [W]::SetCursorPos($x, $y) | Out-Null
  $d = if ($b -eq 'right') { 0x08, 0x10 } else { 0x02, 0x04 }
  for ($i = 0; $i -lt $n; $i++) { [W]::mouse_event($d[0], 0, 0, 0, [UIntPtr]::Zero); [W]::mouse_event($d[1], 0, 0, 0, [UIntPtr]::Zero) }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line) { continue }
  try {
    $p = $line.Split(' ')
    switch ($p[0]) {
      'windows' {
        $fg = [W]::GetForegroundWindow()
        $procs = @{}; Get-Process | ForEach-Object { $procs[[uint32]$_.Id] = $_ }
        $list = foreach ($h in [W]::TopWindows()) {
          $wpid = [uint32]0; [W]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
          $proc = $procs[$wpid]; $path = $null; try { $path = $proc.Path } catch {}
          $name = $null; if ($proc) { try { $name = $proc.MainModule.FileVersionInfo.FileDescription } catch {} ; if (-not $name) { $name = $proc.ProcessName } }
          @{ id = [string]$h.ToInt64(); title = [W]::Title($h); app = $name; exe = $(if ($proc) { $proc.ProcessName } else { '' }); icon = (Get-Icon $path); min = [W]::IsIconic($h); active = ($h -eq $fg) }
        }
        Reply ("json " + (ConvertTo-Json -Compress -Depth 3 -InputObject @($list)))
      }
      'quick' {
        $list = foreach ($h in [W]::TopWindows()) {
          $wpid = [uint32]0; [W]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
          $pn = ''; try { $pn = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch {}
          @{ id = [string]$h.ToInt64(); title = [W]::Title($h); exe = $pn }
        }
        Reply ("json " + (ConvertTo-Json -Compress -InputObject @($list)))
      }
      # text boxes inside a window, as rectangles in screen pixels (for opening the phone keyboard)
      'fields' {
        $root = [Windows.Automation.AutomationElement]::FromHandle((Get-Hwnd $p[1]))
        $AE = [Windows.Automation.AutomationElement]
        $conds = @((New-Object Windows.Automation.PropertyCondition ($AE::ControlTypeProperty), ([Windows.Automation.ControlType]::Edit))) +
          @('Edit', 'RichEdit20W', 'RICHEDIT50W' | ForEach-Object { New-Object Windows.Automation.PropertyCondition ($AE::ClassNameProperty), $_ })
        $cond = New-Object Windows.Automation.OrCondition (,[Windows.Automation.Condition[]]$conds)
        $cr = New-Object Windows.Automation.CacheRequest
        $cr.Add([Windows.Automation.AutomationElement]::BoundingRectangleProperty); $cr.Add([Windows.Automation.AutomationElement]::IsOffscreenProperty); $cr.Add([Windows.Automation.AutomationElement]::IsEnabledProperty)
        $cr.AutomationElementMode = 'None'
        $act = $cr.Activate()
        try { $found = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $cond) } finally { $act.Dispose() }
        $list = foreach ($e in $found) {
          $c = $e.Cached
          if ($c.IsOffscreen -or -not $c.IsEnabled) { continue }
          $b = $c.BoundingRectangle
          if ($b.IsEmpty -or $b.Width -lt 8 -or $b.Height -lt 8) { continue }
          @{ x = [int]$b.X; y = [int]$b.Y; w = [int]$b.Width; h = [int]$b.Height }
        }
        Reply ("json " + (ConvertTo-Json -Compress -InputObject @($list)))
      }
      # is a text box focused right now (and where)?
      'focused' {
        $e = $null; try { $e = [Windows.Automation.AutomationElement]::FocusedElement } catch {}
        if (-not $e) { Reply 'json {"text":false}'; break }
        $ct = $e.Current.ControlType; $text = $false
        if ($ct -eq [Windows.Automation.ControlType]::Edit -or $e.Current.ClassName -match '(^|\.)(EDIT|RichEdit\w*)(\.|$)') { $text = $true }
        elseif ($ct -eq [Windows.Automation.ControlType]::Document) {
          # editable documents (rich editors) support text editing; plain web pages don't
          $vp = $null; if ($e.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $text = -not $vp.Current.IsReadOnly }
        }
        if ($text) { $vp = $null; if ($e.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -and $vp.Current.IsReadOnly) { $text = $false } }
        $b = $e.Current.BoundingRectangle
        Reply ("json " + (ConvertTo-Json -Compress -InputObject @{ text = $text; pid = $e.Current.ProcessId; x = [int]$b.X; y = [int]$b.Y; w = [int]$b.Width; h = [int]$b.Height }))
      }
      'screen' {
        $s = [Windows.Forms.Screen]::PrimaryScreen
        $dpi = 96; try { $dpi = [W]::GetDpiForSystem() } catch {}
        Reply ("json " + (ConvertTo-Json -Compress -InputObject @{ x = $s.Bounds.X; y = $s.Bounds.Y; w = $s.Bounds.Width; h = $s.Bounds.Height; wx = $s.WorkingArea.X; wy = $s.WorkingArea.Y; ww = $s.WorkingArea.Width; wh = $s.WorkingArea.Height; scale = $dpi / 96 }))
      }
      'page' {
        $r = [W]::Page((Get-Hwnd $p[1]))
        if ($r.R -le $r.L) { Reply 'json null' } else { Reply ("json " + (ConvertTo-Json -Compress -InputObject @{ x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T })) }
      }
      # browser state: address bar text and the tab strip (tabs above the page area)
      'chrome' {
        $h = Get-Hwnd $p[1]
        $pg = [W]::Page($h)
        if ($pg.R -le $pg.L) { Reply 'json null'; break }   # minimized or hidden: no reliable answer right now
        $root = [Windows.Automation.AutomationElement]::FromHandle($h)
        $AE = [Windows.Automation.AutomationElement]; $CT = [Windows.Automation.ControlType]
        $cr = New-Object Windows.Automation.CacheRequest
        $cr.Add($AE::BoundingRectangleProperty); $cr.Add($AE::NameProperty); $cr.Add($AE::ControlTypeProperty)
        $cr.Add([Windows.Automation.SelectionItemPattern]::IsSelectedProperty); $cr.Add([Windows.Automation.ValuePattern]::ValueProperty)
        $cr.AutomationElementMode = 'None'
        $cond = New-Object Windows.Automation.OrCondition ((New-Object Windows.Automation.PropertyCondition ($AE::ControlTypeProperty), $CT::TabItem), (New-Object Windows.Automation.PropertyCondition ($AE::ControlTypeProperty), $CT::Edit))
        $act = $cr.Activate()
        try { $found = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $cond) } finally { $act.Dispose() }
        $tabs = New-Object System.Collections.ArrayList; $url = $null; $urlRect = $null
        foreach ($e in $found) {
          $c = $e.Cached; $b = $c.BoundingRectangle
          # inside the page = part of the website, not the browser (tabs scrolled out of a narrow strip have no rect: keep them)
          if ($c.ControlType -eq $CT::TabItem -and $b.IsEmpty) { [void]$tabs.Add(@{ name = $c.Name; sel = $false; x = $null; y = $null }); continue }
          if ($b.IsEmpty -or $b.Y -ge $pg.T) { continue }
          if ($c.ControlType -eq $CT::Edit) {
            if ($null -eq $url) { $url = [string]$e.GetCachedPropertyValue([Windows.Automation.ValuePattern]::ValueProperty); $urlRect = @{ x = [int]$b.X; y = [int]$b.Y; w = [int]$b.Width; h = [int]$b.Height } }
          } else {
            $sel = $false; try { $sel = [bool]$e.GetCachedPropertyValue([Windows.Automation.SelectionItemPattern]::IsSelectedProperty) } catch {}
            [void]$tabs.Add(@{ name = $c.Name; sel = $sel; x = [int]($b.X + $b.Width / 2); y = [int]($b.Y + $b.Height / 2) })
          }
        }
        Reply ("json " + (ConvertTo-Json -Compress -Depth 3 -InputObject @{ url = $url; urlRect = $urlRect; tabs = @($tabs); page = @{ x = $pg.L; y = $pg.T; w = $pg.R - $pg.L; h = $pg.B - $pg.T } }))
      }
      'rect' {
        $h = Get-Hwnd $p[1]
        if (-not [W]::IsWindow($h)) { Reply 'json null'; break }
        $r = [W]::Visible($h)
        Reply ("json " + (ConvertTo-Json -Compress -InputObject @{ x = $r.L; y = $r.T; w = $r.R - $r.L; h = $r.B - $r.T; min = [W]::IsIconic($h); max = [W]::IsZoomed($h); front = ([W]::GetForegroundWindow() -eq $h); title = [W]::Title($h) }))
      }
      'exe' {
        $wpid = [uint32]0; [W]::GetWindowThreadProcessId((Get-Hwnd $p[1]), [ref]$wpid) | Out-Null
        $pn = ''; try { $pn = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch {}
        Reply ("json " + (ConvertTo-Json -Compress -InputObject $pn))
      }
      'focus'   { [W]::Focus((Get-Hwnd $p[1])); Reply 'ok' }
      'place'   { [W]::Place((Get-Hwnd $p[1]), [int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5]); Reply 'ok' }
      # topmost <hwnd> 1|0: keep a window above everything while the phone is viewing it (so the capture is that window)
      'topmost' { [W]::SetWindowPos((Get-Hwnd $p[1]), [IntPtr]$(if ($p[2] -eq '1') { -1 } else { -2 }), 0, 0, 0, 0, 0x0013) | Out-Null; Reply 'ok' }
      'maximize' { [W]::ShowWindow((Get-Hwnd $p[1]), 3) | Out-Null; Reply 'ok' }
      'close'   { [W]::PostMessage((Get-Hwnd $p[1]), 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; Reply 'ok' }
      # click <hwnd> <x> <y> <left|right> <count>: brings the window forward first so the click lands in it
      'click'   { [W]::Focus((Get-Hwnd $p[1])); Click ([int]$p[2]) ([int]$p[3]) $p[4] ([int]$p[5]); Reply 'ok' }
      'wheel'   { [W]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null; [W]::mouse_event(0x0800, 0, 0, [int]$p[3], [UIntPtr]::Zero); Reply 'ok' }
      'type'    { [W]::Focus((Get-Hwnd $p[1])); [W]::TypeText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2]))); Reply 'ok' }
      'key' {
        [W]::Focus((Get-Hwnd $p[1]))
        $codes = @(foreach ($k in $p[2].ToLower().Split('+')) { if ($VK.ContainsKey($k)) { [byte]$VK[$k] } elseif ($k -match '^[a-z0-9]$') { [byte][char]$k.ToUpper() } else { throw "unknown key $k" } })
        foreach ($c in $codes) { [W]::Key($c, $false) }; [array]::Reverse($codes); foreach ($c in $codes) { [W]::Key($c, $true) }
        Reply 'ok'
      }
      'launch'  { $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1])); if ($t -like 'shell:*') { Start-Process explorer.exe $t } else { Start-Process $t }; Reply 'ok' }
      'startapps' { Reply ("json " + (ConvertTo-Json -Compress -InputObject @(Get-StartApps | Where-Object { $_.Name -match '^(ChatGPT|Claude|Codex|Google Chrome|Visual Studio Code)$' } | ForEach-Object { @{ name = $_.Name; id = $_.AppID } }))) }
      default { Reply 'err unknown command' }
    }
  } catch { Reply ("err " + ($_.Exception.Message -replace "`r?`n", ' ')) }
}
