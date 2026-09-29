import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseArgs, sendNotification, validateEndpoint } from '../cli/notify.ts';

const payload = { target: 'dev', message: 'Ready for review.' };
const apiKey = 'a'.repeat(64);
const endpoint = 'https://notify.example.com/v1/notify';
const opts = (fetchImpl: typeof fetch) => ({ endpoint, apiKey, fetchImpl });
const receipt = { ok: true, delivery: 'sent', requestId: 'request-1', target: 'dev', channel: 'C0123456789', ts: '1700000000.000001' };

test('CLI flags reject ambiguity and accidental unsupported options', () => {
  assert.deepEqual(parseArgs(['--target','dev','--message','Ready','--dry-run']).payload, { target: 'dev', message: 'Ready' });
  assert.throws(() => parseArgs(['--file','input.json','--target','dev']));
  assert.throws(() => parseArgs(['--target','dev','--target','releases']));
  assert.throws(() => parseArgs(['--api-key','secret']));
  assert.throws(() => parseArgs(['--message']));
});

test('sender endpoint allows HTTPS or exact loopback, with no credential/query redirects', () => {
  assert.equal(validateEndpoint(endpoint), endpoint);
  assert.equal(validateEndpoint('http://127.0.0.1:8787/v1/notify'), 'http://127.0.0.1:8787/v1/notify');
  for (const url of ['http://example.com/v1/notify','https://user:pass@example.com/v1/notify', 'https://example.com/v1/notify?key=secret', 'https://example.com/v1/notify#fragment', 'http://127.0.0.1.example.com/v1/notify', 'https://example.com/other']) assert.throws(() => validateEndpoint(url));
});

test('sender checks receipt and sends only one authenticated POST with redirect error', async () => {
  let calls = 0;
  const result = await sendNotification(payload, opts(async (url, init) => {
    calls++;
    assert.equal(url, endpoint);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${apiKey}`);
    assert.equal(JSON.parse(String(init?.body)).target, 'dev');
    return Response.json(receipt);
  }));
  assert.equal(calls, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.body.delivery, 'sent');
});

test('200 without a valid destination receipt is unknown, never success', async () => {
  for (const body of [{ok: true}, { ...receipt, target: 'elsewhere' }, {...receipt, ts: 'invalid'}, {...receipt,channel:['C0123456789'],ts:['1700000000.000001']}]) {
    const result = await sendNotification(payload, opts(async () => Response.json(body)));
    assert.equal(result.exitCode, 4);
    assert.equal(result.body.delivery, 'unknown');
  }
});

test('API key is redacted before shortening error messages or copying identifiers', async () => {
  const result = await sendNotification(payload, opts(async () => Response.json({ok:false,delivery:'not_sent',retryable:false,requestId:apiKey,error:{code:apiKey,message:'x'.repeat(380)+apiKey}}, {status:502})));
  assert.ok(!JSON.stringify(result).includes('a'.repeat(20)));
  assert.match((result.body.error as {message:string}).message, /\[redacted\]/);
});

test('429 exposes full wait and performs no retry', async () => {
  let calls = 0;
  const result = await sendNotification(payload, opts(async () => {
    calls++;
    return Response.json({ok:false,delivery:'not_sent',retryable:true,retryAfterSeconds:120,error:{code:'slack_rate_limited',message:'Wait before retrying.'}}, {status:429});
  }));
  assert.equal(calls,1);
  assert.equal(result.exitCode,3);
  assert.equal(result.body.retryAfterSeconds,120);
});

test('network uncertainty and unrecognized proxy content never become retryable', async () => {
  const results = [
    await sendNotification(payload, opts(async () => { throw new Error('connection lost'); })),
    await sendNotification(payload, opts(async () => new Response('<html>private diagnostic page</html>', {status:502}))),
    await sendNotification(payload, opts(async () => new Response('x'.repeat(17000), {status:502}))),
  ];
  for (const result of results) {
    assert.equal(result.exitCode,4);
    assert.equal(result.body.retryable,false);
    assert.equal(result.body.delivery,'unknown');
    assert.ok(!JSON.stringify(result).includes('private diagnostic'));
  }
});

test('large Retry-After values remain available without inventing a shorter delay', async () => {
  const value = '999999999999999999999999';
  const result = await sendNotification(payload, opts(async () => Response.json({ok:false,delivery:'not_sent',retryable:true,error:{code:'slack_rate_limited',message:'Wait before retrying.'}}, {status:429,headers:{'retry-after':value}})));
  assert.equal(result.exitCode,3);
  assert.equal(result.body.retryAfter,value);
  assert.ok(!Object.hasOwn(result.body,'retryAfterSeconds'));
});

test('timeout ends request without a second attempt', async () => {
  let calls = 0;
  const result = await sendNotification(payload, {endpoint,apiKey,timeoutMs:10,fetchImpl: async (_url, init) => {
    calls++;
    return await new Promise<Response>((_resolve,reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once:true}));
  }});
  assert.equal(calls,1);
  assert.equal(result.exitCode,4);
  assert.equal((result.body.error as {code:string}).code,'client_timeout');
});

test('dry-run executable works without secrets and invalid JSON exits 2', () => {
  const env = {...process.env};
  delete env.ZUDO_NOTIFY_URL;
  delete env.ZUDO_NOTIFY_API_KEY;
  const dry = spawnSync(process.execPath,['cli/notify.ts','--file','examples/npm-approval.json','--dry-run'],{cwd:new URL('..',import.meta.url),encoding:'utf8',env});
  assert.equal(dry.status,0,dry.stderr);
  const result = JSON.parse(dry.stdout);
  assert.equal(result.dryRun,true);
  assert.equal(result.notification.target,'releases');
  assert.equal(result.slackPayload.channel,'C0000000000');
  const invalid = spawnSync(process.execPath,['cli/notify.ts','--file','-'],{cwd:new URL('..',import.meta.url),encoding:'utf8',input:'{bad',env});
  assert.equal(invalid.status,2);
  assert.equal(JSON.parse(invalid.stderr).delivery,'not_sent');
  const malformedBytes = Buffer.concat([Buffer.from('{"target":"dev","message":"'), Buffer.from([255]), Buffer.from('"}')]);
  const invalidUtf8 = spawnSync(process.execPath,['cli/notify.ts','--file','-','--dry-run'],{cwd:new URL('..',import.meta.url),encoding:'utf8',input:malformedBytes,env});
  assert.equal(invalidUtf8.status,2);
  assert.match(JSON.parse(invalidUtf8.stderr).error.message,/UTF-8/);
});
