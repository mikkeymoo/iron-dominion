import {build} from 'esbuild';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/main.tsx'],bundle:true,outfile:'dist/app.js',minify:true,sourcemap:false,define:{'process.env.NODE_ENV':'"production"'},loader:{'.css':'css'},target:['es2022']});
for(const name of ['index.html','manifest.webmanifest','icon.svg'])await copyFile('public/'+name,'dist/'+name);
await writeFile('dist/.nojekyll','');
