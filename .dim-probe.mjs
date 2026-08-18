import { chromium } from 'playwright';
const id=(await (await fetch('http://127.0.0.1:3008/api/projects')).json())[0].id;
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1440,height:900}});
await p.goto(`http://127.0.0.1:3031/project?id=${id}&tab=board`,{waitUntil:'domcontentloaded'});
await p.waitForSelector('a[aria-label="Settings"]');
await p.waitForTimeout(2500);
console.log(JSON.stringify(await p.evaluate(()=>{
  const out={};
  const look=(name, el)=>{
    if(!el){out[name]='missing';return;}
    const svg=el.querySelector('svg'); if(!svg){out[name]='no svg';return;}
    const before=getComputedStyle(svg).opacity;
    const had=[...svg.classList].filter(c=>c.startsWith('opacity-'));
    had.forEach(c=>svg.classList.remove(c));
    const hadOnBtn=[...el.classList].filter(c=>c.includes('opacity-100'));
    hadOnBtn.forEach(c=>el.classList.remove(c));
    const after=getComputedStyle(svg).opacity;
    out[name]={with:before, without:after, strippedFromIcon:had, strippedFromButton:hadOnBtn};
  };
  const bar=document.querySelector('[data-testid="project-bar"]');
  look('gear', document.querySelector('a[aria-label="Settings"]'));
  look('back', bar.querySelector('a[href="/"]'));
  look('menu', bar.querySelector('[data-testid="project-menu"]'));
  const tabBar=document.querySelector('[data-testid="tab-bar"]');
  const tool=[...(tabBar?.querySelectorAll('button')??[])].find(x=>x.querySelector('svg'));
  look('toolbutton', tool);
  return out;
},null),null,1));
await b.close();
