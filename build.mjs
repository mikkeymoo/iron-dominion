import {build} from 'esbuild';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
const common={bundle:true,minify:true,sourcemap:false,define:{'process.env.NODE_ENV':'"production"'},target:['es2022']};
await build({...common,entryPoints:['src/main.tsx'],outfile:'dist/app.js',loader:{'.css':'css'}});
// The sim runs in a classic worker so it loads from GitHub Pages without module-worker or COOP/COEP support.
await build({...common,entryPoints:['src/sim/worker.ts'],outfile:'dist/sim-worker.js',format:'iife'});
for(const name of ['index.html','manifest.webmanifest','icon.svg'])await copyFile('public/'+name,'dist/'+name);
await writeFile('dist/.nojekyll','');
