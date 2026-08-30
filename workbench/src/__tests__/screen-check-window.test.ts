/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { nativeWindowAdapter, parseAppleWindows, parseLinuxWindows, parseWindowsWindows, stableWindowCapture, type WindowAdapter } from '../screen-check-window';

const window = { id: '42', title: 'Atelier', owner: 'Browser', visible: true, minimized: false, foreground: true };

describe('native screen-check windows', () => {
  it('parses the three platform discovery shapes', () => {
    expect(parseAppleWindows('[{"id":"42","owner":"App","title":"One","foreground":true,"bounds":{"X":1,"Y":2,"Width":3,"Height":4}}]')[0]).toEqual(expect.objectContaining({ id: '42', owner: 'App', visible: true, foreground: true }));
    expect(parseLinuxWindows('0x2 0 123 1 2 300 200 host Window title', '0x2')[0]).toEqual(expect.objectContaining({ id: '0x2', title: 'Window title', minimized: false, foreground: true }));
    expect(parseWindowsWindows('{"id":"9","title":"Win","owner":"app","visible":true,"minimized":false,"foreground":true}')[0]).toEqual(expect.objectContaining({ id: '9', title: 'Win', foreground: true }));
  });

  it('uses native per-window commands on Apple, Linux and Windows desktops', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==', 'base64');
    const seen: string[] = []; const execute: any = (command: string, args: string[]) => {
      seen.push(`${command} ${args.join(' ')}`);
      if (command === 'screencapture' || command === 'import' || (command === 'powershell.exe' && args.join(' ').includes('PrintWindow'))) writeFileSync(args.at(-1)!, png);
      return { status: 0, stdout: command === 'wmctrl' ? '0x2 0 1 0 0 10 10 host title' : command === 'xprop' ? '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x2' : '[]', stderr: '' };
    };
    const apple = nativeWindowAdapter('darwin', {}, execute); apple.preflight(); apple.list();
    const linux = nativeWindowAdapter('linux', { DISPLAY: ':1' }, execute); linux.preflight(); linux.list();
    const windows = nativeWindowAdapter('win32', {}, execute); windows.preflight(); windows.list();
    expect(apple.capture('42')).toEqual(png); expect(linux.capture('0x2')).toEqual(png); expect(windows.capture('9')).toEqual(png);
    expect(seen.some((item) => item.startsWith('osascript '))).toBe(true);
    expect(seen.some((item) => item === 'wmctrl -lpG')).toBe(true);
    expect(seen.some((item) => item.startsWith('screencapture -x -l 42'))).toBe(true);
    expect(seen.some((item) => item.startsWith('import -window 0x2'))).toBe(true);
    expect(seen.some((item) => item.includes('PrintWindow'))).toBe(true);
    expect(seen.some((item) => item.startsWith('powershell.exe '))).toBe(true);
    expect(() => nativeWindowAdapter('linux', { WAYLAND_DISPLAY: 'wayland-0' }, execute)).toThrow('no safe per-window');
  });

  it('requires an explicit visible window and two matching frames', async () => {
    const capture = vi.fn().mockReturnValueOnce(Buffer.from('a')).mockReturnValue(Buffer.from('b'));
    const preflight = vi.fn(); const adapter: WindowAdapter = { name: 'fake', preflight, list: () => [window], capture };
    const result = await stableWindowCapture('42', adapter, 1, 3);
    expect(result.bytes.toString()).toBe('b'); expect(preflight).toHaveBeenCalledOnce(); expect(capture).toHaveBeenCalledTimes(3); expect(result.diagnostics).toContain('stable-frames=2');
    await expect(stableWindowCapture('missing', adapter, 1, 2)).rejects.toThrow('WINDOW_NOT_FOUND');
    await expect(stableWindowCapture('42', { ...adapter, list: () => [{ ...window, minimized: true }] }, 1, 2)).rejects.toThrow('hidden or minimized');
    await expect(stableWindowCapture('42', { ...adapter, list: () => [{ ...window, foreground: false }] }, 1, 2)).rejects.toThrow('WINDOW_OCCLUDED');
    await expect(stableWindowCapture('42', { ...adapter, preflight: () => { throw new Error('CAPTURE_PERMISSION_REQUIRED'); } }, 1, 2)).rejects.toThrow('CAPTURE_PERMISSION_REQUIRED');
    const changing: WindowAdapter = { ...adapter, capture: vi.fn().mockReturnValueOnce(Buffer.from('a')).mockReturnValueOnce(Buffer.from('b')) };
    await expect(stableWindowCapture('42', changing, 1, 2)).rejects.toThrow('WINDOW_UNSTABLE');
  });
});
