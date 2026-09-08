const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server-v2.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public/index-v2.html'), 'utf8');
const model = 'cline-pass/deepseek-v4-flash';

function backend(saved = {}) {
  const files = new Map(Object.entries(saved));
  let handler;
  const context = vm.createContext({
    fs: { readFileSync(file) { if (!files.has(path.basename(file))) throw new Error('absent'); return files.get(path.basename(file)); },
      writeFileSync(file, content) { files.set(path.basename(file), content); } },
    path, process: { env: {} }, console: { log() {}, warn() {} },
    http: { createServer(fn) { handler = fn; return { on() {}, listen() {} }; } },
    setTimeout, clearTimeout, AbortController, URL, Buffer,
    fetch() { throw new Error('Unexpected network request'); },
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '')
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', "const __dirname = '.';"), context);
  return {
    files, context,
    run: (code) => vm.runInContext(code, context),
    async post(url, body, headers = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { url, method: 'POST', headers });
      let status, result;
      await handler(req, { writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); } });
      return { status, body: result };
    },
  };
}

function frontend() {
  const result = { innerHTML: '', style: {} };
  const context = vm.createContext({ localStorage: { getItem() { return ''; } },
    document: { querySelector() { return result; } } });
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script.slice(0, script.indexOf("$('#proxyBase').onclick")), context);
  return { result, run: (code) => vm.runInContext(code, context) };
}

test('watch: validation, deduplication, per-model persistence and authentication', async () => {
  const app = backend();
  for (const upstream of ['', '<img src=x>', 'constructor', '__proto__', 'a'.repeat(129), 1, null]) {
    assert.equal((await app.post('/api/watch-upstream', { model, upstream })).status, 400);
  }
  assert.equal((await app.post('/api/watch-upstream', { model: '__proto__', upstream: 'custom' })).status, 400);
  assert.equal((await app.post('/api/watch-upstream', { model: 'missing/model', upstream: 'custom' })).status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await app.post('/api/watch-upstream', { model, upstream: 'custom-host' })).status, 200);
  const restarted = backend(Object.fromEntries(app.files));
  assert.equal(restarted.run(`META.models['${model}'].watchedUpstreams.join()`), 'custom-host');
  assert.equal(restarted.run(`META.models['${model}'].upstreams.length`), 17);
  assert.equal(restarted.run(`META.models['cline-pass/kimi-k3']`), undefined);
  const locked = backend({ 'config.json': JSON.stringify({ proxyKey: 'test-key' }) });
  assert.equal((await locked.post('/api/watch-upstream', { model, upstream: 'custom' })).status, 401);
});

test('metrics: source units, missing values, zero prices and endpoint grouping', () => {
  const app = backend();
  const or = JSON.parse(app.run(`JSON.stringify(endpointMetrics([
    { tag: 'vendor/a', pricing: { prompt: '0.000001', completion: '0.000002' }, latency_last_30m: { p50: 0.5 }, throughput_last_30m: { p50: 30 } },
    { tag: 'vendor/b', pricing: { prompt: '0.000002', completion: '0.0000005' }, latency_last_30m: { p50: 0.7 }, throughput_last_30m: { p50: 40 } },
    { tag: 'unknown', pricing: { prompt: null, completion: '' }, latency_last_30m: null },
    { tag: 'free', pricing: { prompt: '0', completion: '0' } }
  ], 'OpenRouter'))`));
  assert.equal(or[0].endpoints, 2);
  assert.deepEqual([or[0].input, or[0].output, or[0].cost, or[0].ttft, or[0].tps], [2, 0.5, 2.5, 500, 40]);
  assert.equal(or[1].cost, null);
  assert.equal(or[1].ttft, null);
  assert.equal(or[2].cost, 0);
  assert.equal(app.run(`metricNumber('  ')`), null);
  assert.equal(app.run(`endpointMetrics([{provider_name:'vendor',latency_last_1h:{p50:1200}}], 'Vercel')[0].ttft`), 1200);
});

test('delete: cleans model settings, survives restart and discovery, supports manual restore', async () => {
  const app = backend();
  assert.equal(app.run(`META.models['${model}'].upstreams.length`), 16);
  assert.equal(app.run(`META.models['deepseek/deepseek-v4-flash'].upstreams.length`), 29);
  app.run(`config.perModel['${model}'] = {upstreams:['deepinfra','deepseek'],upstream:'deepinfra',exclude:['deepinfra'],sort:'cost'};
    Object.assign(META.models['${model}'], {watchedUpstreams:['deepinfra'],availableProviders:['deepinfra'],upstreamDetail:{deepinfra:{cost:1}},upstreamStatus:{deepinfra:{status:'ok'}},lastProvider:'deepinfra'});`);
  for (const upstream of [null, '', '<bad>', 'constructor']) {
    assert.equal((await app.post('/api/delete-upstream', { model, upstream })).status, 400);
  }
  const response = await app.post('/api/delete-upstream', { model, upstream: 'deepinfra' });
  assert.equal(response.status, 200);
  assert.ok(!response.body.meta.upstreams.includes('deepinfra'));
  assert.deepEqual(response.body.config.upstreams, ['deepseek']);
  assert.deepEqual(response.body.config.exclude, []);
  assert.deepEqual(response.body.meta.watchedUpstreams, []);
  assert.deepEqual(response.body.meta.upstreamDetail, {});
  assert.equal(response.body.meta.lastProvider, undefined);
  const restarted = backend(Object.fromEntries(app.files));
  assert.equal(restarted.run(`META.models['${model}'].upstreams.includes('deepinfra')`), false);
  restarted.run(`learnAvailableProviders('${model}','Available providers are: deepinfra, another.');`);
  assert.equal(restarted.run(`META.models['${model}'].upstreams.includes('deepinfra')`), false);
  assert.equal(restarted.run(`META.models['${model}'].upstreams.includes('another')`), true);
  await restarted.post('/api/watch-upstream', { model, upstream: 'deepinfra' });
  assert.equal(restarted.run(`META.models['${model}'].upstreams.includes('deepinfra')`), true);
  const locked = backend({'config.json':JSON.stringify({proxyKey:'key'})});
  assert.equal((await locked.post('/api/delete-upstream', { model, upstream:'deepinfra' })).status, 401);
});

test('probe: correct gateway source, retained watch list and clear unavailable metrics', async () => {
  for (const pipeline of ['planner', 'direct']) {
    const app = backend();
    await app.post('/api/watch-upstream', { model, upstream: 'custom-host' });
    await app.post('/api/delete-upstream', { model, upstream: 'deepseek' });
    const responseBody = { choices: [{ message: { content: 'OK' } }], provider: 'deepseek', model: 'deepseek/deepseek-v4-flash' };
    if (pipeline === 'planner') responseBody.choices[0].message.provider_metadata = { gateway: { routing: { finalProvider: 'deepseek', canonicalSlug: 'deepseek/deepseek-v4-flash' } } };
    app.run(`META.orModelList = ['deepseek/deepseek-v4-flash']; META.orModelsFetchedAt = Date.now();
      fetchJSON = async (url) => {
        if (url.endsWith('/endpoints')) {
          if (!url.startsWith('${pipeline === 'planner' ? 'https://ai-gateway.vercel.sh' : 'https://openrouter.ai'}')) throw new Error('Wrong source');
          return { json: { data: { endpoints: ['deepseek','deepinfra'].map((slug) => ({ provider_name: slug, tag: slug, pricing: { prompt: '0', completion: '0' } })) } } };
        }
        return {json:${JSON.stringify(responseBody)}};
      };
      harvestAvailableProviders = async () => ['deepseek'];`);
    const response = await app.post('/api/probe', { model });
    assert.equal(response.body.ok, true);
    assert.ok(response.body.upstreams.includes('custom-host'));
    assert.ok(!response.body.upstreams.includes('deepseek'));
    assert.equal(response.body.upstreamDetail.deepseek, undefined);
    assert.equal(response.body.upstreamDetail.deepinfra.source, pipeline === 'planner' ? 'Vercel' : 'OpenRouter');
    app.run(`vercelEndpoints = orEndpoints = async () => { throw new Error('offline'); };`);
    assert.deepEqual((await app.post('/api/probe', { model })).body.upstreamDetail, {});
  }
});

test('test endpoint: strict custom target, complete error providers and bad input', async () => {
  const app = backend();
  app.run(`config.perModel['${model}'] = {pinMode:'preferred',exclude:['custom-host']};
    runChatChain = async (req, body, model, cfg) => {
      if (cfg.pinMode !== 'strict' || cfg.exclude.length || cfg.upstreams[0] !== 'custom-host') throw new Error('Incorrect custom test settings');
      return { status: 502, out: { error: { message: 'Available providers are: deepinfra, relace, nextbit.' } }, trace: [{upstream:'custom-host',status:502,ms:1}] };
    };`);
  const response = await app.post('/api/test', { model, upstreams: ['custom-host'], exclude: [], pinMode: 'strict' });
  assert.equal(response.body.ok, false);
  assert.deepEqual(response.body.errorProviders, ['deepinfra', 'relace', 'nextbit']);
  assert.equal((await app.post('/api/test', { model, upstreams: '<script>' })).status, 400);
  assert.equal(app.run(`errorProviders({message:'prefix '+JSON.stringify({error:{metadata:{available_providers:['relace','<bad>']}}})}).join()`), 'relace');
});

test('config: saving all watched providers does not silently truncate', async () => {
  const app = backend();
  await app.post('/api/watch-upstream', { model, upstream: 'custom-host' });
  const upstreams = JSON.parse(app.run(`JSON.stringify(META.models['${model}'].upstreams)`));
  await app.post('/api/config', { perModel: { [model]: { upstreams } } });
  assert.equal(app.run(`config.perModel['${model}'].upstreams.length`), 17);
});

test('UI: strategy sorting, missing metrics last, labels and silent missing values', () => {
  const ui = frontend();
  ui.run(`var meta = { upstreams:['missing','fast','cheap'], upstreamDetail: { fast:{cost:5,ttft:10,tps:100}, cheap:{cost:0,ttft:30,tps:20} } };`);
  assert.equal(ui.run(`sortedUpstreams(meta,'cost').join()`), 'cheap,fast,missing');
  assert.equal(ui.run(`sortedUpstreams(meta,'ttft').join()`), 'fast,cheap,missing');
  assert.equal(ui.run(`sortedUpstreams(meta,'tps').join()`), 'fast,cheap,missing');
  assert.equal(ui.run(`sortedUpstreams(meta,null).join()`), 'missing,fast,cheap');
  assert.equal(ui.run(`metricText(null,'ttft')`), '');
  assert.equal(ui.run(`metricText(null,'cost')`), '');
  assert.equal(ui.run(`metricText(null,'tps')`), '');
  assert.equal(ui.run(`metricsNote(null,'ttft')`), '');
  assert.equal(ui.run(`metricText({},null)`), '');
  assert.match(ui.run(`metricText({ttft:25},'ttft')`), /25 ms/);
  const mixed = ui.run(`upstreamPanel('${model}',meta,{sort:'ttft'})`);
  assert.match(mixed, /data-u="fast"[\s\S]*?aria-label="列表排名 1"/);
  assert.match(mixed, /data-u="missing"[\s\S]*?aria-label="列表排名 3"/);
  const empty = ui.run(`upstreamPanel('${model}',{upstreams:['first','second']},{sort:'cost'})`);
  assert.match(empty, /data-u="first"[\s\S]*?aria-label="列表排名 1"/);
  assert.match(empty, /data-u="second"[\s\S]*?aria-label="列表排名 2"/);
  assert.ok(!empty.includes('class="upmetric"'));
});

test('UI: clickable providers bind original model and escape hostile error text', () => {
  const ui = frontend();
  ui.run(`showTest({ok:false,error:'<img src=x onerror=alert(1)> deepinfra; not-deepinfra',errorProviders:['deepinfra','<bad>'],trace:[{upstream:'custom-host',status:502,ms:1}]},'${model}',['custom-host']);`);
  assert.ok(!ui.result.innerHTML.includes('<img'));
  assert.match(ui.result.innerHTML, /&lt;img/);
  assert.match(ui.result.innerHTML, /data-watch-model="cline-pass\/deepseek-v4-flash"/);
  assert.match(ui.result.innerHTML, /data-watch-upstream="deepinfra"/);
  assert.match(ui.result.innerHTML, /not-deepinfra/);
  assert.ok(!ui.result.innerHTML.includes('data-watch-upstream="<bad>"'));
  assert.match(ui.run(`highlightProviders('custom-new.','${model}',['custom-new'])`), /<\/button>\.$/);
  assert.equal(ui.run(`highlightProviders('custom-new.extra','${model}',['custom-new'])`), 'custom-new.extra');
});

test('UI: collapsed summary follows strategy and observed probe provider', () => {
  const ui = frontend();
  for (const [sort, label] of [['cost','最低成本'], ['ttft','最快首字'], ['tps','最高吞吐'], ['', '网关智能选择']]) {
    const html = ui.run(`summaryChips({sort:'${sort}'},{probedAt:1,lastProvider:'deepinfra'})`);
    assert.ok(html.includes('自动 · ' + label));
    assert.ok(html.includes('探测命中：deepinfra'));
  }
  assert.ok(!ui.run(`summaryChips({sort:'cost'},null)`).includes('探测命中'));
  const manual = ui.run(`summaryChips({upstreams:['deepseek'],exclude:['azure']},{probedAt:1,lastProvider:'deepseek'})`);
  assert.ok(manual.includes('1&nbsp;deepseek'));
  assert.ok(manual.includes('✕ 1'));
  assert.ok(!manual.includes('自动'));
  assert.ok(manual.includes('探测命中：deepseek'));
  assert.ok(ui.run(`summaryChips({sort:'cost',exclude:['azure']},null)`).includes('自动 · 最低成本'));
  assert.ok(ui.run(`summaryChips({},{probedAt:1,lastProvider:'<img>'})`).includes('&lt;img&gt;'));
});

test('UI: delete updates the matching model and hides missing metric markup', async () => {
  const ui = frontend();
  const panel = ui.run(`upstreamPanel('${model}', {upstreams:['deepinfra']}, {sort:'ttft'})`);
  assert.match(panel, /data-delete-upstream="deepinfra"/);
  assert.ok(!panel.includes('class="upmetric"'));
  assert.ok(!panel.includes('class="metrics-note"'));
  ui.run(`DATA = {subscription:[{id:'${model}',meta:{upstreams:['deepinfra']},config:{upstreams:['deepinfra']}}]};
    var rendered = false, message = '', button = {disabled:false};
    render = () => {rendered=true;}; status = (text) => {message=text;};
    api = async (url, body) => {
      if(url!=='/api/delete-upstream' || body.model!=='${model}' || body.upstream!=='deepinfra') throw new Error('Incorrect delete target');
      return {ok:true,meta:{upstreams:[]},config:{upstreams:[]}};
    };`);
  await ui.run(`deleteUpstream('${model}','deepinfra',button)`);
  assert.equal(ui.run('DATA.subscription[0].meta.upstreams.length'), 0);
  assert.equal(ui.run('DATA.subscription[0].config.upstreams.length'), 0);
  assert.equal(ui.run('rendered'), true);
  assert.equal(ui.run('button.disabled'), false);
  assert.equal(ui.result.open, true);
});
