#!/usr/bin/env node
// Bundle author-controlled code locally. Never evaluate a composition on the app server.
import {build} from 'esbuild';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, dirname, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  console.error('Usage: node scripts/compositions/build.mjs SOURCE.tsx OUTPUT.json');
  process.exit(1);
}
const entry = resolve(source);
const configPath = entry.slice(0, -extname(entry).length) + '.json';
const config = JSON.parse(await readFile(configPath, 'utf8'));
const integer = (name, min, max) => {
  if (!Number.isInteger(config[name]) || config[name] < min || config[name] > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
};
if (typeof config.title !== 'string' || !config.title.trim() || Buffer.byteLength(config.title) > 200) throw new Error('title must contain 1–200 UTF-8 bytes');
integer('width',160,4096); integer('height',90,4096); integer('fps',1,60); integer('durationInFrames',1,108000);
if (config.chapters !== undefined && (!Array.isArray(config.chapters) || config.chapters.length > 30 || config.chapters.some((c,i,a)=>!Number.isInteger(c.frame)||c.frame<0||c.frame>=config.durationInFrames||typeof c.label!=='string'||!c.label.trim()||c.label.length>80||(i>0&&c.frame<=a[i-1].frame)))) throw new Error('chapters must have increasing frame numbers and short labels');
const toolkit = dirname(fileURLToPath(import.meta.url));
const result = await build({
  stdin:{contents:`import Composition from ${JSON.stringify(entry)};\nimport {mount} from ${JSON.stringify(resolve(toolkit,'player.tsx'))};\nmount(Composition, ${JSON.stringify(config)});`,resolveDir:dirname(entry),loader:'tsx'},
  nodePaths:[resolve(toolkit,'../../node_modules')],bundle:true,write:false,outfile:'composition.js',minify:true,format:'iife',platform:'browser',target:['chrome110'],jsx:'automatic',
  define:{'process.env.NODE_ENV':'"production"'},
  loader:{'.png':'dataurl','.jpg':'dataurl','.jpeg':'dataurl','.webp':'dataurl','.svg':'dataurl','.mp3':'dataurl','.wav':'dataurl','.woff2':'dataurl'},
});
const css = (result.outputFiles.find(f=>f.path.endsWith('.css'))?.text??'').replace(/<\/style/gi,'<\\/style');
const js = result.outputFiles.find(f=>f.path.endsWith('.js')).text.replace(/<\/script/gi,'<\\/script');
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%;background:#09101d;color:#edf2fa;font-family:system-ui,sans-serif}*{box-sizing:border-box}button:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
const artifact = JSON.stringify({version:1,kind:'composition',title:config.title,width:config.width,height:config.height,html});
if(Buffer.byteLength(artifact)>8*1024*1024) throw new Error('Composition exceeds 8 MiB. Reduce embedded assets.');
await mkdir(dirname(resolve(destination)),{recursive:true});
await writeFile(destination,artifact);
console.log(`Built ${destination} (${(Buffer.byteLength(artifact)/1024/1024).toFixed(2)} MiB)`);
