import { expect, test as baseTest, chromium } from '@playwright/test';
const test = baseTest.extend({ browser: [async ({}, use) => { const browser = await chromium.connectOverCDP(process.env.CDP_URL!); await use(browser); }, { scope: 'worker' }] });
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import type { ChatWidget } from '../../src/workbench/chat-widgets';

const CHAT = 'visual-gallery';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { widgetSpecs } from '../../src/workbench/chat-widgets';

test('meshlet geometry moves continuously with synchronized camera and selection', async ({ page, request }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 2100 });
  const visuals: ChatWidget[] = ['mesh-torus', 'mesh-folded'].map(name => widgetSpecs(execFileSync(process.env.ATELIER_BINARY!, ['tool', 'present', 'artifact', '--file', join(process.cwd(), 'tests/fixtures', `${name}.json`)], { env: process.env, encoding: 'utf8' }))[0]!);
  const common = { sessionId: CHAT, at: new Date(0).toISOString() };
  const events: WbpEvent[] = [{ ...common, seq: 1, type: 'session.started', brand: 'codex', externalId: 'gallery', model: 'gpt-5', cwd: process.cwd(), permissionMode: 'on-request' }];
  let seq = 2;
  visuals.forEach((visual, index) => {
    const messageId = `visual-${index}`;
    events.push(
      { ...common, seq: seq++, type: 'message.started', messageId, role: 'assistant' },
      { ...common, seq: seq++, type: 'text.delta', messageId, text: `\`\`\`atelier-widget\n${JSON.stringify(visual)}\n\`\`\`` },
      { ...common, seq: seq++, type: 'widget', messageId, widget: visual },
      { ...common, seq: seq++, type: 'message.completed', messageId },
    );
  });
  events.push({ ...common, seq, type: 'session.state', state: 'idle', label: 'Ready' });
  const snapshot = foldAll(events);
  await page.addInitScript(({ chat, view }) => {
    class Socket {
      static OPEN = 1; static CLOSED = 3; readyState = 1;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(url: string) { if (new URL(url).searchParams.get('chat') === chat) setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ tag: 'chat.snapshot', scope: chat, data: JSON.stringify(view) }) })), 0); }
      close() { this.readyState = 3; } send() {}
    }
    Object.defineProperty(window, 'WebSocket', { value: Socket, configurable: true });
  }, { chat: CHAT, view: snapshot });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => { if (route.request().method() !== 'GET') return route.continue(); const url = new URL(route.request().url()); url.searchParams.set('include_test', 'true'); await route.continue({ url: url.toString() }); });
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'gallery', brand: 'codex', title: 'Animated gallery', name: 'Animated gallery', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'gallery', runningElsewhere: false, held: null, title: 'Animated gallery', name: 'Animated gallery', cwd: process.cwd() } }));
  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Animated visual gallery', path: process.cwd(), isTest: true } });
    expect(made.status(), await made.text()).toBe(201); project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Animated gallery' }).getByTestId('row-name').click();
    await page.bringToFront();
    const widget = page.getByTestId('mesh-artifact').first();
    await expect(widget.getByTestId('mesh-counts')).toContainText('triangles submitted');
    await expect(widget.getByRole('alert')).toHaveCount(0);
    const observer = widget.getByTestId('mesh-observer');
    const camera = widget.getByTestId('mesh-camera');
    await observer.scrollIntoViewIfNeeded();
    const beforeObserver = await observer.screenshot();
    const beforeCamera = await camera.screenshot();
    const beforeCounts = await widget.getByTestId('mesh-counts').textContent();
    await widget.getByRole('button', {name: 'Play camera', exact: true}).click();
    await page.waitForTimeout(1600);
    await widget.getByRole('button', {name: 'Pause', exact: true}).click();
    expect(Number(await widget.getAttribute('data-progress'))).toBeGreaterThan(.02);
    expect((await observer.screenshot()).equals(beforeObserver)).toBe(false);
    expect((await camera.screenshot()).equals(beforeCamera)).toBe(false);
    const paused = await widget.getAttribute('data-progress');
    await page.waitForTimeout(250);
    expect(await widget.getAttribute('data-progress')).toBe(paused);
    await widget.getByRole('slider', {name: 'Camera path', exact: true}).fill('0.55');
    await expect(widget).toHaveAttribute('data-progress','0.5500');
    await widget.getByRole('combobox', {name:'Meshlet',exact:true}).click();
    await page.getByRole('option').nth(10).click();
    await expect(widget.getByTestId('mesh-decision')).not.toBeEmpty();
    await widget.screenshot({path:'/tmp/bw-ffzat-mesh.png'});
    await widget.getByRole('checkbox', {name:'Frustum culling',exact:true}).uncheck();
    await widget.getByRole('checkbox', {name:'Backface culling',exact:true}).uncheck();
    await expect(widget.getByTestId('mesh-counts')).toContainText('32 kept');
    await expect(widget.getByTestId('mesh-counts')).toContainText('1024 / 1024');
    await widget.getByRole('checkbox', {name:'Frustum culling',exact:true}).check();
    await widget.getByRole('checkbox', {name:'Backface culling',exact:true}).check();
    await widget.getByRole('slider', {name:'Field of view',exact:true}).fill('10');
    expect(await widget.getByTestId('mesh-counts').textContent()).not.toBe(beforeCounts);
    await widget.getByRole('slider', {name:'Field of view',exact:true}).fill('36');
    // Observer orbit changes only the observer image, not culling or camera view.
    const counts = await widget.getByTestId('mesh-counts').textContent();
    const cameraImage = await camera.screenshot();
    const box = (await observer.boundingBox())!;
    await page.mouse.move(box.x+box.width*.3,box.y+box.height*.4);
    await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.5,{steps:12});await page.mouse.up();
    expect(await widget.getByTestId('mesh-counts').textContent()).toBe(counts);
    expect((await camera.screenshot()).equals(cameraImage)).toBe(true);
    await widget.getByRole('button',{name:'Reset observer'}).click();
    await page.emulateMedia({reducedMotion:'reduce'});
    await expect(widget.getByRole('button',{name:'Play camera',exact:true})).toBeDisabled();
    await widget.getByRole('slider',{name:'Camera path',exact:true}).fill('0.7');
    await expect(widget).toHaveAttribute('data-progress','0.7000');
    await page.emulateMedia({reducedMotion:'no-preference'});
    const second = page.getByTestId('mesh-artifact').nth(1);
    await second.getByRole('slider',{name:'Camera path',exact:true}).fill('0.3');
    await expect(second.getByRole('alert')).toHaveCount(0);
    await second.screenshot({path:'/tmp/bw-ffzat-folded.png'});
    for (const name of ['Hide chats','Hide chat details']) { const button=page.getByRole('button',{name,exact:true});if(await button.isVisible())await button.click(); }
    for(const width of [390,768,1024,1280,1920]) {
      await page.setViewportSize({width,height:1200});
      await widget.scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await widget.screenshot({path:`/tmp/bw-ffzat-mesh-${width}.png`});
    }
    await page.setViewportSize({width:1440,height:1500});
    await widget.getByRole('button',{name:'Restart',exact:true}).click();
    await widget.getByRole('button',{name:'Play camera',exact:true}).click();
    // Real rendered frames, captured while the RAF camera animation runs.
    for(let i=0;i<36;i++) { await widget.screenshot({path:`/tmp/bw-ffzat-motion-${String(i).padStart(3,'0')}.png`});await page.waitForTimeout(100); }
    await widget.getByRole('button',{name:'Pause',exact:true}).click();
    await page.getByRole('button',{name:'Open artifact full screen',exact:true}).first().click();
    const full = page.getByRole('dialog').getByTestId('mesh-artifact');
    await expect(full.getByRole('alert')).toHaveCount(0);
    await full.getByRole('slider',{name:'Camera path',exact:true}).fill('0.25');
    await expect(full).toHaveAttribute('data-progress','0.2500');
    await page.getByRole('button',{name:'Close full-screen artifact'}).click();
    await page.reload();
    await expect(page.getByTestId('mesh-artifact').first()).toHaveAttribute('data-progress','0.0000');
    expect(errors).toEqual([]);
  } finally { if(project) await request.delete(`/api/projects/${project.id}`); }
});
