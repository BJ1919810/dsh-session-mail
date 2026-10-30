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
import { CREDENTIAL_KEY, deliver, formatMessage, mintCookie, resolveBaseUrl } from './mail.js';

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
  },
  required: ['delivered', 'toSessionId', 'mode', 'body'],
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
          const how = value.mode === 'steer' ? 'interjected' : 'queued';
          return [{ type: 'text', text: `Sent to ${value.toSessionId} (${how}):\n${value.body}` }];
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
        const body = formatMessage(senderId, text);
        const mode = args.urgent === true ? 'steer' : 'queue';
        const baseUrl = resolveBaseUrl(settings.baseUrl, ctx.get('webServer'));
        const secret = await signingSecret(ctx);
        const cookie = mintCookie(secret, new URL(baseUrl).host);
        // The host records the delivered message with `source.kind === 'user'`,
        // exactly like a human's input — on the event itself the two cannot be
        // told apart. The `From` prefix is what the model reads; this marker
        // is what a program reads: the landing event carries
        // `data.source.rpcId`, so a prefixed id tells a delivered message from
        // a typed one without touching the host.
        const requestId = `${MODE_MARKER}:${randomUUID()}`;
        await deliver({ baseUrl, cookie, sessionId: toSessionId, body, mode, requestId });
        return { delivered: true, toSessionId, mode, body };
      },
    });
    toolsCtx.effect(() => disposer, 'dsh-session-mail: send_session_message');
  });
}
