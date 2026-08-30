import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type NativeWindow = { id: string; title: string; owner: string; bounds?: { x: number; y: number; width: number; height: number }; visible: boolean; minimized: boolean; foreground: boolean };
export type WindowAdapter = { name: string; preflight(): void; list(): NativeWindow[]; capture(id: string): Buffer };
type Run = (command: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };

const run: Run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error };
};

function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function windowId(value: string): string {
  try { return BigInt(value).toString(16); } catch { return value.trim().toLowerCase().replace(/^0x0*/, ''); }
}

export function parseAppleWindows(stdout: string): NativeWindow[] {
  const rows = JSON.parse(stdout || '[]') as Array<Record<string, any>>;
  return rows.filter((row) => row.id && row.owner).map((row) => ({ id: String(row.id), title: String(row.title || ''), owner: String(row.owner),
    bounds: row.bounds ? { x: number(row.bounds.X), y: number(row.bounds.Y), width: number(row.bounds.Width), height: number(row.bounds.Height) } : undefined,
    visible: true, minimized: false, foreground: Boolean(row.foreground) }));
}

export function parseLinuxWindows(stdout: string, foregroundId = '', hiddenIds: Iterable<string> = []): NativeWindow[] {
  const foreground = windowId(foregroundId); const hidden = new Set(Array.from(hiddenIds, windowId));
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.trim().split(/\s+/); if (parts.length < 8) throw new Error(`WINDOW_DISCOVERY_UNAVAILABLE: unreadable wmctrl row: ${line}`);
    const minimized = hidden.has(windowId(parts[0]));
    return { id: parts[0], minimized, visible: !minimized, foreground: windowId(parts[0]) === foreground, owner: `pid ${parts[2]}`,
      bounds: { x: Number(parts[3]), y: Number(parts[4]), width: Number(parts[5]), height: Number(parts[6]) }, title: parts.slice(8).join(' ') || parts[7] };
  });
}

export function parseWindowsWindows(stdout: string): NativeWindow[] {
  const parsed = JSON.parse(stdout || '[]'); const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.filter((row) => row?.id).map((row) => ({ id: String(row.id), title: String(row.title || ''), owner: String(row.owner || ''),
    bounds: row.bounds ? { x: number(row.bounds.x), y: number(row.bounds.y), width: number(row.bounds.width), height: number(row.bounds.height) } : undefined,
    visible: Boolean(row.visible), minimized: Boolean(row.minimized), foreground: Boolean(row.foreground) }));
}

const APPLE_LIST = `ObjC.import('CoreGraphics');const a=ObjC.deepUnwrap($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly|$.kCGWindowListExcludeDesktopElements,$.kCGNullWindowID)).filter(w=>w.kCGWindowLayer===0);JSON.stringify(a.map((w,i)=>({id:String(w.kCGWindowNumber),owner:w.kCGWindowOwnerName,title:w.kCGWindowName||'',bounds:w.kCGWindowBounds,foreground:i===0})))`;
const APPLE_PREFLIGHT = `ObjC.import('CoreGraphics');if(!$.CGPreflightScreenCaptureAccess()) throw new Error('screen capture permission is not granted')`;
const WINDOWS_LIST = `$s='[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern bool IsIconic(IntPtr h);[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();';Add-Type -MemberDefinition $s -Name W -Namespace A;$f=[A.W]::GetForegroundWindow();Get-Process|Where-Object {$_.MainWindowHandle -ne 0}|ForEach-Object {[pscustomobject]@{id=$_.MainWindowHandle.ToInt64().ToString();title=$_.MainWindowTitle;owner=$_.ProcessName;visible=[A.W]::IsWindowVisible($_.MainWindowHandle);minimized=[A.W]::IsIconic($_.MainWindowHandle);foreground=$_.MainWindowHandle -eq $f}}|ConvertTo-Json -Compress`;
const WINDOWS_PREFLIGHT = `Add-Type -AssemblyName System.Drawing;$s='[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();';Add-Type -MemberDefinition $s -Name P -Namespace A;if([A.P]::GetForegroundWindow() -eq [IntPtr]::Zero){exit 3}`;
const WINDOWS_CAPTURE = `$id=[IntPtr]::new([long]$args[0]);$out=$args[1];Add-Type -AssemblyName System.Drawing;$s='[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr h,IntPtr d,uint f);public struct R{public int L;public int T;public int Rg;public int B;}';Add-Type -MemberDefinition $s -Name C -Namespace A;$r=New-Object A.C+R;if(![A.C]::GetWindowRect($id,[ref]$r)){exit 3};$w=$r.Rg-$r.L;$h=$r.B-$r.T;if($w -lt 1 -or $h -lt 1){exit 3};$b=New-Object Drawing.Bitmap $w,$h;$g=[Drawing.Graphics]::FromImage($b);$dc=$g.GetHdc();$ok=[A.C]::PrintWindow($id,$dc,2);$g.ReleaseHdc($dc);if(!$ok){$g.Dispose();$b.Dispose();exit 3};$b.Save($out,[Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$b.Dispose()`;

function command(adapter: string, result: ReturnType<Run>): string {
  if (result.error || result.status !== 0) throw new Error(`${adapter}: ${result.error?.message || result.stderr.trim() || 'command failed'}`);
  return result.stdout;
}

export function nativeWindowAdapter(platform = process.platform, environment = process.env, execute: Run = run): WindowAdapter {
  if (platform === 'darwin') return {
    name: 'apple-window', preflight: () => { command('CAPTURE_PERMISSION_REQUIRED', execute('osascript', ['-l', 'JavaScript', '-e', APPLE_PREFLIGHT])); },
    list: () => parseAppleWindows(command('WINDOW_DISCOVERY_UNAVAILABLE', execute('osascript', ['-l', 'JavaScript', '-e', APPLE_LIST]))),
    capture: (id) => captureFile((out) => execute('screencapture', ['-x', '-l', id, out]), 'CAPTURE_PERMISSION_REQUIRED'),
  };
  if (platform === 'linux') {
    if (environment.WAYLAND_DISPLAY && !environment.DISPLAY) throw new Error('WINDOW_CAPTURE_UNAVAILABLE: this Wayland session exposes no safe per-window capture API');
    return { name: 'linux-window', preflight: () => { command('CAPTURE_PERMISSION_REQUIRED: cannot access the X display', execute('xdpyinfo', [])); },
      list: () => {
        const active = command('WINDOW_DISCOVERY_UNAVAILABLE: install xprop', execute('xprop', ['-root', '_NET_ACTIVE_WINDOW'])).match(/0x[0-9a-f]+/i)?.[0] ?? '';
        const listing = command('WINDOW_DISCOVERY_UNAVAILABLE: install wmctrl', execute('wmctrl', ['-lpG'])).trim(); const rows = parseLinuxWindows(listing, active);
        const inspected = new Set<string>(); const hidden = new Set<string>();
        for (const row of rows) {
          const state = execute('xprop', ['-id', row.id, '_NET_WM_STATE']);
          if (state.error || state.status !== 0) continue;
          inspected.add(windowId(row.id)); if (/(?:^|[ ,])_NET_WM_STATE_HIDDEN(?:$|[ ,])/m.test(state.stdout)) hidden.add(row.id);
        }
        return parseLinuxWindows(listing, active, hidden).filter((row) => inspected.has(windowId(row.id)));
      },
      capture: (id) => captureFile((out) => execute('import', ['-window', id, out]), 'CAPTURE_PERMISSION_REQUIRED: install ImageMagick and grant window capture') };
  }
  if (platform === 'win32') return {
    name: 'windows-window', preflight: () => { command('CAPTURE_PERMISSION_REQUIRED', execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PREFLIGHT])); },
    list: () => parseWindowsWindows(command('WINDOW_DISCOVERY_UNAVAILABLE', execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LIST]))),
    capture: (id) => captureFile((out) => execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CAPTURE, id, out]), 'CAPTURE_PERMISSION_REQUIRED'),
  };
  throw new Error('WINDOW_CAPTURE_UNAVAILABLE: unsupported platform');
}

function captureFile(invoke: (out: string) => ReturnType<Run>, error: string): Buffer {
  const root = mkdtempSync(join(tmpdir(), 'atelier-window-')); const out = join(root, 'window.png');
  try {
    command(error, invoke(out)); const bytes = readFileSync(out);
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`${error}: capture did not produce a PNG`);
    return bytes;
  }
  finally { rmSync(root, { recursive: true, force: true }); }
}

export async function stableWindowCapture(id: string, adapter = nativeWindowAdapter(), intervalMs = 200, retries = 5): Promise<{ bytes: Buffer; window: NativeWindow; diagnostics: string[] }> {
  adapter.preflight();
  const window = adapter.list().find((item) => item.id === id);
  if (!window) throw new Error('WINDOW_NOT_FOUND: list windows again and use one exact current ID');
  if (!window.visible || window.minimized) throw new Error('WINDOW_NOT_CAPTURABLE: the selected window is hidden or minimized');
  if (!window.foreground) throw new Error('WINDOW_OCCLUDED: bring the selected window fully to the foreground, then list windows again');
  let previous: Buffer | null = null; let previousHash = '';
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const bytes = adapter.capture(id); const hash = createHash('sha256').update(bytes).digest('hex');
    if (previous && hash === previousHash) return { bytes, window, diagnostics: [`adapter=${adapter.name}`, `window=${id}`, `stable-frames=2`, `attempts=${attempt}`] };
    previous = bytes; previousHash = hash;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`WINDOW_UNSTABLE: ${retries} captures did not produce two matching frames`);
}
