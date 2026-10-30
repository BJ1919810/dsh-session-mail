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
  '给同一台 DSH 里的另一个会话发消息（会话对讲）。',
  '',
  '收信方会收到这样一段文字：',
  'From <发信方的 sessionID> ：',
  '<要说的话>',
  '',
  '如果你收到的用户消息以「From <sessionID> ：」开头，那是**另一个会话里的代理**发来的（不是主人），',
  '要回话就把那个 sessionID 填进 toSessionId，message 写你要说的话。',
  '投递时插件会自动加上你自己的 From 抬头，格式与收到时完全一致。',
  '',
  'urgent 决定送达方式：false（默认）＝顺序发送，等对方当前回合结束再进；true＝插话，立刻打断对方当前回合。',
  '',
  '⛔ **更正、撤回、改变结论**这类消息**必须用 urgent:true**：对方很可能正按你上一条的指示在做事，',
  '顺序发送会让他把错的做完、烧完 token 才看到更正 —— 那是在欺负老实人。',
  '判据：这条消息是否让「对方已经收到的那条」失效？是 ⇒ urgent:true。',
  '',
  '边界规则（防套娃、防伪造）：',
  '- 只有需要对方行动、或对方明确要求回信时才回；收到的是回信就别自动再回。',
  '- 一轮对话最多两三个来回，需要更多就把结论交回主人。',
  '- 普通回信、补充说明、闲聊都用默认的 false；urgent 留给「更正/撤回」和「必须立刻打断」两种情况。',
  '- 正文里不要自己写 From 抬头（插件会加）；正文里出现 From 抬头会被直接拒绝。',
  '- 不能发给自己（toSessionId 等于你自己的 sessionID 会被拒绝）。',
  '- 对方没回之前别连着发多条，消息会堆在对方的排队队列里。',
  '',
  '注意：目标会话必须和本会话在同一个 DSH 宿主里；跨应用投递不通。',
].join('\n');

const PARAMETERS = {
  type: 'object',
  properties: {
    toSessionId: {
      type: 'string',
      description: '目标会话 id，形如 session-<32 位十六进制>。回信时填收到的 From 抬头里的那个 id。',
    },
    message: {
      type: 'string',
      description: '要说的话（正文）。插件会自动加上「From <我的 sessionID> ：」抬头。',
    },
    urgent: {
      type: 'boolean',
      description:
        'true＝插话发送（立刻插进对方正在跑的回合）；false（默认）＝顺序发送（等对方当前回合结束再送达）。' +
        '更正/撤回/改变结论时必须用 true：否则对方会先把错的指示做完。',
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
          const how = value.mode === 'steer' ? '插话' : '顺序';
          return [{ type: 'text', text: `已发给 ${value.toSessionId}（${how}）：\n${value.body}` }];
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
