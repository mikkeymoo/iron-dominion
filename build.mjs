import {build} from 'esbuild';
import {mkdir,copyFile,writeFile,readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {join} from 'node:path';

const GZIP_BUDGET=900*1024;

async function sourceFiles(dir){
  const out=[];
  for(const e of await readdir(dir,{withFileTypes:true})){
    const p=join(dir,e.name);
    if(e.isDirectory())out.push(...await sourceFiles(p));
    else out.push(p);
  }
  return out.sort();
}
// Hash of every source file plus the lockfile: both bundles get it, so a stale cached worker is detected at Hello.
const hash=createHash('sha256');
for(const f of [...await sourceFiles('src'),'package-lock.json','public/index.html']){hash.update(f);hash.update(await readFile(f));}
const BUILD_HASH=hash.digest('hex').slice(0,12);

await mkdir('dist',{recursive:true});
const common={bundle:true,minify:true,sourcemap:false,define:{'process.env.NODE_ENV':'"production"',__BUILD_HASH__:JSON.stringify(BUILD_HASH)},target:['es2022'],legalComments:'none'};
// Addons import 'three/webgpu' already; a bare 'three' import is redirected so there is only one copy. (esbuild's alias
// option is prefix-based and would also rewrite 'three/webgpu', hence the plugin.)
const threeToWebgpu={name:'three-to-webgpu',setup(b){b.onResolve({filter:/^three$/},()=>b.resolve('three/webgpu',{kind:'import-statement',resolveDir:process.cwd()}));}};
await build({...common,entryPoints:['src/main.tsx'],outfile:'dist/app.js',loader:{'.css':'css'},plugins:[threeToWebgpu]});
// The sim runs in a classic worker so it loads from GitHub Pages without module-worker or COOP/COEP support.
await build({...common,entryPoints:['src/sim/worker.ts'],outfile:'dist/sim-worker.js',format:'iife'});
for(const name of ['index.html','manifest.webmanifest','icon.svg'])await copyFile('public/'+name,'dist/'+name);
await writeFile('dist/.nojekyll','');
await writeFile('dist/build.json',JSON.stringify({hash:BUILD_HASH})+'\n');

const worker=await readFile('dist/sim-worker.js','utf8');
const leaked=['WebGPURenderer','THREE','three/webgpu','WebGLRenderer','MeshStandardNodeMaterial'].filter(s=>worker.includes(s));
if(leaked.length){console.error(`build: dist/sim-worker.js contains three code (${leaked.join(', ')}); the sim must stay renderer-free`);process.exit(1);}

const app=await readFile('dist/app.js');
const gz=gzipSync(app,{level:9}).length;
const kb=n=>(n/1024).toFixed(1)+' KB';
console.log(`build ${BUILD_HASH}: app.js raw ${kb(app.length)}, gzip ${kb(gz)} (budget ${kb(GZIP_BUDGET)}); sim-worker.js ${kb(worker.length)}`);
if(gz>GZIP_BUDGET){console.error(`build: app.js gzip ${kb(gz)} exceeds ${kb(GZIP_BUDGET)}`);process.exit(1);}
