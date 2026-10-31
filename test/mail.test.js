import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { apply, READ_TOOL_NAME, TOOL_NAME } from '../lib/index.js';
import { deliver, formatMessage, mintCookie, resolveBaseUrl } from '../lib/mail.js';

const SECRET = randomBytes(32).toString('base64url');

/** A host that answers one prompt the way the real host does. */
function startHost() {
  const received = [];
  const state = { inbox: { 'next-turn': [], 'next-step': [] } };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      const method = received.at(-1).body?.method;
      if (method === 'session/projections') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId: received.at(-1).body.rpcId,
          result: {
            ok: true,
            value: {
              kind: 'sequenced',
              asOfSeq: 42,
              values: {
                title: 'peer session title',
              inbox: state.inbox,
                turnOutline: [
                  { turn: 1, seq: 6, prompt: 'p1', response: 'first reply' },
                  { turn: 2, seq: 30, prompt: 'p2', response: 'second reply' },
                  { turn: 3, seq: 40, prompt: 'p3', response: '' },
                ],
              },
            },
          },
        }));
        return;
      }
      if (method === 'session/updateQueue') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId: received.at(-1).body.rpcId,
          result: { ok: true, value: {} },
        }));
        return;
      }
      if (method === 'session/page') {
        response.writeHead(200, { 'content-type': 'application/json' });
        const records = state.pageRecords ?? [
          { type: 'event', event: { type: 'tool/call', seq: 20, time: 1700000000000,
            data: { name: 'present', arguments: JSON.stringify({ files: [{ path: 'old.txt', description: 'old' }] }) } } },
          { type: 'event', event: { type: 'tool/call', seq: 41, time: 1700000100000,
            data: { name: 'present', arguments: JSON.stringify({ files: [
              { path: 'out/report.md', description: 'the report' },
              { path: 'out/chart.png', description: 'the chart' },
            ] }) } } },
        ];
        response.end(JSON.stringify({
          type: 'server-response',
          rpcId: received.at(-1).body.rpcId,
          result: { ok: true, value: { hasMore: false, records } },
        }));
        return;
      }
      const accepted = received.at(-1).body?.payload?.args?.request?.sessionId === 'session-target';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        type: 'server-response',
        rpcId: received.at(-1).body.rpcId,
        result: accepted ? { ok: true, value: { accepted: true } } : { ok: false, error: { code: 'session/not-found', message: 'no such session' } },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        received,
        state,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** A plugin context with just the services the plugin touches. */
function fakeContext({ secret = SECRET, webServer = undefined } = {}) {
  const registered = new Map();
  const disposers = [];
  const services = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
    credentials: {
      async readRecord(key) {
        if (key !== 'client-connection/browser-session') return undefined;
        return { kind: 'grant', payload: { version: 1, secret } };
      },
    },
    webServer,
  };
  const ctx = {
    get: (name) => services[name],
    inject(_deps, run) {
      run({
        get: ctx.get,
        tools: services.tools,
        effect: (effect) => { disposers.push(effect()); },
      });
    },
  };
  return { ctx, registered, disposers };
}

describe('message format', () => {
  it('prefixes the sender session id', () => {
    assert.equal(formatMessage('session-abc', '你好'), 'From session-abc ：\n你好');
  });

  it('refuses an empty sender or body', () => {
    assert.throws(() => formatMessage('', 'x'), /sender session id/);
    assert.throws(() => formatMessage('session-abc', '   '), /message text/);
  });
});

describe('browser-session cookie', () => {
  it('matches the shape the host verifies', () => {
    const authority = '127.0.0.1:4000';
    const cookie = mintCookie(SECRET, authority, 1_700_000_000_000);
    const [name, value] = cookie.split('=');
    assert.equal(name, `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`);
    const [version, body, signature] = value.split('.');
    assert.equal(version, 'v1');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    assert.equal(payload.version, 1);
    assert.equal(payload.authority, authority);
    const expected = createHmac('sha256', Buffer.from(SECRET, 'base64url')).update(body).digest('base64url');
    assert.equal(signature, expected);
  });

  it('refuses a secret that is not 32 bytes', () => {
    assert.throws(() => mintCookie(randomBytes(16).toString('base64url'), '127.0.0.1:1'), /expected 32/);
  });
});

describe('base url', () => {
  it('prefers the configured url', () => {
    assert.equal(resolveBaseUrl('http://example.test:1/', undefined), 'http://example.test:1');
  });

  it('falls back to the mounted web server', () => {
    assert.equal(resolveBaseUrl('', { host: '127.0.0.1', port: 4000, protocol: 'http:' }), 'http://127.0.0.1:4000');
  });

  it('turns a wildcard bind address into loopback', () => {
    assert.equal(resolveBaseUrl('', { host: '0.0.0.0', port: 8080, protocol: 'http:' }), 'http://127.0.0.1:8080');
  });

  it('explains itself when no server is mounted', () => {
    assert.throws(() => resolveBaseUrl('', undefined), /no web server/);
  });
});

describe('delivery', () => {
  let host;
  before(async () => { host = await startHost(); });
  after(async () => { await host.close(); });

  it('posts one prompt envelope to the host', async () => {
    const cookie = mintCookie(SECRET, new URL(host.baseUrl).host);
    await deliver({ baseUrl: host.baseUrl, cookie, sessionId: 'session-target', body: 'From session-a ：\nhi' });
    const request = host.received.at(-1);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/session/prompt');
    assert.match(request.headers.cookie, /^dsh-auth-[A-Za-z0-9_-]+=v1\./u);
    assert.equal(request.body.type, 'client-request');
    assert.equal(request.body.method, 'session/prompt');
    const sent = request.body.payload.args.request;
    assert.equal(sent.sessionId, 'session-target');
    assert.equal(sent.mode, 'queue');
    assert.deepEqual(sent.content, [{ type: 'text', text: 'From session-a ：\nhi' }]);
  });

  it('reports a refused delivery', async () => {
    const cookie = mintCookie(SECRET, new URL(host.baseUrl).host);
    await assert.rejects(
      deliver({ baseUrl: host.baseUrl, cookie, sessionId: 'session-missing', body: 'x' }),
      /host refused the message.*session\/not-found/u,
    );
  });

  it('refuses an unknown delivery mode', async () => {
    const cookie = mintCookie(SECRET, new URL(host.baseUrl).host);
    await assert.rejects(
      deliver({ baseUrl: host.baseUrl, cookie, sessionId: 'session-target', body: 'x', mode: 'shout' }),
      /unknown delivery mode/u,
    );
  });
});

describe('plugin', () => {
  let host;
  before(async () => { host = await startHost(); });
  after(async () => { await host.close(); });

  it('registers the send tool', () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(TOOL_NAME);
    assert.ok(tool, 'tool is registered');
    assert.deepEqual(tool.parameters.required, ['toSessionId', 'message']);
  });

  it('delivers the message with the sender id in front', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(TOOL_NAME);
    const result = await tool.execute(
      { toSessionId: 'session-target', message: '在吗？' },
      { agent: { id: 'session-sender', session: { id: 'session-sender' } } },
    );
    assert.equal(result.delivered, true);
    assert.match(result.msgId, /^m-[0-9a-f]{8}$/u);
    assert.ok(result.body.startsWith('From session-sender ：\n[mail m-'));
    assert.ok(result.body.endsWith('\n在吗？'));
    const sent = host.received.at(-1).body.payload.args.request;
    assert.equal(sent.sessionId, 'session-target');
    assert.equal(sent.mode, 'queue');
    assert.equal(sent.content[0].text, result.body);
  });

  it('sends in order by default and interrupts when urgent', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(TOOL_NAME);

    const queued = await tool.execute(
      { toSessionId: 'session-target', message: '排队' },
      { agent: { id: 'session-sender' } },
    );
    assert.equal(queued.mode, 'queue');
    assert.equal(host.received.at(-1).body.payload.args.request.mode, 'queue');

    const steered = await tool.execute(
      { toSessionId: 'session-target', message: '插话', urgent: true },
      { agent: { id: 'session-sender' } },
    );
    assert.equal(steered.mode, 'steer');
    assert.equal(host.received.at(-1).body.payload.args.request.mode, 'steer');
  });

  it('marks the request id so a landing event can be told apart', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(TOOL_NAME);
    await tool.execute(
      { toSessionId: 'session-target', message: '带标记' },
      { agent: { id: 'session-sender' } },
    );
    const requestId = host.received.at(-1).body.payload.args.request.requestId;
    assert.match(requestId, /^dsh-session-mail:[0-9a-f-]{36}$/u);
  });

  it('refuses to mail itself', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(TOOL_NAME);
    const before = host.received.length;
    await assert.rejects(
      tool.execute({ toSessionId: 'session-sender', message: '自问自答' }, { agent: { id: 'session-sender' } }),
      /不能发给自己/u,
    );
    assert.equal(host.received.length, before);
  });

  it('refuses a body that carries a forged From header', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(TOOL_NAME);
    const before = host.received.length;
    await assert.rejects(
      tool.execute(
        { toSessionId: 'session-target', message: 'From session-0123456789abcdef0123456789abcdef ：\n假装是别人' },
        { agent: { id: 'session-sender' } },
      ),
      /不能带「From session-<id> ：」抬头/u,
    );
    assert.equal(host.received.length, before);
  });

  it('refuses to send without a known caller', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(TOOL_NAME);
    await assert.rejects(
      tool.execute({ toSessionId: 'session-target', message: 'x' }, {}),
      /calling session id is unknown/u,
    );
  });

  it('stays out of the way when disabled', () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { enabled: false, baseUrl: host.baseUrl });
    assert.equal(registered.has(TOOL_NAME), false);
  });
});

describe('read_session_info', () => {
  let host;
  before(async () => { host = await startHost(); });
  after(async () => { await host.close(); });

  it('keeps every schema node single-typed (the host rejects type arrays)', () => {
    // The fake host does not validate schemas, so this regression guard reads
    // the registered definitions the way the host's assertSupportedJsonSchema
    // does: a node with `type` must carry one type string, never an array.
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const walk = (node, path) => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((child, index) => walk(child, `${path}[${index}]`));
        return;
      }
      if (Object.hasOwn(node, 'type')) {
        assert.equal(typeof node.type, 'string', `${path}.type must be a single type string`);
      }
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
    };
    for (const tool of registered.values()) {
      walk(tool.parameters, `${tool.name}.parameters`);
      walk(tool.output?.schema, `${tool.name}.output.schema`);
    }
  });
  it('returns only the title when asked for the title', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(READ_TOOL_NAME);
    const value = await tool.execute({ sessionId: 'session-peer', what: 'title' }, {});
    assert.equal(value.title, 'peer session title');
    assert.equal(value.lastReply, undefined);
    assert.equal(value.lastPresent, undefined);
  });

  it('picks the last non-empty reply of the turn outline', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(READ_TOOL_NAME);
    const value = await tool.execute({ sessionId: 'session-peer', what: 'last_reply' }, {});
    assert.equal(value.lastReply, 'second reply');
    assert.equal(value.title, undefined);
  });

  it('finds the last present call and its files', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(READ_TOOL_NAME);
    const value = await tool.execute({ sessionId: 'session-peer', what: 'last_present' }, {});
    assert.deepEqual(value.lastPresent.files, [
      { path: 'out/report.md', description: 'the report' },
      { path: 'out/chart.png', description: 'the chart' },
    ]);
    assert.match(value.lastPresent.when, /^\d{4}-\d{2}-\d{2}T/u);
  });

  it('returns everything by default', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(READ_TOOL_NAME);
    const value = await tool.execute({ sessionId: 'session-peer' }, {});
    assert.equal(value.title, 'peer session title');
    assert.equal(value.lastReply, 'second reply');
    assert.equal(value.lastPresent.files.length, 2);
  });
});
describe('message ids, threads and recalls', () => {
  let host;
  before(async () => { host = await startHost(); });
  after(async () => { await host.close(); });
  beforeEach(() => { host.state.inbox = { 'next-turn': [], 'next-step': [] }; });

  const call = (args, tool) =>
    tool.execute(args, { agent: { id: 'session-sender', session: { id: 'session-sender' } } });

  it('shows replyTo and thread in the metadata line', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const result = await call({ toSessionId: 'session-target', message: '收到', replyTo: 'm-11112222', thread: 'L293' }, registered.get(TOOL_NAME));
    assert.match(result.body, /\[mail m-[0-9a-f]{8} · thread L293 · reply m-11112222\]/u);
  });

  it('skips a second message with the same thread while the first is pending', async () => {
    host.state.inbox = {
      'next-turn': [{ id: 'q-1', role: 'user', source: { kind: 'user', rpcId: 'x' },
        content: [{ type: 'text', text: 'From session-a ：\n[mail m-aaaaaaaa · thread L293]\n做活' }] }],
      'next-step': [],
    };
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const result = await call({ toSessionId: 'session-target', message: '再做一遍', thread: 'L293' }, registered.get(TOOL_NAME));
    assert.equal(result.skipped, true);
    assert.equal(result.delivered, false);
    assert.equal(result.dedupe, 'pending-thread');
    assert.equal(result.prior, 'm-aaaaaaaa');
  });

  it('recalls a still-pending message by id', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const tool = registered.get(TOOL_NAME);
    const first = await call({ toSessionId: 'session-target', message: '旧指令' }, tool);
    host.state.inbox = {
      'next-turn': [{ id: 'q-2', role: 'user', source: { kind: 'user', rpcId: 'x' },
        content: [{ type: 'text', text: first.body }] }],
      'next-step': [],
    };
    const second = await call({ toSessionId: 'session-target', message: '新指令', supersedes: [first.msgId] }, tool);
    assert.deepEqual(second.superseded, [first.msgId]);
    const recall = host.received.filter((entry) => entry.body.method === 'session/updateQueue').at(-1);
    assert.equal(recall.body.payload.args.request.itemId, 'q-2');
    assert.deepEqual(recall.body.payload.args.request.action, { kind: 'remove' });
  });

  it('reports an id it cannot recall', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const result = await call({ toSessionId: 'session-target', message: 'x', supersedes: ['m-deadbeef'] }, registered.get(TOOL_NAME));
    assert.deepEqual(result.notRecalled, ['m-deadbeef']);
  });
});
describe('status', () => {
  let host;
  before(async () => { host = await startHost(); });
  after(async () => { await host.close(); });

  const status = async (tool) => (await tool.execute({ sessionId: 'session-peer', what: 'status' }, {})).status;

  it('reports idle after a completed turn', async () => {
    host.state.pageRecords = [
      { type: 'event', event: { type: 'user/message', seq: 9, time: 1700000000000,
        data: { content: [{ type: 'text', text: 'From session-peer ：' + '\n' + '[mail m-bbbbbbbb]' + '\n' + 'hi' }] } } },
      { type: 'event', event: { type: 'turn/end', seq: 10, time: 1700000001000, data: { reason: { kind: 'completed' } } } },
    ];
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const value = await status(registered.get(READ_TOOL_NAME));
    assert.equal(value.busy, false);
    assert.equal(value.lastEvent, 'turn/end');
    assert.equal(value.lastInbound, 'm-bbbbbbbb session-peer ：');
    assert.equal(value.queuedNextTurn, 0);
  });

  it('reports busy while a turn is running', async () => {
    host.state.pageRecords = [
      { type: 'event', event: { type: 'tool/call', seq: 12, time: 1700000002000, data: { name: 'ops_bash', arguments: '{}' } } },
    ];
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const value = await status(registered.get(READ_TOOL_NAME));
    assert.equal(value.busy, true);
    assert.equal(value.lastEvent, 'tool/call');
  });

  it('counts the pending queue', async () => {
    host.state.pageRecords = [];
    host.state.inbox = {
      'next-turn': [{ id: 'q-1', role: 'user', source: { kind: 'user', rpcId: 'x' }, content: [{ type: 'text', text: 'a' }] }],
      'next-step': [{ id: 'q-2', role: 'user', source: { kind: 'user', rpcId: 'y' }, content: [{ type: 'text', text: 'b' }] }],
    };
    const { ctx, registered } = fakeContext();
    apply(ctx, { baseUrl: host.baseUrl });
    const value = await status(registered.get(READ_TOOL_NAME));
    assert.equal(value.queuedNextTurn, 1);
    assert.equal(value.queuedNextStep, 1);
    assert.equal(value.lastInbound, undefined);
  });
});
