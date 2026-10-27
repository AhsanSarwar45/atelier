import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { test as base, expect, chromium } from '@playwright/test';

const test = base.extend({ browser: [async ({}, use) => {
  const browser = await chromium.connectOverCDP(process.env.CDP_URL!);
  await use(browser);
}, { scope: 'worker' }] });
const CHAT = 'e0379830-12e7-4a06-b94d-d51be95949d5';
const OTHER = 'large-chat-switch-target';
const SOURCE = process.env.BEADS_E2E_OWNER_DB;
const baseline = process.env.BEADS_E2E_BASELINE === '1';

test('the reported chat opens with bounded agent data and no hidden completed rows', async ({ page, request }, info) => {
  test.skip(!SOURCE || !process.env.CDP_URL, 'requires explicit read-only source and Atelier Chrome');
  test.setTimeout(300_000);
  const fixture = join(process.cwd(), 'tests/.workbench-run-real-chat');
  mkdirSync(fixture, { recursive: true });
  const made = await request.post('/api/projects', { data: { name: 'Reported chat timing', path: fixture } });
  expect(made.status()).toBe(201);
  const project = await made.json();
  try {
    const db = new DatabaseSync(join(process.env.ATELIER_DATA_DIR!, 'workbench.db'));
    try {
      db.exec('PRAGMA busy_timeout=30000');
      db.prepare('ATTACH DATABASE ? AS source').run(`file:${SOURCE}?mode=ro`);
      db.exec('BEGIN IMMEDIATE');
      for (const table of ['session', 'event', 'event_ref', 'event_ref_filled']) {
        const key = table === 'session' ? 'id' : 'session_id';
        const sourceColumns = new Set((db.prepare(`PRAGMA source.table_info(${table})`).all() as { name: string }[]).map(c => c.name));
        const columns = (db.prepare(`PRAGMA main.table_info(${table})`).all() as { name: string }[]).map(c => c.name).filter(c => sourceColumns.has(c)).join(',');
        db.prepare(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM source.${table} WHERE ${key}=?`).run(CHAT);
      }
      db.prepare('UPDATE session SET project_id=?,project_path=?,cwd=?,external_id=NULL,state=? WHERE id=?')
        .run(project.id, fixture, fixture, 'dormant', CHAT);
      db.prepare("UPDATE event SET json=json_set(json,'$.cwd',?,'$.projectPath',?,'$.projectId',?) WHERE session_id=? AND type='session.started'")
        .run(fixture, fixture, project.id, CHAT);
      const at = new Date().toISOString();
      db.prepare(`INSERT INTO session (id,brand,project_id,project_path,cwd,permission_mode,title,state,origin,created_at,last_active_at,last_spoke_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(OTHER,'claude',project.id,fixture,fixture,'default','Switch target','dormant','app',at,at,at);
      const put = db.prepare('INSERT INTO event (session_id,seq,at,type,json) VALUES (?,?,?,?,?)');
      [{type:'message.started',messageId:'other-message',role:'assistant'}, {type:'text.delta',messageId:'other-message',text:'Other conversation.'}, {type:'message.completed',messageId:'other-message'}]
        .forEach((body,i)=>put.run(OTHER,i+1,at,body.type,JSON.stringify({...body,sessionId:OTHER,seq:i+1,at})));
      db.exec('COMMIT');
      console.log('Copied exact reported conversation', db.prepare('SELECT COUNT(*) AS n FROM event WHERE session_id=?').get(CHAT));
    } finally { db.close(); }
    const snapshots: { bytes:number; wireBytes:number; agents:number; finished:number }[]=[];
    const errors:string[]=[];
    let agentReads=0;
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',req=>{if(new URL(req.url()).pathname==='/api/workbench/agents')agentReads++;});
    page.on('websocket',socket=>socket.on('framereceived',({payload})=>{
      try { const raw=typeof payload==='string'?payload:gunzipSync(payload).toString();const frame=JSON.parse(raw);
        if(frame.tag==='chat.snapshot'&&frame.scope===CHAT){const v=JSON.parse(frame.data);snapshots.push({bytes:Buffer.byteLength(raw),wireBytes:Buffer.byteLength(payload),agents:v.agents.length,finished:v.finishedAgentCount});}
      } catch { /* non-JSON control frames are not snapshots */ }
    }));
    await page.goto(`/project?id=${project.id}&tab=chat`);
    const row=(id:string)=>page.locator(`[data-testid="restore-row"][data-row-key="${id}"] [data-testid="row-name"]`);
    await expect(row(CHAT)).toBeVisible({timeout:30000});
    async function measure(id:string,label:string) {
      await page.evaluate(id=>{
        const node=document.querySelector(`[data-testid="restore-row"][data-row-key="${id}"] [data-testid="row-name"]`)!;
        (window as any).__chatTiming=null;
        node.addEventListener('click',()=>{
          const start=performance.now();let shell:number|null=null;let content:number|null=null;let last='';let same=0;
          const poll=()=>{
            const pane=document.querySelector('[data-testid="chat-tab"]');
            if(pane?.getAttribute('data-session-id')===id){
              shell??=performance.now()-start;
              const transcript=pane.querySelector('[data-testid="virtual-transcript"]');
              const scroll=pane.querySelector('[data-testid="transcript"]');
              if(!pane.querySelector('[data-testid="chat-loading"]')&&Number(transcript?.getAttribute('data-mounted-items'))>0){
                content??=performance.now()-start;
                const layout=[...(transcript?.querySelectorAll('[data-transcript-key]')??[])].map(n=>`${n.getAttribute('data-transcript-key')}:${n.getBoundingClientRect().y}:${n.getBoundingClientRect().height}`).join('|');
                same=layout===last?same+1:0;last=layout;
                if(same>=2&&scroll&&Math.abs(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop)<3){
                  (window as any).__chatTiming={shell,content,settled:performance.now()-start,hiddenRows:document.querySelectorAll('[data-testid="sent-away-stopped"] [data-testid="sent-away-row"]').length};return;
                }
              }
            }
            if(performance.now()-start<30000)requestAnimationFrame(poll);else (window as any).__chatTiming={shell,content,timeout:true};
          };requestAnimationFrame(poll);
        },{once:true,capture:true});
      },id);
      await row(id).click({noWaitAfter:true});
      await page.waitForFunction(()=>(window as any).__chatTiming!==null,undefined,{timeout:35000});
      const timing=await page.evaluate(()=>(window as any).__chatTiming);
      console.log(label,JSON.stringify(timing));
      expect(timing.timeout).not.toBe(true);
      return timing;
    }
    await measure(CHAT,'cold-real');
    await page.screenshot({path:info.outputPath('reported-chat.png')});
    expect(agentReads).toBe(0);
    if(!baseline){expect(snapshots[0].agents).toBe(0);expect(snapshots[0].finished).toBeGreaterThanOrEqual(696);expect(snapshots[0].bytes).toBeLessThan(300_000);}
    console.log('SNAPSHOT',JSON.stringify(snapshots));
    await measure(OTHER,'other');
    const normal=await measure(CHAT,'warm-real');
    if(!baseline){expect(normal.hiddenRows).toBe(0);expect(normal.settled).toBeLessThan(200);}
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    await measure(OTHER,'other-cpu4');
    const slower=await measure(CHAT,'warm-real-cpu4');
    if(!baseline){expect(slower.hiddenRows).toBe(0);expect(slower.settled).toBeLessThan(500);}
    await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
    if(!baseline){
      await page.getByTestId('toggle-stopped-agents').click();
      await expect(page.getByTestId('virtual-agent-list')).toHaveAttribute('data-count','40');
      await expect.poll(() => page.getByTestId('sent-away-stopped').getByTestId('sent-away-row').count()).toBeGreaterThan(0);
      expect(await page.getByTestId('sent-away-stopped').getByTestId('sent-away-row').count()).toBeLessThan(20);
      await page.getByTestId('load-more-agents').click();
      await expect(page.getByTestId('virtual-agent-list')).toHaveAttribute('data-count','80');
      await page.getByTestId('chat-right-rail-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect(page.locator('[data-testid=virtual-agent-list] [data-index="79"]')).toBeVisible();
      console.log('VIRTUAL',JSON.stringify({loaded:80,mounted:await page.getByTestId('sent-away-stopped').getByTestId('sent-away-row').count()}));
      expect(await page.getByTestId('sent-away-stopped').getByTestId('sent-away-row').count()).toBeLessThan(20);
      await page.screenshot({path:info.outputPath('reported-chat-expanded.png')});
      await page.getByTestId('sent-away-stopped').getByTestId('sent-away-open').first().click();
      await expect(page.getByTestId('agent-view')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('agent-view')).not.toBeVisible();
      await measure(OTHER,'leave-expanded-history');
      const afterHistory=await measure(CHAT,'return-after-history');
      expect(afterHistory.settled).toBeLessThan(200);
      await page.setViewportSize({width:768,height:1024});
      await expect(page.getByTestId('chat-tab')).toBeVisible();
    }
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture,{recursive:true,force:true});
  }
});
