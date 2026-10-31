/**
 * Mail delivery between DSH sessions.
 *
 * Everything here is deliberately transport-shaped and side-effect free except
 * `deliver`, so the pieces can be unit-tested without a host and reused by
 * the tool implementation in `lib/index.js`.
 *
 * The host exposes one RPC method for admitting a prompt into a Session:
 * `POST /api/session/prompt`. That route is what the GUI itself uses, so a
 * message sent this way is admitted exactly like a message typed by a human:
 * the Session is resumed with its own agent preset, the next model request
 * uses the Session's recorded model, and the prompt lands in the Session's
 * durable log.
 *
 * Authentication is the browser-session cookie the host signs itself:
 *   name  = `dsh-auth-` + base64url(sha256(authority))
 *   value = `v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>`
 *   payload = { version: 1, authority: "host:port", issuedAt, expiresAt }
 * The secret lives in the credential record `client-connection/browser-session`
 * and must be base64url-decoded to bytes before it is used as the HMAC key.
 *
 * ## Replying without the tool
 *
 * There is a window between "a message arrives" and "the plugin is mounted":
 * during it the receiving session can receive but has no way to answer. The
 * test is one line — does the tool table contain `send_session_message`? If
 * not, the receiver can call the same route by hand:
 *
 *   node <DSH_HOME>/tools/dsh-api.mjs --method session/prompt --payload-file payload.json
 *   {"request":{"requestId":"<uuid>","sessionId":"<target>","mode":"queue",
 *               "content":[{"type":"text","text":"From <your session id> ：\n<text>"}]}}
 *
 * The `From` header is not added for you there, so write it yourself.
 *
 * ## What the receiver sees, and what counts as proof
 *
 * The host records a delivered message as an ordinary user message: the
 * event's `source.kind` is `'user'`, exactly as it is for a human's input, so
 * on the event itself the two cannot be told apart. The `From <session id> ：`
 * prefix is the only marker that says "another agent sent this".
 *
 * Landing evidence is therefore the message event — `type === 'user/message'`
 * whose `data.content[0].text` starts with `From session-` — and not the
 * sender's `tool/call` / `tool/result`, which only say that the tool fired.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const SECRET_BYTES = 32;
const COOKIE_PREFIX = 'dsh-auth-';
export const CREDENTIAL_KEY = 'client-connection/browser-session';

/**
 * The one message format both sides agree on.
 *
 * The recipient reads the first line as the sender's identity: it is the
 * sending Session's id, so the recipient can answer with the same tool.
 *
 * @param senderId - sending Session id.
 * @param text - what the sender wants to say.
 * @returns the message body as delivered.
 */
/** Mint a short message id, e.g. `m-1a2b3c4d`. */
export function newMailId() {
  return `m-${randomUUID().slice(0, 8)}`;
}

/**
 * The metadata line that follows the From header.
 *
 * It is how a receiver learns the id it must quote back with `replyTo`, and
 * how a sender finds its own still-pending messages later.
 *
 * @param meta - message metadata.
 * @returns the bracket line, or an empty string when there is no id.
 */
export function formatMetaLine(meta) {
  const id = meta?.msgId === undefined ? '' : String(meta.msgId).trim();
  if (id === '') return '';
  const bits = [`[mail ${id}`];
  if (meta?.thread !== undefined && String(meta.thread).trim() !== '') bits.push(`· thread ${String(meta.thread).trim()}`);
  if (meta?.replyTo !== undefined && String(meta.replyTo).trim() !== '') bits.push(`· reply ${String(meta.replyTo).trim()}`);
  return `${bits.join(' ')}]`;
}

/**
 * The exact text a session receives.
 *
 * @param senderId - the calling session id.
 * @param text - what the sender wants to say.
 * @param meta - optional message id / thread / reply target.
 * @returns the message body as delivered.
 */
export function formatMessage(senderId, text, meta = {}) {
  const sender = String(senderId ?? '').trim();
  const body = String(text ?? '').trim();
  if (sender === '') throw new Error('dsh-session-mail: sender session id is required');
  if (body === '') throw new Error('dsh-session-mail: message text is required');
  const marker = formatMetaLine(meta);
  const parts = [`From ${sender} ：`];
  if (marker !== '') parts.push(marker);
  parts.push(body);
  return parts.join('\n');
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value) {
  const text = String(value);
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) throw new Error('dsh-session-mail: secret is not base64url');
  const padding = '='.repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64');
}

/**
 * Mint the browser-session cookie the host expects on `/api` requests.
 *
 * @param secretBase64Url - base64url signing secret from the credential record.
 * @param authority - request authority, `host:port`.
 * @param now - current time in epoch milliseconds.
 * @returns the `name=value` cookie header value.
 */
export function mintCookie(secretBase64Url, authority, now = Date.now()) {
  const secret = decodeBase64Url(secretBase64Url);
  if (secret.byteLength !== SECRET_BYTES) {
    throw new Error(`dsh-session-mail: browser-session secret is ${secret.byteLength} bytes, expected ${SECRET_BYTES}`);
  }
  const issuedAt = now;
  // One day below the host's own 30-day ceiling, so the cookie stays valid
  // even when the host was configured with a shorter lifetime.
  const expiresAt = issuedAt + 29 * DAY_MILLISECONDS;
  const body = encodeBase64Url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }));
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest());
  const name = `${COOKIE_PREFIX}${encodeBase64Url(createHash('sha256').update(authority).digest())}`;
  return `${name}=v1.${body}.${signature}`;
}

/**
 * The base URL of the host's own web server.
 *
 * @param configured - explicit base URL from the plugin configuration.
 * @param server - the host's `webServer` service.
 * @returns the base URL without a trailing slash.
 */
export function resolveBaseUrl(configured, server) {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit !== '') return explicit.replace(/\/+$/u, '');
  if (server === undefined || server === null) {
    throw new Error('dsh-session-mail: no web server is mounted; set the baseUrl option');
  }
  const scheme = server.protocol === 'https:' ? 'https' : 'http';
  let host = typeof server.host === 'string' && server.host !== '' ? server.host : '127.0.0.1';
  // A wildcard bind address is not a usable destination, but it is a valid
  // authority for the host fence — the cookie audience follows the URL, so
  // both sides agree on the loopback spelling.
  if (host === '0.0.0.0' || host === '::' || host === '[::]') host = '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
  if (typeof server.port !== 'number') throw new Error('dsh-session-mail: web server port is unknown');
  return `${scheme}://${host}:${server.port}`;
}

/**
 * Delivery modes of the host's prompt route.
 *
 * `queue` — the message waits for the target session's current turn to end
 * and is delivered afterwards, in order.
 * `steer` — the message is injected into the target session's running turn
 * right away, interrupting whatever it was doing.
 */
export const MODES = ['queue', 'steer'];

/**
 * Admit one prompt into another Session of this host.
 *
 * @param options - delivery options.
 * @param options.baseUrl - host base URL.
 * @param options.cookie - minted cookie header value.
 * @param options.sessionId - receiving Session id.
 * @param options.body - message body, already formatted.
 * @param options.requestId - client-minted identity of this message.
 * @param options.mode - `queue` (in order) or `steer` (interrupt).
 * @param options.fetchImpl - fetch implementation (tests inject a stub).
 * @returns the host's answer envelope.
 */
export async function deliver(options) {
  const { baseUrl, cookie, sessionId, body, requestId = randomUUID(), mode = 'queue', fetchImpl = fetch } = options;
  if (!MODES.includes(mode)) throw new Error(`dsh-session-mail: unknown delivery mode "${mode}"`);
  const rpcId = randomUUID();
  const envelope = {
    type: 'client-request',
    rpcId,
    method: 'session/prompt',
    payload: {
      args: {
        request: {
          requestId,
          sessionId,
          mode,
          content: [{ type: 'text', text: body }],
        },
      },
    },
  };
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, '')}/api/session/prompt`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify(envelope),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`dsh-session-mail: host answer is not JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  const result = parsed?.result;
  if (result?.ok === true) return { ok: true, value: result.value, rpcId };
  const error = result?.error;
  throw new Error(`dsh-session-mail: host refused the message (HTTP ${response.status}): ${error?.code ?? 'unknown'} ${error?.message ?? text.slice(0, 200)}`);
}

/**
 * Call one host RPC method over the same loopback route the delivery uses.
 *
 * The plugin speaks to `sessionController` and friends through exactly the
 * route the GUI uses: a `client-request` envelope posted to `/api/<method>`,
 * answered with `{ type: "server-response", result: { ok, value | error } }`.
 *
 * @param options - call options.
 * @param options.baseUrl - host base URL.
 * @param options.cookie - minted cookie header value.
 * @param options.method - RPC method name, e.g. `session/projections`.
 * @param options.args - the `args` object of the envelope payload.
 * @param options.fetchImpl - fetch implementation (tests inject a stub).
 * @returns the `value` of a successful answer.
 */
export async function callRpc(options) {
  const { baseUrl, cookie, method, args, fetchImpl = fetch } = options;
  const rpcId = randomUUID();
  const envelope = { type: 'client-request', rpcId, method, payload: { args } };
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, '')}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(envelope),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`dsh-session-mail: ${method} answer is not JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  const result = parsed?.result;
  if (result?.ok === true) return result.value;
  const error = result?.error;
  throw new Error(
    `dsh-session-mail: ${method} failed (HTTP ${response.status}): ${error?.code ?? 'unknown'} ${error?.message ?? text.slice(0, 200)}`,
  );
}
