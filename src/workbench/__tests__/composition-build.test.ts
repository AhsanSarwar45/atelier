import {afterEach, describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {compositionArtifact} from '../composition-artifact';
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const temp=()=>{const dir=mkdtempSync(join(tmpdir(),'atelier-composition-'));dirs.push(dir);return dir;};
describe('composition authoring command',()=>{
 it('builds a portable real Remotion composition accepted by the reader',()=>{
   const out=join(temp(),'cache.json');
   execFileSync(process.execPath,['scripts/compositions/build.mjs','examples/compositions/cache.tsx',out],{cwd:resolve('.'),stdio:'pipe'});
   const raw=readFileSync(out,'utf8');
   const artifact=compositionArtifact(JSON.parse(raw));
   expect(artifact?.title).toContain('cache');
   expect(artifact?.html).toContain('Cache miss');
   expect(artifact?.html).not.toMatch(/<script[^>]+src=/);
   expect(Buffer.byteLength(raw)).toBeLessThan(8*1024*1024);
 });
 it('rejects invalid timeline metadata before bundling',()=>{
   const dir=temp(),source=join(dir,'invalid.tsx');
   writeFileSync(source,'throw new Error("must not execute authored code in Node")');
   writeFileSync(join(dir,'invalid.json'),JSON.stringify({title:'Invalid',width:1280,height:720,fps:0,durationInFrames:300}));
   expect(()=>execFileSync(process.execPath,['scripts/compositions/build.mjs',source,join(dir,'out.json')],{stdio:'pipe'})).toThrow(/fps must be an integer/);
 });
 it('rejects a title whose UTF-8 bytes exceed the presenter limit',()=>{
   const dir=temp(),source=join(dir,'unicode.tsx');
   writeFileSync(source,'export default function Film(){return null}');
   writeFileSync(join(dir,'unicode.json'),JSON.stringify({title:'ش'.repeat(150),width:1280,height:720,fps:30,durationInFrames:60}));
   expect(()=>execFileSync(process.execPath,['scripts/compositions/build.mjs',source,join(dir,'out.json')],{stdio:'pipe'})).toThrow(/title must contain 1–200 UTF-8 bytes/);
 });
 it('embeds imported CSS and local images into a portable composition',()=>{
   const dir=temp(),source=join(dir,'styled.tsx'),out=join(dir,'out.json');
   writeFileSync(source,'import "./style.css"; export default function Film(){return <div className="film-caption">Hello</div>}');
   writeFileSync(join(dir,'style.css'),'.film-caption { color: #123456; background-image: url("./dot.svg"); }');
   writeFileSync(join(dir,'dot.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><circle r="1"/></svg>');
   writeFileSync(join(dir,'styled.json'),JSON.stringify({title:'Styled film',width:1280,height:720,fps:30,durationInFrames:60}));
   execFileSync(process.execPath,['scripts/compositions/build.mjs',source,out],{stdio:'pipe'});
   const artifact=compositionArtifact(JSON.parse(readFileSync(out,'utf8')));
   expect(artifact).not.toBeNull();
   expect(artifact?.html).toMatch(/<style>[\s\S]*\.film-caption\{color:#123456/);
   expect(artifact?.html).toContain('data:image/svg+xml');
   expect(artifact?.html).not.toMatch(/<link[^>]+href=/);
 });
});
