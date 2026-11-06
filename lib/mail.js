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
  const { controller, sessionId, body, requestId = randomUUID(), mode = 'queue' } = options;
  if (!MODES.includes(mode)) throw new Error(`dsh-session-mail: unknown delivery mode "${mode}"`);
  if (controller === undefined || typeof controller.prompt !== 'function') {
    throw new Error('dsh-session-mail: the sessionController service is not available');
  }
  // The service builds the recorded source itself — `{kind:'user', rpcId: request.requestId}`
  // — so the dsh-session-mail marker still lands in `data.source.rpcId`, and the
  // second parameter is a cancellation signal, not the source.
  const request = {
    sessionId,
    requestId,
    mode: mode === 'steer' ? 'steer' : 'queue',
    content: [{ type: 'text', text: body }],
  };
  const value = await controller.prompt(request, new AbortController().signal);
  return { ok: true, value };
}

/**
 * Call one method of the host's `sessionController` service in-process.
 *
 * The plugin runs inside the host, so there is no Web route to authenticate
 * against: the service object is handed to the plugin context and its methods
 * are the same ones the RPC layer calls.
 *
 * @param options - call options.
 * @param options.controller - the `sessionController` service.
 * @param options.method - service method name, e.g. `projections`.
 * @param options.request - the request object the method expects.
 * @returns the method's own return value.
 */
export async function callHost(options) {
  const { controller, method, request } = options;
  if (controller === undefined || controller === null) {
    throw new Error('dsh-session-mail: the sessionController service is not available');
  }
  const fn = controller[method];
  if (typeof fn !== 'function') {
    throw new Error(`dsh-session-mail: sessionController.${method} is not available on this host build`);
  }
  return fn.call(controller, request);
}

/**
 * Read one page of Session history.
 *
 * `page` is deprecated in favour of `events`; both answer with the same page,
 * and `events` accepts a request without `throughSeq` (the observed log end).
 *
 * @param controller - the `sessionController` service.
 * @param request - durable address, cursor and page budget.
 * @returns one chronological page.
 */
export function historyPage(controller, request) {
  const fn = typeof controller?.events === 'function' ? controller.events : controller?.page;
  if (typeof fn !== 'function') {
    throw new Error('dsh-session-mail: sessionController exposes neither events nor page');
  }
  // The controller's read methods take (request, signal) and dereference the
  // signal, so always hand them one.
  return fn.call(controller, request, new AbortController().signal);
}
