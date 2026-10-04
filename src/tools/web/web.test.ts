import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { download, publicAddress, publicUrl, pinnedRequest, LIMITS, REQUEST_BODY_BYTES, type Connector } from './network.js';
import { createWebTools, extract, searchInput } from './tools.js';

const publicIp = { address: '93.184.216.34', family: 4 };
const resolver = vi.fn(async () => [publicIp]);
function response(body: string | Buffer = 'hello', status = 200, headers: Record<string, string> = { 'content-type': 'text/plain' }): http.IncomingMessage {
  const stream = new PassThrough() as unknown as http.IncomingMessage;
  stream.statusCode = status; stream.headers = headers;
  queueMicrotask(() => (stream as unknown as PassThrough).end(body));
  return stream;
}
function connector(body: string | Buffer = 'hello', status = 200, headers?: Record<string, string>) {
  return vi.fn<Connector>(async () => response(body, status, headers));
}
async function run(tool: ReturnType<typeof createWebTools>[string], input: unknown) {
  return tool.execute!(input as never, {} as never) as Promise<any>;
}
afterEach(() => vi.restoreAllMocks());

describe('SSRF policy corpus', () => {
  const forbidden = ['0.0.0.0','127.0.0.1','127.255.255.255','10.0.0.1','172.16.0.1','172.31.255.255','192.168.1.1','169.254.169.254','100.64.0.1','192.0.0.9','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','240.0.0.1','255.255.255.255','::','::1','::ffff:127.0.0.1','::ffff:a00:1','fe80::1','fc00::1','ff02::1','2001:db8::1','2001::1','2002:7f00:1::','3fff::1','64:ff9b::7f00:1'];
  it.each(forbidden)('rejects %s', (address) => expect(publicAddress(address)).toBe(false));
  it.each(['http://2130706433','http://0x7f000001','http://0177.0.0.1','http://127.1','http://[::ffff:127.0.0.1]','http://localhost','http://metadata.google.internal','http://x.local','http://example.org:8080','https://x.org:80','ftp://x.org','http://u:p@x.org','http://[fe80::1%25en0]'])('rejects URL %s', (url) => expect(() => publicUrl(url)).toThrow());
  it('allows only standard ports and canonical public addresses', () => {
    expect(publicUrl('https://www.wikipedia.org:443/a#b').href).toBe('https://www.wikipedia.org/a');
    expect(publicAddress('8.8.8.8')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
    expect(publicAddress('::ffff:8.8.8.8')).toBe(true);
  });
  it('samples private IPv4 ranges and mapped encodings', () => {
    for (let i = 0; i < 256; i++) {
      for (const address of [`10.${i}.1.2`, `127.${i}.0.1`, `192.168.${i}.3`, `169.254.${i}.4`]) {
        expect(publicAddress(address)).toBe(false);
        expect(publicAddress(`::ffff:${address}`)).toBe(false);
      }
    }
  });
  it('rejects mixed DNS answers before connecting', async () => {
    const connect = connector();
    await expect(download('https://safe.org', { resolver: async () => [publicIp, {address:'127.0.0.1',family:4}], connector: connect })).rejects.toMatchObject({code:'UNSAFE_ADDRESS'});
    expect(connect).not.toHaveBeenCalled();
  });
  it('revalidates every redirect and never connects to private target', async () => {
    const connect = connector('', 302, { location: 'http://169.254.169.254/latest' });
    await expect(download('https://safe.org', {resolver, connector:connect})).rejects.toMatchObject({code:'UNSAFE_URL'});
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('rejects a redirect with unsafe DNS and bounds loops', async () => {
    const connect = connector('',302,{location:'https://other.org'});
    await expect(download('https://safe.org',{resolver:async (host)=>host==='safe.org'?[publicIp]:[{address:'::1',family:6}],connector:connect})).rejects.toMatchObject({code:'UNSAFE_ADDRESS'});
    await expect(download('https://safe.org',{resolver,connector:connect})).rejects.toMatchObject({code:'REDIRECT_LIMIT'});
  });
});

describe('native connection pinning', () => {
  it('the real HTTP socket invokes pinned lookup, not changing DNS (local socket fixture only)', async () => {
    const server = http.createServer((_req,res) => {res.setHeader('content-type','text/plain');res.end('fixture');});
    await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
    const port = (server.address() as net.AddressInfo).port;
    const originalConnect = net.Socket.prototype.connect;
    const seen: string[] = [];
    // Test-only socket routing: preserve native HTTP -> net lookup path, capture the
    // address actually returned by its pinned lookup, then route to the local fixture.
    const spy = vi.spyOn(net.Socket.prototype,'connect').mockImplementation(function(this: net.Socket, ...args: any[]) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (options?.host === 'rebind.org') {
        const pinned = options.lookup;
        options.port = port;
        options.lookup = (host: string, opts: unknown, callback: (...values: any[])=>void) => pinned(host, opts, (error: unknown, address: any, family: number) => {
          seen.push(Array.isArray(address) ? address[0].address : address);
          callback(error, Array.isArray(address) ? [{address:'127.0.0.1',family:4}] : '127.0.0.1', family);
        });
      }
      return originalConnect.apply(this, args as never);
    });
    let calls = 0;
    try {
      const result = await download('http://rebind.org', { resolver: async()=> ++calls===1 ? [publicIp] : [{address:'127.0.0.1',family:4}] });
      expect(result.body.toString()).toBe('fixture');
      expect(seen).toEqual([publicIp.address]);
      expect(calls).toBe(1);
    } finally {spy.mockRestore(); await new Promise<void>((resolve)=>server.close(()=>resolve()));}
  });
  it('preserves TLS hostname/certificate validation and disallows proxy/pooled agents', async () => {
    const fake = { on: vi.fn(), end: vi.fn() };
    const request = vi.spyOn(https,'request').mockImplementation(((_url: URL, options: any, callback: any) => {
      expect(options.servername).toBe('safe.org'); expect(options.rejectUnauthorized).toBe(true); expect(options.agent).toBe(false);
      expect(options.headers.Authorization).toBeUndefined(); expect(options.headers.Cookie).toBeUndefined();
      options.lookup('safe.org',{all:true}, (_error: unknown, addresses: unknown)=>expect(addresses).toEqual([publicIp]));
      callback(response()); return fake;
    }) as any);
    const res = await pinnedRequest(new URL('https://safe.org'),publicIp,new AbortController().signal);
    res.destroy(); expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('native Exa POST and fetch isolation', () => {
  it('sends exact JSON/key only to Exa with pinned DNS/TLS; subsequent fetch is GET without body or credentials', async () => {
    const calls: {url:string; options:any; body:unknown}[] = [];
    vi.spyOn(https,'request').mockImplementation(((url: URL, options: any, callback: any) => {
      const call = {url:url.href,options,body:undefined as unknown}; calls.push(call);
      expect(options.agent).toBe(false);expect(options.rejectUnauthorized).toBe(true);
      expect(options.servername).toBe(url.hostname);
      options.lookup(url.hostname,{all:true},(_error:unknown,addresses:unknown)=>expect(addresses).toEqual([publicIp]));
      return {on:vi.fn(),end:(body:unknown)=>{
        call.body=body;
        callback(url.hostname==='api.exa.ai'?response('{"results":[]}',200,{'content-type':'application/json'}):response('direct text'));
      }};
    }) as any);
    const tools=createWebTools({exaApiKey:'synthetic-key',network:{resolver}});
    expect(await run(tools.web_search!,{query:'a"\\b',count:1})).toMatchObject({ok:true,provider:'Exa'});
    expect(await run(tools.web_fetch!,{url:'https://source.org/read',maxChars:100})).toMatchObject({ok:true,evidence:'fetched_text'});
    expect(calls[0]!.url).toBe('https://api.exa.ai/search');expect(calls[0]!.options.method).toBe('POST');
    expect(calls[0]!.options.headers).toMatchObject({'x-api-key':'synthetic-key','Content-Type':'application/json'});
    expect(JSON.parse(calls[0]!.body as string)).toEqual({query:'a"\\b',numResults:1,type:'auto',contents:{highlights:{maxCharacters:2000}}});
    expect(calls[1]!.options.method).toBe('GET');expect(calls[1]!.body).toBeUndefined();
    for(const header of ['x-api-key','Authorization','Cookie','Content-Type']) expect(calls[1]!.options.headers[header]).toBeUndefined();
  });
  it('rejects oversized/nonfixed POSTs and redirect-enabled POSTs before connection', async () => {
    const connect=connector();
    for(const [url,redirects,body] of [['https://other.org',0,'{}'],['https://api.exa.ai/search',1,'{}'],['https://api.exa.ai/search',0,'x'.repeat(REQUEST_BODY_BYTES+1)]] as const) {
      await expect(download(url,{resolver,connector:connect},{},redirects,{method:'POST',body})).rejects.toMatchObject({code:'INVALID_REQUEST'});
    }
    expect(connect).not.toHaveBeenCalled();
  });
  it('native POST redirects never forward the key/body to another host', async () => {
    const request=vi.spyOn(https,'request').mockImplementation(((_url:URL,_options:any,callback:any)=>({on:vi.fn(),end:()=>callback(response('',307,{location:'https://evil.org'}))})) as any);
    const result=await run(createWebTools({exaApiKey:'synthetic',network:{resolver}}).web_search!,{query:'q',count:1});
    expect(result).toMatchObject({ok:false,error:{code:'REDIRECT_LIMIT',retryable:false}});
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('deadlines, bytes, types and extraction', () => {
  it('bounds DNS and hanging body under the total deadline', async () => {
    await expect(download('https://safe.org',{resolver:()=>new Promise(()=>{}),deadlineMs:20})).rejects.toMatchObject({code:'TIMEOUT'});
    const stream = new PassThrough() as unknown as http.IncomingMessage; stream.statusCode=200; stream.headers={'content-type':'text/plain'};
    await expect(download('https://safe.org',{resolver,connector:async()=>stream,deadlineMs:20})).rejects.toMatchObject({code:'TIMEOUT'});
    expect(stream.destroyed).toBe(true);
  });
  it('bounds a hanging connector and invalid compressed response', async () => {
    await expect(download('https://safe.org',{resolver,connector:()=>new Promise(()=>{}),deadlineMs:20})).rejects.toMatchObject({code:'TIMEOUT'});
    await expect(download('https://safe.org',{resolver,connector:connector('not gzip',200,{'content-type':'text/plain','content-encoding':'gzip'})})).rejects.toMatchObject({code:'NETWORK_ERROR'});
  });
  it('rejects oversized decoded compressed bodies and raw bodies', async () => {
    for (const [body,encoding] of [[gzipSync('x'.repeat(LIMITS.bodyBytes+1)),'gzip'],[Buffer.alloc(LIMITS.bodyBytes+1),'identity']] as const) {
      await expect(download('https://safe.org',{resolver,connector:connector(body,200,{'content-type':'text/plain','content-encoding':encoding})})).rejects.toMatchObject({code:'BODY_LIMIT'});
    }
  });
  it.each(['application/pdf','image/png','application/octet-stream','', 'text/html; charset=iso-8859-1'])('rejects unsupported MIME %s', async (mime)=> {
    await expect(download('https://safe.org',{resolver,connector:connector('data',200,{'content-type':mime})})).rejects.toMatchObject({code:'UNSUPPORTED_TYPE'});
  });
  it('extracts useful HTML without scripts, labels partial and empty results',()=>{
    const html='<html><head><title>Fixture</title></head><body><article><p>'+ 'Useful content. '.repeat(100)+'</p><script>danger()</script></article></body></html>';
    const result=extract(Buffer.from(html),'text/html',100);
    expect(extract(Buffer.from('<p>Fragment text</p>'),'text/html',100).text).toBe('Fragment text');
    expect(result.title).toBe('Fixture'); expect(result.text).toContain('Useful'); expect(result.text).not.toContain('danger'); expect(result.truncated).toBe(true); expect(result.complete).toBe(false);
    expect(extract(Buffer.from(''),'text/plain',100)).toMatchObject({text:'',complete:true,lines:{start:0,end:0}});
    expect(()=>extract(Buffer.from('%PDF-1.7'),'text/plain',100)).toThrow();
    expect(()=>extract(Buffer.from([0xff,0,1]),'text/plain',100)).toThrow();
  });
});

describe('tools and Exa',()=>{
  it('registers fetch and keyless search',()=>expect(Object.keys(createWebTools())).toEqual(['web_fetch','web_search']));
  it('validates bounded query/count',()=>{
    expect(searchInput.safeParse({query:' ',count:1}).success).toBe(false);
    expect(searchInput.safeParse({query:'a'.repeat(401),count:1}).success).toBe(false);
    expect(searchInput.safeParse({query:'q',count:11}).success).toBe(false);
  });
  it('uses fixed official API, header-only synthetic key, never fetches results',async()=>{
    const connect=connector(JSON.stringify({results:[{title:'Title',url:'https://source.org',highlights:['snippet'],publishedDate:'2026-01-01'}]}),200,{'content-type':'application/json'});
    const tools=createWebTools({exaApiKey:'synthetic-key',network:{resolver,connector:connect}});
    const result=await run(tools.web_search!,{query:'query',count:1});
    expect(result).toMatchObject({ok:true,evidence:'search_snippets',results:[{publishedAt:'2026-01-01',snippet:'snippet'}]});
    const [url,,,_headers,request]=connect.mock.calls[0]!;
    expect(url.href).toBe('https://api.exa.ai/search'); expect(url.href).not.toContain('synthetic-key');
    expect(_headers).toMatchObject({'x-api-key':'synthetic-key','Content-Type':'application/json'});
    expect(request?.method).toBe('POST');
    expect(JSON.parse(request!.body)).toEqual({query:'query',numResults:1,type:'auto',contents:{highlights:{maxCharacters:2000}}});
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('distinguishes valid empty search results from malformed provider data',async()=>{
    const empty=await run(createWebTools({exaApiKey:'synthetic',network:{resolver,connector:connector('{"results":[]}',200,{'content-type':'application/json'})}}).web_search!,{query:'q',count:1});
    expect(empty).toMatchObject({ok:true,results:[],complete:true});
    const malformed=await run(createWebTools({exaApiKey:'synthetic',network:{resolver,connector:connector('{}',200,{'content-type':'application/json'})}}).web_search!,{query:'q',count:1});
    expect(malformed).toMatchObject({ok:false,error:{code:'INVALID_RESPONSE',retryable:false}});
  });
  it('accepts absent/null metadata and missing highlights without synthesizing snippets',async()=>{
    const connect=connector(JSON.stringify({results:[{url:'https://source.org',title:null,publishedDate:null,author:null,highlights:null},{url:'https://other.org',title:'T'}]}),200,{'content-type':'application/json'});
    const result=await run(createWebTools({exaApiKey:'synthetic',network:{resolver,connector:connect}}).web_search!,{query:'q',count:2});
    expect(result).toMatchObject({ok:true,provider:'Exa',complete:true,truncated:false,results:[{title:'',snippet:''},{title:'T',snippet:''}]});
    expect(result.results.every((r:any)=>!('publishedAt' in r))).toBe(true);
  });
  it('filters unsafe URLs and marks locally capped/filtered response incomplete',async()=>{
    const connect=connector(JSON.stringify({results:[{title:'Unsafe',url:'http://127.0.0.1'},{title:'T',url:'https://source.org',highlights:['one','two']},{title:'Extra',url:'https://other.org'}]}),200,{'content-type':'application/json'});
    const result=await run(createWebTools({exaApiKey:'synthetic',network:{resolver,connector:connect}}).web_search!,{query:'q',count:2});
    expect(result).toMatchObject({ok:true,complete:false,truncated:true,results:[{title:'T',snippet:'one\ntwo'}]});
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('fails closed on malformed schema, error envelopes, non-JSON MIME and invalid UTF-8',async()=>{
    for(const body of ['{}','{"error":"synthetic-key"}','{"results":null}','{"results":[{"url":1}]}',Buffer.from([0xff])]) {
      const result=await run(createWebTools({exaApiKey:'synthetic-key',network:{resolver,connector:connector(body,200,{'content-type':'application/json'})}}).web_search!,{query:'q'});
      expect(result).toMatchObject({ok:false,error:{code:'INVALID_RESPONSE',retryable:false}});
      expect(JSON.stringify(result)).not.toContain('synthetic-key');
    }
    expect(await run(createWebTools({exaApiKey:'synthetic',network:{resolver,connector:connector('{"results":[]}',200,{'content-type':'text/plain'})}}).web_search!,{query:'q'})).toMatchObject({ok:false});
  });
  it('does not invent missing dates and labels bounded results',async()=>{
    const connect=connector(JSON.stringify({results:[{title:'T',url:'https://source.org',highlights:['x'.repeat(3000)]}]}),200,{'content-type':'application/json'});
    const result=await run(createWebTools({exaApiKey:'synthetic',network:{resolver,connector:connect}}).web_search!,{query:'q',count:1});
    expect(result.truncated).toBe(true);expect(result.complete).toBe(false);expect(result.results[0]).not.toHaveProperty('publishedAt');
  });
  it('returns safe retryable errors without key leakage; search rejects redirects',async()=>{
    for(const status of [429,500,503,401,402,302,307,308]) {
      const connect=connector('provider secret synthetic-key',status,{location:'https://evil.org','content-type':'application/json'});
      const result=await run(createWebTools({exaApiKey:'synthetic-key',network:{resolver,connector:connect}}).web_search!,{query:'q',count:1});
      expect(result.ok).toBe(false);expect(result.error.retryable).toBe(status===429||status>=500);expect(JSON.stringify(result)).not.toContain('synthetic-key');
      expect(connect).toHaveBeenCalledTimes(1);
      if(status===402) {expect(result.error.code).toBe('CREDIT_EXHAUSTED');expect(result.error.message).toContain('크레딧');}
      if(status===401) expect(result.error.code).toBe('AUTH_ERROR');
    }
  });
  it('returns bounded text with citation metadata across a public redirect',async()=>{
    let hop=0;
    const connect=vi.fn<Connector>(async()=>hop++===0?response('',302,{location:'https://final.org/read'}):response('x'.repeat(200)));
    const result=await run(createWebTools({network:{resolver,connector:connect}}).web_fetch!,{url:'https://safe.org',maxChars:100});
    expect(result).toMatchObject({ok:true,originalUrl:'https://safe.org',finalUrl:'https://final.org/read',complete:false,truncated:true});
    expect(result.text.length).toBe(100);expect(connect).toHaveBeenCalledTimes(2);
  });
  it('fetch returns citation metadata and type, rather than snippets',async()=>{
    const result=await run(createWebTools({network:{resolver,connector:connector('line1\nline2')}}).web_fetch!,{url:'https://safe.org',maxChars:100});
    expect(result).toMatchObject({ok:true,evidence:'fetched_text',originalUrl:'https://safe.org',finalUrl:'https://safe.org/',lines:{start:1,end:2},complete:true});expect(result.fetchedAt).toBeTruthy();
  });
});
