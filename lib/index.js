/**
 * dsh-session-mail — let an agent in one Session talk to the agent in another
 * Session of the same host.
 *
 * The plugin registers one model-facing tool. Calling it admits a prompt into
 * the target Session through the host's own `session/prompt` route, so the
 * target Session resumes with its own agent preset and answers in its own
 * turn. The delivered text always starts with the sender's Session id:
 *
 *     From <sender session id> ：
 *     <what the sender says>
 *
 * The recipient therefore knows the message came from another agent (not from
 * the human) and can answer with the same tool, addressing the sender by the
 * id in that first line.
 */
import { randomUUID } from 'node:crypto';
import { CREDENTIAL_KEY, callRpc, deliver, formatMessage, mintCookie, newMailId, resolveBaseUrl } from './mail.js';

/** Stable Cordis plugin name. */
export const name = 'dsh-session-mail';

/** Model-facing tool name. */
export const TOOL_NAME = 'send_session_message';

const MODE_MARKER = 'dsh-session-mail';
/** A From header at the start of any line: the identity marker, and the forged-forward trap. */
const FROM_HEADER = /^From session-[0-9a-f]{32} ：/mu;

const DESCRIPTION = [
  'Send a message from this session to the agent of another DSH session on the same host.',
  '',
  'The receiver sees a user message that starts with "From <sender session id> ：", then the text.',
  'If a user message starts with that header it came from another session, not from the human: answer with this tool using that session id. The plugin always prepends the real header of the sender.',
  '',
  '`urgent` picks delivery: false (default) = in order, after the current turn of the target ends; true = interject into the turn that is running now.',
  'Corrections, retractions and changed conclusions MUST use urgent:true — the other side is probably already acting on what you said. Test: does this message make an earlier one wrong?',
  '',
  'Boundaries: answer only when asked or when the sender asked for a reply; stop after two or three exchanges and take the conclusion back to the human; keep urgent for corrections and interrupting; do not write a From header yourself (rejected); you cannot mail your own session (rejected); do not queue several messages before the other side answers.',
  '',
  'Ids: every message carries a [mail m-xxxxxxxx …] line. Quote that id back in replyTo when answering, pass it in supersedes to kill an earlier still-pending message, and reuse the same thread name to avoid queueing the same task twice.',
  '',
  'Same host only; delivery across app instances is refused.',
].join('\n');

const PARAMETERS = {
  type: 'object',
  properties: {
    toSessionId: {
      type: 'string',
      description: 'Target session id (session-<32 hex>). When answering, use the id from the From header.',
    },
    message: {
      type: 'string',
      description: 'What to say. The plugin prepends the From header of the sender.',
    },
    urgent: {
      type: 'boolean',
      description:
        'false (default) = in order, after the current turn of the target; true = interject into the turn running now. ' +
        'Corrections, retractions and changed conclusions MUST use true.',
    },
    replyTo: {
      type: 'string',
      description: 'Optional: the id of the message you are answering (m-xxxxxxxx, from its [mail …] line).',
    },
    thread: {
      type: 'string',
      description:
        'Optional: short task name. While a message with the same thread is still pending for that session, ' +
        'a second one is skipped instead of queued twice.',
    },
    supersedes: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional: ids of earlier messages to the same session that are no longer valid. ' +
        'Still-pending ones are removed before this message is queued; already-delivered ones cannot be recalled.',
    },
  },
  required: ['toSessionId', 'message'],
  additionalProperties: false,
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    delivered: { type: 'boolean' },
    toSessionId: { type: 'string' },
    mode: { type: 'string', enum: ['queue', 'steer'] },
    body: { type: 'string' },
    msgId: { type: 'string' },
    skipped: { type: 'boolean' },
    dedupe: { type: 'string' },
    prior: { type: 'string' },
    superseded: { type: 'array', items: { type: 'string' } },
    notRecalled: { type: 'array', items: { type: 'string' } },
  },
  required: ['delivered', 'toSessionId'],
  additionalProperties: false,
};

/**
 * The Session id of the agent that called the tool.
 *
 * @param exec - the tool execution context.
 * @returns the calling Session id.
 */
function callingSessionId(exec) {
  const agent = exec?.agent;
  const id = agent?.session?.id ?? agent?.id;
  if (typeof id !== 'string' || id === '') {
    throw new Error('dsh-session-mail: the calling session id is unknown; this tool only works inside an agent turn');
  }
  return id;
}

/**
 * The host's browser-session signing secret.
 *
 * @param ctx - plugin context.
 * @returns the base64url secret.
 */
async function signingSecret(ctx) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined) throw new Error('dsh-session-mail: the credentials service is not mounted');
  const record = await credentials.readRecord(CREDENTIAL_KEY);
  const secret = record?.payload?.secret;
  if (typeof secret !== 'string' || secret === '') {
    throw new Error(`dsh-session-mail: the credential record "${CREDENTIAL_KEY}" is not configured`);
  }
  return secret;
}


/** Model-facing tool name for reading another session. */
export const READ_TOOL_NAME = 'read_session_info';

const READ_DESCRIPTION = [
  'Read the title of another DSH session and what it last said.',
  '',
  '`what` picks the fields: `title` (the session title), `last_reply` (the final assistant message of the last completed turn), `last_present` (the last `present` tool call of the session: the files it declared as deliverables plus their descriptions), `status` (busy, queue depth, last inbound/outbound of this mail), or `all` (default).',
  '',
  'Reads only: the target session is not resumed and nothing is delivered to it.',
].join('\n');

const READ_PARAMETERS = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: 'Target session id (session-<32 hex>).' },
    what: {
      type: 'string',
      enum: ['title', 'last_reply', 'last_present', 'status', 'all'],
      description: 'Which field to fetch. Default all.',
    },
  },
  required: ['sessionId'],
  additionalProperties: false,
};

const READ_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    sessionId: { type: 'string' },
    title: { type: 'string' },
    lastReply: { type: 'string' },
    lastPresent: {
      type: 'object',
      properties: {
        when: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, description: { type: 'string' } },
            required: ['path', 'description'],
            additionalProperties: false,
          },
        },
      },
      required: ['when', 'files'],
      additionalProperties: false,
    },
    status: {
      type: 'object',
      properties: {
        busy: { type: 'boolean' },
        lastEvent: { type: 'string' },
        queuedNextTurn: { type: 'integer' },
        queuedNextStep: { type: 'integer' },
        lastInbound: { type: 'string' },
        lastOutbound: { type: 'string' },
      },
      required: ['busy'],
      additionalProperties: false,
    },
  },
  required: ['sessionId'],
  additionalProperties: false,
};

/** The last non-empty turn response in a turn outline. */
function pickLastReply(outline) {
  if (!Array.isArray(outline)) return null;
  for (let i = outline.length - 1; i >= 0; i -= 1) {
    const text = outline[i]?.response;
    if (typeof text === 'string' && text.trim() !== '') return text;
  }
  return null;
}

/** Turn one `present` tool-call event into the shape the tool returns. */
function readPresentEvent(event) {
  const raw = event?.data?.arguments;
  if (typeof raw !== 'string') return null;
  let args;
  try {
    args = JSON.parse(raw);
  } catch {
    return null;
  }
  const files = Array.isArray(args?.files) ? args.files : [];
  return {
    when: typeof event?.time === 'number' ? new Date(event.time).toISOString() : '',
    files: files.map((file) => ({
      path: String(file?.path ?? ''),
      description: String(file?.description ?? ''),
    })),
  };
}

/**
 * The first text block of a delivered event.
 *
 * @param event - one session event.
 * @returns its text, or the empty string.
 */
function eventText(event) {
  const content = Array.isArray(event?.data?.content) ? event.data.content : [];
  const first = content.find((part) => part?.type === 'text');
  return typeof first?.text === 'string' ? first.text : '';
}

/**
 * Page backwards through a session until its last `present` call is found.
 *
 * `session/page` is the cold-safe history route: it works for a session that
 * is not running and returns the raw events, tool calls included.
 */
async function findLastPresent(call, { sessionId, throughSeq, maxPages = 6, maxMessages = 20 }) {
  let beforeSeq;
  for (let page = 0; page < maxPages; page += 1) {
    const value = await call({
      method: 'session/page',
      args: {
        request: {
          address: { kind: 'session', sessionId },
          throughSeq,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          maxMessages,
        },
      },
    });
    const records = Array.isArray(value?.records) ? value.records : [];
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const event = records[i]?.event;
      if (event?.type === 'tool/call' && event.data?.name === 'present') return readPresentEvent(event);
    }
    const seqs = records.map((record) => record?.event?.seq).filter((seq) => typeof seq === 'number');
    if (value?.hasMore !== true || seqs.length === 0) return null;
    beforeSeq = Math.min(...seqs);
  }
  return null;
}


/** Messages this process sent, by id, so a later call can recall them. */
const SENT = new Map();

/** Every pending queue item of a session, next-turn and next-step alike. */
function pendingItems(inbox) {
  const items = [];
  for (const bucket of ['next-turn', 'next-step']) {
    const list = Array.isArray(inbox?.[bucket]) ? inbox[bucket] : [];
    for (const item of list) items.push({ bucket, item });
  }
  return items;
}

/** The first text block of one queue item. */
function itemText(item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  const first = content.find((part) => part?.type === 'text');
  return typeof first?.text === 'string' ? first.text : '';
}

/** The pending item whose body is exactly `body`, if it is still queued. */
function findPendingByBody(inbox, body) {
  return pendingItems(inbox).find(({ item }) => itemText(item) === body) ?? null;
}

/** The pending item whose body carries `thread`, if one is still queued. */
function findPendingByThread(inbox, thread) {
  const marker = `· thread ${thread}`;
  return pendingItems(inbox).find(({ item }) => itemText(item).includes(marker)) ?? null;
}

/** Drop one pending queue item from the target session. */
async function removeQueued(call, sessionId, itemId) {
  await call({
    method: 'session/updateQueue',
    args: { request: { sessionId, itemId, action: { kind: 'remove' } } },
  });
}

/** The `[mail m-xxxxxxxx …]` id of a message body, if it has one. */
function mailIdOf(text) {
  const match = /\[mail (m-[0-9a-f]{8})/u.exec(String(text ?? ''));
  return match === null ? null : match[1];
}

/**
 * Busy state, queue depth and the last mail each way for one session.
 *
 * `session/page` is the only cold-safe way to see the tail events: the log
 * file is multi-frame zstd and the Node zstd API decodes just the first frame.
 */
async function readStatus(call, sessionId, projections) {
  const inbox = projections?.values?.inbox ?? null;
  const page =
    typeof projections?.asOfSeq === 'number'
      ? await call({
          method: 'session/page',
          args: {
            request: { address: { kind: 'session', sessionId }, throughSeq: projections.asOfSeq, maxMessages: 6 },
          },
        })
      : null;
  const events = (Array.isArray(page?.records) ? page.records : [])
    .map((record) => record?.event)
    .filter((event) => event !== undefined);
  const last = events.length === 0 ? null : events[events.length - 1];
  const status = {
    busy: last !== null && last.type !== 'turn/end',
    lastEvent: last === null ? '' : String(last.type),
    queuedNextTurn: Array.isArray(inbox?.['next-turn']) ? inbox['next-turn'].length : 0,
    queuedNextStep: Array.isArray(inbox?.['next-step']) ? inbox['next-step'].length : 0,
  };
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== 'user/message') continue;
    const text = eventText(event);
    if (!text.startsWith('From session-')) continue;
    const header = text.split('\n')[0];
    status.lastInbound = `${mailIdOf(text) ?? '?'} ${header.slice(5).trim()}`;
    break;
  }
  const mine = [...SENT.values()].filter((entry) => entry.toSessionId === sessionId).at(-1);
  if (mine !== undefined) status.lastOutbound = `${mine.msgId} at ${new Date(mine.at).toISOString()}`;
  return { sessionId, status };
}

/**
 * Mount the plugin.
 *
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 */
export function apply(ctx, config) {
  const settings = {
    enabled: config?.enabled !== false,
    baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl : '',
  };
  if (!settings.enabled) return;

  ctx.inject(['tools'], (toolsCtx) => {
    const disposer = toolsCtx.tools.register({
      name: TOOL_NAME,
      description: DESCRIPTION,
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render(args, value) {
          if (value.skipped === true) {
            return [{ type: 'text', text: `Skipped: a message with thread ${args.thread} is already pending for ${value.toSessionId} (${value.prior})` }];
          }
          const how = value.mode === 'steer' ? 'interjected' : 'queued';
          const recalled = value.superseded === undefined ? '' : ` — recalled ${value.superseded.join(', ')}`;
          return [{ type: 'text', text: `Sent to ${value.toSessionId} (${how}, ${value.msgId})${recalled}:\n${value.body}` }];
        },
      },
      async execute(args, exec) {
        const senderId = callingSessionId(exec);
        const toSessionId = String(args.toSessionId ?? '').trim();
        if (toSessionId === '') throw new Error('dsh-session-mail: toSessionId is required');
        // Boundary rules, enforced rather than only documented: a session that
        // could mail itself would answer its own message forever, and a body
        // that already carries a From header is either a forgery or a
        // forwarding loop waiting to happen.
        if (toSessionId === senderId) {
          throw new Error('dsh-session-mail: 不能发给自己（会形成自问自答的循环）');
        }
        const text = String(args.message ?? '');
        if (FROM_HEADER.test(text)) {
          throw new Error(
            'dsh-session-mail: 正文里不能带「From session-<id> ：」抬头 —— 插件会自动加你的真实抬头；' +
              '正文再写一条会伪造来源，也会让转发变成无限循环',
          );
        }
        const replyTo = String(args.replyTo ?? '').trim();
        const thread = String(args.thread ?? '').trim();
        const supersedes = Array.isArray(args.supersedes)
          ? args.supersedes.map((id) => String(id).trim()).filter((id) => id !== '')
          : [];
        const baseUrl = resolveBaseUrl(settings.baseUrl, ctx.get('webServer'));
        const secret = await signingSecret(ctx);
        const cookie = mintCookie(secret, new URL(baseUrl).host);
        const call = (options) => callRpc({ baseUrl, cookie, ...options });

        // One projections read answers both questions below: is a same-thread
        // message still pending, and where are the messages this call replaces?
        let inbox = null;
        if (thread !== '' || supersedes.length > 0) {
          const projections = await call({
            method: 'session/projections',
            args: { request: { sessionId: toSessionId } },
          });
          inbox = projections?.values?.inbox ?? null;
        }

        if (thread !== '') {
          const pending = findPendingByThread(inbox, thread);
          if (pending !== null) {
            // The same task is already queued for that session; queueing it
            // again is the duplicate the peer complained about.
            return {
              delivered: false,
              skipped: true,
              toSessionId,
              dedupe: 'pending-thread',
              prior: mailIdOf(itemText(pending.item)) ?? '',
            };
          }
        }

        // Only still-pending messages can be recalled: the host has no way to
        // rewrite a message that already landed.
        const superseded = [];
        const notRecalled = [];
        for (const id of supersedes) {
          const previous = SENT.get(id);
          const pending = previous === undefined ? null : findPendingByBody(inbox, previous.body);
          if (previous === undefined || pending === null) {
            notRecalled.push(id);
            continue;
          }
          await removeQueued(call, toSessionId, pending.item.id);
          superseded.push(id);
        }

        const msgId = newMailId();
        const body = formatMessage(senderId, text, { msgId, replyTo, thread });
        const mode = args.urgent === true ? 'steer' : 'queue';
        // The host records the delivered message with `source.kind === 'user'`,
        // exactly like a human's input — on the event itself the two cannot be
        // told apart. The `From` prefix is what the model reads; this marker
        // is what a program reads: the landing event carries
        // `data.source.rpcId`, so a prefixed id tells a delivered message from
        // a typed one without touching the host.
        const requestId = `${MODE_MARKER}:${randomUUID()}`;
        await deliver({ baseUrl, cookie, sessionId: toSessionId, body, mode, requestId });
        SENT.set(msgId, { msgId, toSessionId, thread, replyTo, body, requestId, at: Date.now() });
        const answer = { delivered: true, toSessionId, mode, body, msgId };
        if (superseded.length > 0) answer.superseded = superseded;
        if (notRecalled.length > 0) answer.notRecalled = notRecalled;
        return answer;
      },
    });
    toolsCtx.effect(() => disposer, 'dsh-session-mail: send_session_message');
    const readDisposer = toolsCtx.tools.register({
      name: READ_TOOL_NAME,
      description: READ_DESCRIPTION,
      parameters: READ_PARAMETERS,
      output: {
        schema: READ_OUTPUT_SCHEMA,
        render(args, value) {
          const parts = [];
          if (value.title != null) parts.push(`Title: ${value.title}`);
          if (value.lastReply != null) parts.push(`Last reply:\n${value.lastReply}`);
          if (value.lastPresent != null) {
            const files = value.lastPresent.files
              .map((file) => `- ${file.path}${file.description === '' ? '' : ` — ${file.description}`}`)
              .join('\n');
            parts.push(`Last present (${value.lastPresent.when}):\n${files}`);
          }
          if (value.status != null) {
            const state = value.status;
            const lines = [
              `Status: ${state.busy === true ? 'busy' : 'idle'} (last event: ${state.lastEvent === '' ? '?' : state.lastEvent})`,
              `Queued: ${state.queuedNextTurn} next-turn, ${state.queuedNextStep} next-step`,
            ];
            if (state.lastInbound !== undefined) lines.push(`Last inbound: ${state.lastInbound}`);
            if (state.lastOutbound !== undefined) lines.push(`Last outbound: ${state.lastOutbound}`);
            parts.push(lines.join('\n'));
          }
          return [{ type: 'text', text: parts.join('\n\n') || '(nothing to report)' }];
        },
      },
      async execute(args) {
        const sessionId = String(args.sessionId ?? '').trim();
        if (sessionId === '') throw new Error('dsh-session-mail: sessionId is required');
        const what = ['title', 'last_reply', 'last_present', 'status', 'all'].includes(args.what) ? args.what : 'all';
        const baseUrl = resolveBaseUrl(settings.baseUrl, ctx.get('webServer'));
        const secret = await signingSecret(ctx);
        const cookie = mintCookie(secret, new URL(baseUrl).host);
        const call = (options) => callRpc({ baseUrl, cookie, ...options });
        const projections = await call({ method: 'session/projections', args: { request: { sessionId } } });
        const values = projections?.values ?? {};
        // The host accepts only single-type schema nodes (no `type: ['string','null']`),
        // so a field that has nothing to report is left out instead of set to null.
        const answer = { sessionId };
        if (what === 'title' || what === 'all') {
          if (typeof values.title === 'string' && values.title !== '') answer.title = values.title;
        }
        if (what === 'last_reply' || what === 'all') {
          const reply = pickLastReply(values.turnOutline);
          if (reply !== null) answer.lastReply = reply;
        }
        if (what === 'status') {
          return readStatus(call, sessionId, projections);
        }
        if (what === 'last_present' || what === 'all') {
          const present =
            typeof projections?.asOfSeq === 'number'
              ? await findLastPresent(call, { sessionId, throughSeq: projections.asOfSeq })
              : null;
          if (present !== null) answer.lastPresent = present;
        }
        return answer;
      },
    });
    toolsCtx.effect(() => readDisposer, 'dsh-session-mail: read_session_info');
  });
}
