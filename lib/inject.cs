// rpc-inject: types into the terminal of a running process, as if you typed it there.
// Used to deliver phone messages to an agent that's open in a terminal (incl. VS Code's), so the
// conversation stays one conversation and shows up live on the PC.
//   rpc-inject <pid> text <base64-utf8>   type text (newlines become line breaks, not submits)
//   rpc-inject <pid> key enter|esc        press one key
// Exit code 0 = done. Works without focusing any window (writes to the process's console input).
using System;
using System.Runtime.InteropServices;
using System.Text;

static class Inject {
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] recs, uint n, out uint written);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct CSBI { public COORD size, cursor; public ushort attr; public SMALL_RECT win; public COORD max; }
  [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI i);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool ReadConsoleOutputCharacter(IntPtr h, StringBuilder s, uint n, COORD at, out uint read);
  // rpc-inject <pid> screen : prints the visible text of that terminal (for diagnostics)
  static int Screen(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return 3;
    IntPtr h = CreateFile("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    CSBI i; GetConsoleScreenBufferInfo(h, out i);
    var sb = new StringBuilder();
    for (short y = i.win.T; y <= i.win.B; y++) {
      var line = new StringBuilder(i.size.X + 1); uint r; var at = new COORD(); at.X = 0; at.Y = y;
      ReadConsoleOutputCharacter(h, line, (uint)i.size.X, at, out r); sb.AppendLine(line.ToString().TrimEnd());
    }
    CloseHandle(h); FreeConsole();
    System.IO.File.WriteAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "rpc-screen-" + pid + ".txt"), sb.ToString());
    return 0;
  }

  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
  struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int bKeyDown;
    [FieldOffset(8)] public ushort wRepeatCount;
    [FieldOffset(10)] public ushort wVirtualKeyCode;
    [FieldOffset(12)] public ushort wVirtualScanCode;
    [FieldOffset(14)] public char UnicodeChar;
    [FieldOffset(16)] public uint dwControlKeyState;
  }
  static INPUT_RECORD Rec(char c, ushort vk, bool down) {
    var r = new INPUT_RECORD(); r.EventType = 1; r.bKeyDown = down ? 1 : 0; r.wRepeatCount = 1;
    r.wVirtualKeyCode = vk; r.UnicodeChar = c; return r;
  }

  static int Main(string[] a) {
    if (a.Length == 2 && a[1] == "screen") return Screen(uint.Parse(a[0]));
    if (a.Length < 3) { Console.Error.WriteLine("usage: rpc-inject <pid> text <b64> | key enter|esc"); return 2; }
    uint pid = uint.Parse(a[0]);
    var recs = new System.Collections.Generic.List<INPUT_RECORD>();
    if (a[1] == "text") {
      string s = Encoding.UTF8.GetString(Convert.FromBase64String(a[2])).Replace("\r\n", "\n");
      foreach (char ch in s) {
        char c = ch == '\n' ? '\r' : ch;
        ushort vk = (ushort)(c == '\r' ? 0x0D : 0);
        recs.Add(Rec(c, vk, true)); recs.Add(Rec(c, vk, false));
      }
    } else if (a[1] == "key") {
      if (a[2] == "enter") { recs.Add(Rec('\r', 0x0D, true)); recs.Add(Rec('\r', 0x0D, false)); }
      else if (a[2] == "esc") { recs.Add(Rec((char)27, 0x1B, true)); recs.Add(Rec((char)27, 0x1B, false)); }
      else if (a[2] == "down") { recs.Add(Rec((char)0, 0x28, true)); recs.Add(Rec((char)0, 0x28, false)); }
      else if (a[2] == "up") { recs.Add(Rec((char)0, 0x26, true)); recs.Add(Rec((char)0, 0x26, false)); }
      else { Console.Error.WriteLine("unknown key"); return 2; }
    }
    FreeConsole();
    if (!AttachConsole(pid)) { Console.Error.WriteLine("attach failed " + Marshal.GetLastWin32Error()); return 3; }
    IntPtr h = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) { Console.Error.WriteLine("no console input"); FreeConsole(); return 4; }
    var arr = recs.ToArray(); uint done = 0; bool ok = true;
    // write in chunks so long prompts don't overflow the input buffer
    for (int i = 0; i < arr.Length && ok; i += 512) {
      int n = Math.Min(512, arr.Length - i); var part = new INPUT_RECORD[n]; Array.Copy(arr, i, part, 0, n);
      uint w; ok = WriteConsoleInput(h, part, (uint)n, out w); done += w;
      if (arr.Length > 512) System.Threading.Thread.Sleep(15);
    }
    CloseHandle(h); FreeConsole();
    return ok ? 0 : 5;
  }
}
