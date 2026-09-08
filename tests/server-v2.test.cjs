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
  const responseListeners = new Map();
  let handler;
  const context = vm.createContext({
    fs: { readFileSync(file) { if (!files.has(path.basename(file))) throw new Error('absent'); return files.get(path.basename(file)); },
      writeFileSync(file, content) { files.set(path.basename(file), content); } },
    path, process: { env: {} }, console: { log() {}, warn() {} },
    http: { createServer(fn) { handler = fn; return { on() {}, listen() {} }; } },
    setTimeout, clearTimeout, AbortController, URL, Buffer, TextDecoder, performance,
    fetch() { throw new Error('Unexpected network request'); },
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '')
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', "const __dirname = '.';"), context);
  return {
    files, context,
    disconnect: () => responseListeners.get('close')?.(),
    run: (code) => vm.runInContext(code, context),
    async post(url, body, headers = {}) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { url, method: 'POST', headers });
      let status, result;
      await handler(req, { on(name, listener) { responseListeners.set(name, listener); }, off(name) { responseListeners.delete(name); },
        writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); } });
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

function streamFixture(app) {
  app.run(`var clock = 0, cancelled = false, released = false;
    performance = {now:()=>clock};
    function fixtureResponse(parts) {
      let index = 0;
      return {ok:true,headers:{get:()=> 'text/event-stream; charset=utf-8'},body:{getReader:()=>({
        async read() { if(index===parts.length) return {done:true}; const part=parts[index++]; clock=part.at; return {done:false,value:Buffer.isBuffer(part.text)?part.text:Buffer.from(part.text)}; },
        async cancel() {cancelled=true;}, releaseLock() {released=true;}
      })}};
    }
    function frame(data) {return 'data: '+JSON.stringify(data)+'\\r\\n\\r\\n';}
    var parts = [
      {at:100,text:': heartbeat\\r\\n\\r\\n'},
      {at:400,text:frame({choices:[{delta:{reasoning:'推理'}}]})},
      {at:1400,text:frame({choices:[{delta:{content:'雨滴',reasoning_details:{unexpected:true}},finish_reason:'stop'}]})},
      {at:1600,text:frame({choices:[],usage:{completion_tokens:100,completion_tokens_details:{reasoning_tokens:20}},provider:'deepinfra',model:'deepseek/deepseek-v4-flash'})+'data: [DONE]\\r\\n\\r\\n'}
    ];`);
}

test('speed: monotonic timings, reasoning, usage and fragmented UTF-8 SSE', async () => {
  const app = backend(); streamFixture(app);
  app.run(`var bytes=Buffer.from(parts[2].text), splitAt=bytes.indexOf(Buffer.from('雨'))+1;
    parts.splice(2,1,{at:1300,text:bytes.subarray(0,splitAt)},{at:1400,text:bytes.subarray(splitAt)});`);
  const result = await app.run('measureStream(fixtureResponse(parts),0)');
  assert.equal(result.firstPacketMs, 100);
  assert.equal(result.generationSpeed, 100);
  assert.equal(result.perceivedSpeed, 62.5);
  assert.equal(result.preview, '雨滴');
  assert.equal(result.finalProvider, 'deepinfra');
  assert.equal(app.run('cancelled && released'), true);
});

test('speed: missing or invalid token counts are hidden, single chunk has no generation rate', async () => {
  for (const count of [null, -1, 'invalid', 0, 1.5]) {
    const app = backend(); streamFixture(app);
    app.run(`parts[3].text=frame({usage:{completion_tokens:${JSON.stringify(count)}}})+'data: [DONE]\\n\\n';`);
    const result = await app.run('measureStream(fixtureResponse(parts),0)');
    assert.equal(result.generationSpeed, null);
    assert.equal(result.perceivedSpeed, null);
    assert.equal(result.firstPacketMs, 100);
  }
  const app = backend(); streamFixture(app);
  app.run('parts.splice(1,1)');
  assert.equal((await app.run('measureStream(fixtureResponse(parts),0)')).generationSpeed, null);
});

test('speed: rejects incomplete streams, stream errors, malformed JSON and empty output', async () => {
  for (const change of [
    'parts.pop()',
    `parts=[{at:100,text:'data: {bad}\\n\\n'}]`,
    `parts=[{at:100,text:frame({error:{message:'rate limited'}})}]`,
    `parts=[{at:100,text:'data: [DONE]\\n\\n'}]`,
  ]) {
    const app = backend(); streamFixture(app); app.run(change);
    await assert.rejects(app.run('measureStream(fixtureResponse(parts),0)'));
    assert.equal(app.run('cancelled && released'), true);
  }
});

test('speed API: strict supplier, correct public source, prices and uptime windows', async () => {
  for (const pipeline of ['planner', 'direct']) {
    const app = backend(); streamFixture(app);
    app.run(`config.apiKey='test-only'; META.models['${model}'].pipeline='${pipeline}'; var calls=[];
      fetch = async (url,opts) => {
        calls.push(url);
        if(url.endsWith('/chat/completions')) {
          const body=JSON.parse(opts.body);
          if(body.max_tokens!==1024 || !body.stream_options.include_usage || !opts.signal) throw new Error('Invalid speed request');
          const only=${pipeline === 'planner' ? 'body.providerOptions.gateway.only' : 'body.provider.only'};
          if(only.join()!=='deepinfra') throw new Error('Supplier not pinned');
          ${pipeline === 'planner' ? `parts[3].text=frame({usage:{completion_tokens:100},provider_metadata:{gateway:{routing:{finalProvider:'deepinfra',canonicalSlug:'deepseek/deepseek-v4-flash'}}}})+'data: [DONE]\\n\\n';` : ''}
          return fixtureResponse(parts);
        }
        if(!url.startsWith('${pipeline === 'planner' ? 'https://ai-gateway.vercel.sh' : 'https://openrouter.ai'}')) throw new Error('Wrong metrics source');
        return {ok:true,json:async()=>({data:{endpoints:[{provider_name:'deepinfra',tag:'deepinfra',pricing:{prompt:'0.000001',completion:'0.000002',input_cache_read:'0'},uptime_last_5m:91,uptime_last_15m:92,uptime_last_1d:99}]}})};
      };`);
    const response = await app.post('/api/speed-test', { model, upstream:'deepinfra' });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.matched, true);
    const offer = response.body.detail.offers[0];
    assert.deepEqual([offer.input,offer.output,offer.cacheRead,offer.uptimeDay], [1,2,0,99]);
    assert.equal(offer.shortWindow, pipeline === 'planner' ? '15m' : '5m');
    assert.equal(offer.uptimeShort, pipeline === 'planner' ? 92 : 91);
    assert.equal(response.body.totalMs, 1600);
    assert.equal(app.run('calls.length'), 2);
  }
});

test('speed: unknown suppliers, wrong actual supplier and missing attribution are rejected', async () => {
  const app = backend();
  assert.equal((await app.post('/api/speed-test',{model,upstream:'missing'})).status,400);
  assert.equal((await app.post('/api/speed-test',{model:'__proto__',upstream:'deepinfra'})).status,400);
  const locked = backend({'config.json':JSON.stringify({proxyKey:'key'})});
  assert.equal((await locked.post('/api/speed-test',{model,upstream:'deepinfra'})).status,401);
  for (const actual of [null, 'other']) {
    const fixture = backend(); streamFixture(fixture);
    fixture.run(`config.apiKey='test-only'; parts[3].text=frame({usage:{completion_tokens:100},provider:${JSON.stringify(actual)}})+'data: [DONE]\\n\\n';
      fetch=async()=>fixtureResponse(parts);`);
    const response = await fixture.post('/api/speed-test',{model,upstream:'deepinfra'});
    assert.equal(response.body.ok, false);
    assert.equal(response.body.generationSpeed, undefined);
  }
});

test('speed UI: source-specific availability, zero cache price and silent missing data', () => {
  for (const source of ['Vercel','OpenRouter']) {
    const ui=frontend();
    ui.run(`SPEED_RESULTS=[{ok:true,model:'${model}',upstream:'deepinfra',actual:'deepinfra',matched:true,totalMs:1600,firstPacketMs:100,generationSpeed:100,perceivedSpeed:62.5,completionTokens:100,testedAt:1,preview:'<img>',detail:{source:'${source}',fetchedAt:1,offers:[{endpoint:'deepinfra',input:1,output:2,cacheRead:0,uptimeShort:99,uptimeDay:100}]}}]; renderSpeedTable()`);
    assert.ok(ui.result.innerHTML.includes(source==='Vercel'?'可用(15m)':'可用(5m)'));
    assert.ok(ui.result.innerHTML.includes('可用(1d)'));
    assert.ok(ui.result.innerHTML.includes('缓存读'));
    assert.ok(ui.result.innerHTML.includes('$0'));
    assert.ok(ui.result.innerHTML.includes('&lt;img&gt;'));
    ui.run(`SPEED_RESULTS=[{ok:true,model:'${model}',upstream:'deepinfra',actual:'deepinfra',matched:true,totalMs:1600,firstPacketMs:100,generationSpeed:null,perceivedSpeed:null,testedAt:1,detail:null}]; renderSpeedTable()`);
    assert.ok(!ui.result.innerHTML.includes('生成速度'));
    assert.ok(!ui.result.innerHTML.includes('可用('));
  }
});

test('speed API: client disconnect aborts the upstream request', async () => {
  const app = backend();
  app.context.disconnectResponse = app.disconnect;
  app.run(`config.apiKey='test-only'; var wasAborted=false;
    fetch=async(url,opts)=>{disconnectResponse(); wasAborted=opts.signal.aborted; throw new Error('Disconnected');};`);
  const response = await app.post('/api/speed-test',{model,upstream:'deepinfra'});
  assert.equal(response.status,502);
  assert.equal(app.run('wasAborted'),true);
  assert.match(response.body.error,/连接已断开/);
});

test('speed API: bounded timeout aborts the request and reports failure', async () => {
  const app = backend();
  app.run(`config.apiKey='test-only'; var capturedMs=0, forceTimeout, wasAborted=false;
    setTimeout=(fn,ms)=>{capturedMs=ms;forceTimeout=fn;return 1;}; clearTimeout=()=>{};
    fetch=async(url,opts)=>{forceTimeout();wasAborted=opts.signal.aborted;throw new Error('Timeout');};`);
  const response = await app.post('/api/speed-test',{model,upstream:'deepinfra'});
  assert.equal(response.status,502);
  assert.equal(app.run('capturedMs'),120000);
  assert.equal(app.run('wasAborted'),true);
  assert.match(response.body.error,/超时/);
});

test('batch speed UI: numeric sorting, missing last, separate windows and stable ties', () => {
  const ui = frontend();
  ui.run(`SPEED_RESULTS = [
    {ok:true,upstream:'slow',generationSpeed:10,firstPacketMs:20,detail:{source:'OpenRouter',offers:[{input:0,uptimeShort:95,uptimeDay:99}]}},
    {ok:false,upstream:'failed',state:'失败',error:'<bad>'},
    {ok:true,upstream:'fast',generationSpeed:100,firstPacketMs:200,detail:{source:'Vercel',offers:[{input:3,uptimeShort:99,uptimeDay:100}]}},
    {ok:true,upstream:'tie',generationSpeed:100,firstPacketMs:30}
  ];`);
  for (const [key, order] of [['generationSpeed','fast,tie,slow,failed'],['firstPacketMs','slow,tie,fast,failed'],['input','fast,slow,failed,tie'],['uptime5m','slow,failed,fast,tie'],['uptime15m','fast,slow,failed,tie'],['uptimeDay','fast,slow,failed,tie']]) {
    ui.run(`sortSpeedTable('${key}')`);
    assert.equal(ui.run('speedTableRows().map(r=>r.upstream).join()'),order);
  }
  assert.ok(ui.result.innerHTML.includes('可用(5m)'));
  assert.ok(ui.result.innerHTML.includes('可用(15m)'));
  assert.ok(!ui.result.innerHTML.includes('&lt;bad&gt;'));
  assert.ok(ui.result.innerHTML.includes('失败'));
  assert.ok(ui.result.innerHTML.includes('class="speed-table-wrap"'));
  assert.ok(!ui.result.innerHTML.includes('<th>来源 / 详情</th>'));
});

test('batch speed UI: default all, controls and sequential progressive results', async () => {
  const ui = frontend();
  ui.run(`var inputs=[], nodes={};
    document.querySelector = (id) => nodes[id] ||= {value:'${model}',dataset:{},style:{},querySelectorAll:(selector)=>selector==='input:checked'?inputs.filter(x=>x.checked):inputs};
    DATA={subscription:[{id:'${model}',config:{},meta:{upstreams:['a','b','c']}}]};
    onSpeedModelChange();`);
  assert.equal(ui.run(`$('#speedUpstreams').innerHTML.match(/ checked/g).length`),3);
  ui.run(`inputs=['a','b','c'].map(value=>({value,checked:true})); selectSpeedUpstreams(false);`);
  assert.equal(ui.run(`$('#speedBtn').disabled`),true);
  ui.run(`selectSpeedUpstreams(true); var calls=[], snapshots=[], active=0, maxActive=0;
    renderSpeedTable=()=>snapshots.push(SPEED_RESULTS.map(r=>r.state).join());
    api=async(url,body)=>{
      active++;maxActive=Math.max(active,maxActive);calls.push(body.upstream);
      await Promise.resolve();active--;
      if(body.upstream==='b') throw new Error('simulated failure');
      return {ok:true,generationSpeed:body.upstream==='c'?100:10};
    };`);
  await ui.run('runSpeedTest()');
  assert.equal(ui.run('calls.join()'),'a,b,c');
  assert.equal(ui.run('maxActive'),1);
  assert.equal(ui.run('snapshots.includes("完成,测速中,等待中")'),true);
  assert.equal(ui.run('SPEED_RESULTS.map(r=>r.state).join()'),'完成,失败,完成');
  assert.equal(ui.run('SPEED_SORT'),'generationSpeed');
  assert.equal(ui.run('speedTableRows().map(r=>r.upstream).join()'),'c,a,b');
  assert.equal(ui.run('SPEED_BUSY'),false);
  assert.equal(ui.run('inputs.every(x=>!x.disabled)'),true);
});
