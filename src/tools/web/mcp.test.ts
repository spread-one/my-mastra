import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { createWebTools } from './tools.js';
import { download, EXA_MCP_URL, LIMITS, type Connector } from './network.js';
import { SEARCH_OBJECTIVE } from './mcp.js';
const resolver = async () => [{ address:'93.184.216.34', family:4 }];
const text = 'Title: Public source\nURL: https://www.typescriptlang.org/docs/\nPublished: N/A\nAuthor: N/A\nHighlights:\nPublic snippet';
const payload = (t = text) => ({ jsonrpc:'2.0', id:1, result:{content:[{type:'text',text:t}]} });
function response(body:string|Buffer, mime='application/json', status=200) {
  const stream = new PassThrough() as unknown as http.IncomingMessage;
  stream.statusCode=status; stream.headers={'content-type':mime};
  queueMicrotask(()=>(stream as unknown as PassThrough).end(body)); return stream;
}
async function search(body:string|Buffer, mime='application/json', status=200) {
  const connector=vi.fn<Connector>(async()=>response(body,mime,status));
  const tool=createWebTools({network:{resolver,connector}}).web_search!;
  const result=await tool.execute!({query:'public query'} as never,{} as never) as any;
  return {result,connector};
}
describe('fixed keyless MCP contract',()=>{
  it('uses current basic schema exactly, defaults count, never reads result URLs',async()=>{
    const {result,connector}=await search(JSON.stringify(payload()));
    expect(result).toMatchObject({ok:true,provider:'Exa',evidence:'search_snippets',complete:true,results:[{title:'Public source',snippet:'Public snippet'}]});
    expect(result.results[0]).not.toHaveProperty('publishedAt');
    expect(connector).toHaveBeenCalledTimes(1);
    const [url,,,headers,request]=connector.mock.calls[0]!;
    expect(url.href).toBe(EXA_MCP_URL);
    expect(headers).toEqual({Accept:'application/json, text/event-stream','Content-Type':'application/json'});
    expect(JSON.parse(request!.body)).toEqual({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'web_search_exa',arguments:{query:'public query',numResults:5,objective:SEARCH_OBJECTIVE}}});
  });
  it('accepts CRLF, comments and multiline SSE JSON data',async()=>{
    const raw=JSON.stringify(payload());
    const split=raw.indexOf(',');
    const {result}=await search(`: heartbeat\r\nevent: message\r\ndata: ${raw.slice(0,split+1)}\r\ndata: ${raw.slice(split+1)}\r\n\r\n`,'text/event-stream');
    expect(result.ok).toBe(true);
  });
  it('accepts only documented exact empty message as zero results',async()=>{
    expect((await search(JSON.stringify(payload('No search results found. Please try a different query.')))).result).toMatchObject({ok:true,results:[],complete:true});
    for (const text of ['', 'No results', 'arbitrary https://source.org citation', '{"results":[]}']) expect((await search(JSON.stringify(payload(text)))).result.ok).toBe(false);
  });
  it('fails closed on envelopes, tool errors, unsupported content, invalid text/UTF8 and SSE ambiguity',async()=>{
    for (const value of [{...payload(),id:2},{...payload(),jsonrpc:'1.0'},{...payload(),error:{code:1}},{...payload(),result:{...payload().result,isError:true}},{...payload(),result:{content:[]}},{...payload(),result:{content:[{type:'image',text}]}},{}]) {
      expect((await search(JSON.stringify(value))).result.ok).toBe(false);
    }
    expect((await search(Buffer.from([255]))).result.ok).toBe(false);
    expect((await search(`data: ${JSON.stringify(payload())}\n\ndata: ${JSON.stringify(payload())}\n\n`,'text/event-stream')).result.ok).toBe(false);
    expect((await search(JSON.stringify(payload()),'text/plain')).result.ok).toBe(false);
  });
  it('bounds output, filters unsafe citations, supports Text labels',async()=>{
    const large=text.replace('Public snippet','x'.repeat(3000));
    expect((await search(JSON.stringify(payload(large)))).result).toMatchObject({ok:true,truncated:true,results:[{snippet:'x'.repeat(2000)}]});
    expect((await search(JSON.stringify(payload(text.replace('https://www.typescriptlang.org/docs/','http://127.0.0.1'))))).result).toMatchObject({ok:true,results:[],truncated:true});
    expect((await search(JSON.stringify(payload(text.replace('Highlights:\n','Text: '))))).result.ok).toBe(true);
  });
  it('bounds body and gives friendly 429 without retry',async()=>{
    const rate=await search('secret', 'application/json',429);
    expect(rate.result).toMatchObject({ok:false,error:{code:'RATE_LIMIT',retryable:true}});
    expect(rate.result.error.message).toContain('무료'); expect(rate.connector).toHaveBeenCalledTimes(1);
    expect((await search(Buffer.alloc(LIMITS.bodyBytes+1))).result).toMatchObject({ok:false,error:{code:'BODY_LIMIT'}});
    await expect(download(EXA_MCP_URL,{resolver,connector:async()=>new Promise(()=>{}),deadlineMs:20},{},0,{method:'POST',body:'{}'})).rejects.toMatchObject({code:'TIMEOUT'});
  });
  it('blocks MCP redirects and never falls back from keyed errors',async()=>{
    const redirect=await search('', 'application/json',307);
    expect(redirect.result).toMatchObject({ok:false,error:{code:'REDIRECT_LIMIT'}}); expect(redirect.connector).toHaveBeenCalledTimes(1);
    for(const status of [401,402,429,500]) {
      const connector=vi.fn<Connector>(async()=>response('error','application/json',status));
      await createWebTools({exaApiKey:'synthetic',network:{resolver,connector}}).web_search!.execute!({query:'q'} as never,{} as never);
      expect(connector).toHaveBeenCalledTimes(1); expect(connector.mock.calls[0]![0].href).toBe('https://api.exa.ai/search');
    }
  });
  it('allows SSE only for fixed MCP POST, not reader GET',async()=>{
    for (const url of [EXA_MCP_URL,'https://source.org']) await expect(download(url,{resolver,connector:async()=>response('data: {}','text/event-stream')})).rejects.toMatchObject({code:'UNSUPPORTED_TYPE'});
  });
  it('native MCP is pinned TLS POST without auth; subsequent direct fetch has no body/key',async()=>{
    const calls:any[]=[];
    const spy=vi.spyOn(https,'request').mockImplementation(((url:URL,options:any,callback:any)=>({on:vi.fn(),end:(body:unknown)=>{
      calls.push({url:url.href,options,body});
      options.lookup(url.hostname,{all:true},(_error:unknown,addresses:unknown)=>expect(addresses).toEqual([{address:'93.184.216.34',family:4}]));
      callback(url.hostname==='mcp.exa.ai'?response(JSON.stringify(payload())):response('direct','text/plain'));
    }})) as any);
    try {
      const tools=createWebTools({network:{resolver}});
      expect((await tools.web_search!.execute!({query:'q',count:1} as never,{} as never) as any).ok).toBe(true);
      await tools.web_fetch!.execute!({url:'https://source.org',maxChars:100} as never,{} as never);
      expect(calls[0].options).toMatchObject({method:'POST',servername:'mcp.exa.ai',agent:false,rejectUnauthorized:true});
      expect(calls[1].options.method).toBe('GET'); expect(calls[1].body).toBeUndefined();
      for(const call of calls) for(const header of ['x-api-key','Authorization','Cookie']) expect(call.options.headers[header]).toBeUndefined();
      expect(calls[1].options.headers['Content-Type']).toBeUndefined();
    } finally {spy.mockRestore();}
  });
});
