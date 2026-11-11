import { expect, test as baseTest, chromium } from '@playwright/test';
const test = baseTest.extend({ browser: [async ({}, use) => { const browser = await chromium.connectOverCDP(process.env.CDP_URL!); await use(browser); }, { scope: 'worker' }] });
import { foldAll } from '../../src/workbench/fold';
import type { WbpEvent } from '../../src/workbench/protocol';
import type { ChatWidget } from '../../src/workbench/chat-widgets';

const CHAT = 'visual-gallery';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { widgetSpecs } from '../../src/workbench/chat-widgets';

test('directed composition plays and seeks inside an isolated frame', async ({ page, request, browser }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 2100 });
  writeFileSync('/tmp/bw-2txyi-probe.json', JSON.stringify({version:1,kind:'composition',title:'Isolation probe',width:800,height:450,html:`<div id="result">starting</div><script>
(async()=>{const r={script:true,parent:false,storage:false,fetch:false,image:false,navigation:false,popup:false};
try{parent.document.body.dataset.compromised='true';r.parent=true}catch{}
try{localStorage.setItem('composition-probe','yes');r.storage=true}catch{}
try{await fetch('/api/projects');r.fetch=true}catch{}
try{r.popup=!!window.open('about:blank')}catch{}
try{top.location.href='https://example.invalid/composition-escape';r.navigation=true}catch{}
await new Promise(done=>{const i=new Image;i.onload=()=>{r.image=true;done()};i.onerror=done;i.src='https://example.invalid/composition-image'});
document.querySelector('#result').textContent=JSON.stringify(r)})();<\/script>`}));
  const visuals: ChatWidget[] = ['/tmp/bw-2txyi-meshlets.json', '/tmp/bw-2txyi-probe.json', '/tmp/bw-2txyi-cache.json'].map(file => widgetSpecs(execFileSync(process.env.ATELIER_BINARY!, ['tool', 'present', 'artifact', '--file', file], { env: process.env, encoding: 'utf8' }))[0]!);
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
  await page.route(/\/api\/workbench\/restore(?:\?.*)?$/, (route) => route.fulfill({ json: [{ sessionId: CHAT, externalId: 'gallery', brand: 'codex', title: 'Animated gallery', name: 'Animated gallery', state: 'idle', lastActiveAt: new Date(0).toISOString(), cwdHint: process.cwd(), runningElsewhere: false, held: null, beads: [] }] }));
  await page.route(new RegExp(`/api/workbench/session/${CHAT}$`), (route) => route.fulfill({ json: { sessionId: CHAT, origin: 'terminal', brand: 'codex', externalId: 'gallery', runningElsewhere: false, held: null, title: 'Animated gallery', name: 'Animated gallery', cwd: process.cwd(), beads: [] } }));
  let project: { id: string } | null = null;
  try {
    const made = await request.post('/api/projects', { data: { name: 'Animated visual gallery', path: process.cwd(), isTest: true } });
    expect(made.status(), await made.text()).toBe(201); project = await made.json();
    await page.goto(`/project?id=${project!.id}&tab=chat`);
    await page.getByTestId('restore-row').filter({ hasText: 'Animated gallery' }).getByTestId('row-name').click();
    await page.bringToFront();
    const widget = page.getByTestId('composition-artifact').first();
    await expect(widget).toHaveAttribute('sandbox','allow-scripts');
    const film = widget.contentFrame();
    await expect(film.getByRole('button',{name:'Play',exact:true})).toBeVisible();
    await expect(film.getByRole('alert')).toHaveCount(0);
    await widget.scrollIntoViewIfNeeded();
    const start = await widget.screenshot();
    await film.getByRole('button',{name:'Play',exact:true}).click();
    await page.waitForTimeout(1800);
    await widget.hover();
    await film.getByRole('button',{name:'Pause',exact:true}).click();
    expect((await widget.screenshot()).equals(start)).toBe(false);
    const main = film.locator('main');
    const paused = await main.getAttribute('data-frame');
    expect(Number(paused)).toBeGreaterThan(10);
    await page.waitForTimeout(300);
    expect(await main.getAttribute('data-frame')).toBe(paused);
    await film.getByRole('slider',{name:'Timeline',exact:true}).fill('850');
    await expect(main).toHaveAttribute('data-frame','850');
    await film.getByRole('slider',{name:'Timeline',exact:true}).press('ArrowRight');
    await expect(main).toHaveAttribute('data-frame','851');
    const chapters=film.getByRole('navigation',{name:'Chapters'}).getByRole('button');
    expect(await chapters.count()).toBeGreaterThanOrEqual(4);
    for(let i=0;i<await chapters.count();i++){
      await chapters.nth(i).click();
      await expect(chapters.nth(i)).toHaveAttribute('aria-current','step');
      await page.waitForTimeout(120);
      await widget.screenshot({path:`/tmp/bw-2txyi-chapter-${i}.png`});
      await film.getByRole('button',{name:'Play',exact:true}).click();
      await page.waitForTimeout(i===2?6500:4000);
      await widget.hover();
      await film.getByRole('button',{name:'Pause',exact:true}).click();
      await widget.screenshot({path:`/tmp/bw-2txyi-chapter-${i}-midpoint.png`});
    }
    for(const frame of [780,990,1260,1410]){
      await film.getByRole('slider',{name:'Timeline',exact:true}).fill(String(frame));
      await expect(main).toHaveAttribute('data-frame',String(frame));
      await widget.screenshot({path:`/tmp/bw-2txyi-frame-${frame}.png`});
    }
    const cache=page.getByTestId('composition-artifact').nth(2);
    const cacheFilm=cache.contentFrame();
    await cacheFilm.getByRole('navigation',{name:'Chapters'}).getByRole('button').last().click();
    await cache.screenshot({path:'/tmp/bw-2txyi-cache.png'});
    await expect(cacheFilm.getByRole('alert')).toHaveCount(0);
    const probe=page.getByTestId('composition-artifact').nth(1).contentFrame();
    await expect(probe.locator('#result')).toContainText('"script":true');
    const result=JSON.parse(await probe.locator('#result').innerText());
    expect(result).toEqual({script:true,parent:false,storage:false,fetch:false,image:false,navigation:false,popup:false});
    expect(await page.locator('body').getAttribute('data-compromised')).toBeNull();
    expect(page.url()).toContain('/project?');
    for (const name of ['Hide chats','Hide chat details']) { const button=page.getByRole('button',{name,exact:true});if(await button.isVisible())await button.click(); }
    for(const width of [390,768,1024,1280,1920]){
      await page.setViewportSize({width,height:1100});
      await widget.scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect(await film.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth)).toBe(true);
      await film.getByRole('slider',{name:'Timeline',exact:true}).fill('480');
      await page.waitForTimeout(400);
      await widget.screenshot({path:`/tmp/bw-2txyi-composition-${width}.png`});
      const frameBox=await widget.boundingBox();
      await expect.poll(async()=>(await film.locator('canvas').first().boundingBox())!.width).toBeGreaterThan(frameBox!.width*.7);
    }
    await page.setViewportSize({width:1440,height:1200});
    const originalFrame=await widget.elementHandle();
    const beforeFullscreen=await main.getAttribute('data-frame');
    await page.getByRole('button',{name:'Open artifact full screen',exact:true}).first().click();
    const full=page.getByTestId('composition-presentation').first().getByTestId('composition-artifact');
    await expect(main).toHaveAttribute('data-frame',beforeFullscreen!);
    expect(await full.evaluate((el,old)=>el===old,originalFrame)).toBe(true);
    await expect(full.contentFrame().getByRole('button',{name:'Play',exact:true})).toBeVisible();
    await full.contentFrame().getByRole('navigation',{name:'Chapters'}).getByRole('button').nth(2).click();
    await full.screenshot({path:'/tmp/bw-2txyi-composition-full.png'});
    const fullFrame=await main.getAttribute('data-frame');
    await page.getByRole('button',{name:'Close full-screen artifact'}).click();
    await expect(main).toHaveAttribute('data-frame',fullFrame!);
    expect(await widget.evaluate((el,old)=>el===old,originalFrame)).toBe(true);
    await chapters.first().click();
    await film.getByRole('button',{name:'Play',exact:true}).click();
    for(let i=0;i<48;i++){
      await widget.screenshot({path:`/tmp/bw-2txyi-motion-${String(i).padStart(3,'0')}.png`});
      await page.waitForTimeout(120);
    }
    await widget.hover();
    await film.getByRole('button',{name:'Pause',exact:true}).click();
    if(process.env.COMPOSITION_FULL_PROOF==='1'){
      const proofContext=await browser.newContext({viewport:{width:1280,height:900},recordVideo:{dir:'/tmp/bw-2txyi-proof',size:{width:1280,height:900}}});
      const proof=await proofContext.newPage();
      await proof.setContent('<style>body{margin:0;background:#09101d}iframe{display:block;width:1280px;height:900px;border:0}</style><iframe sandbox="allow-scripts" title="Meshlets film"></iframe>');
      await proof.locator('iframe').evaluate((el,doc)=>{(el as HTMLIFrameElement).srcdoc=doc!},await widget.getAttribute('srcdoc'));
      await proof.locator('iframe').contentFrame().getByRole('button',{name:'Play',exact:true}).click();
      await proof.waitForTimeout(61000);
      await proof.close();
      await proofContext.close();
      await proof.video()!.saveAs('/tmp/bw-2txyi-full-film.webm');
    }
    await page.reload();
    await expect(page.getByTestId('composition-artifact').first().contentFrame().getByRole('button',{name:'Play',exact:true})).toBeVisible();
    expect(errors).toEqual([]);
  } finally { if(project) await request.delete(`/api/projects/${project.id}`); }
});
