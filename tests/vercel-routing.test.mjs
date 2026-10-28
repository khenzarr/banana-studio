import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const api = new URL('../api/', import.meta.url);
const files = await readdir(api);
const routes = files.filter(name => name.startsWith('_') && name.endsWith('.ts')).map(name => name.slice(1, -3));
const compiled = await build({
  entryPoints: [new URL('../api/[route].ts', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'route-spies', setup(builder) {
    builder.onResolve({ filter: /^\.\/_.*\.js$/ }, args => ({ path: args.path, namespace: 'route-spy' }));
    builder.onLoad({ filter: /.*/, namespace: 'route-spy' }, args => ({
      contents: `export default (req,res) => res.status(200).json({handler:${JSON.stringify(args.path.slice(3, -3))},method:req.method,query:req.query,body:req.body});`,
    }));
  } }],
});
const { default: handler } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const response = () => ({ code: 0, headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(code) { this.code=code;return this; }, json(body) { this.body=body;return this; } });

test('all public paths dispatch to their original handler and preserve request data', async () => {
  assert.equal(routes.length, 18);
  for (const route of routes) {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const req = {url:`/api/${route}?route=fal-debug&taskId=synthetic`,method,query:{route:'fal-debug',taskId:'synthetic'},body:{prompt:'synthetic'}};
      const res = response();
      await handler(req,res);
      assert.equal(res.code,200);
      assert.deepEqual(res.body,{handler:route,method,query:req.query,body:req.body});
    }
  }
});

test('unknown, internal and queue paths cannot be reached via dispatcher', async () => {
  for (const url of ['/api/unknown','/api/__proto__','/api/constructor','/api/_workspace-config','/api/image-job-worker','/api/image-job-sweep','/api/fal-image-generate','/api/a/b','/api/%2e%2e','/api/unknown?route=workspace-config']) {
    const res=response();
    await handler({url,query:{route:'workspace-config'},method:'GET'},res);
    assert.equal(res.code,404,url);
  }
});

test('Hobby deployment exposes six functions and retains queue and cron targets', async () => {
  const functions=files.filter(name=>name.endsWith('.ts')&&!name.startsWith('_'));
  assert.deepEqual(functions.sort(),['[route].ts','fal-h3-video.ts','fal-image-generate.ts','fal-video-scale.ts','image-job-sweep.ts','image-job-worker.ts'].sort());
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  assert.equal(config.crons[0].path,'/api/image-job-sweep');
  assert.equal(config.crons[0].schedule,'0 3 * * *');
  assert.equal(config.functions['api/image-job-worker.ts'].experimentalTriggers[0].type,'queue/v2beta');
});
