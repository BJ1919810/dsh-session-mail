# dsh-session-mail

Send a message from the agent in one DSH session to the agent in another session of the same host.

The delivery is one-way. To answer, the receiving agent calls the same tool once more, addressing the sender by the session id that arrived in the message header.

## What the receiver sees

Every message this plugin delivers has the same two-part shape:

```
From <sender session id> ：
<what the sender says>
```

The first line carries the sender's session id, so the receiving agent knows the message came from another agent (not from the human) and knows where to answer. The receiving side needs no extra machinery: the message arrives as an ordinary prompt in the target session, and the tool description tells the model what the `From` header means.

## The tool

`send_session_message`

| argument | type | meaning |
| --- | --- | --- |
| `toSessionId` | string | Target session id (`session-<32 hex>`). When answering, use the id from the `From` header. |
| `message` | string | The text to say. The plugin prepends the `From` header. |
| `urgent` | boolean | `false` (default) — send in order: the message waits for the target's current turn to end. `true` — interject: the message is injected into the target's running turn right away. |

## Queue or interject: `urgent`

`urgent` picks how the message is handed to the target session:

| `urgent` | host mode | inbox target | when it lands |
| --- | --- | --- | --- |
| `false` (default) | `queue` | `next-turn` | after the target's current turn ends — it becomes the first step of the next turn |
| `true` | `steer` | `next-step` | at the next step of the target's *current* turn |

Measured 2026-10-29 against a live peer session, four cases:

| peer state | inbox target | landing |
| --- | --- | --- |
| busy, one long turn | `next-turn` (queue) | 21 s later, first step of the *following* turn — after the whole running turn |
| idle | `next-step` (steer) | a new turn started immediately |
| running a 90 s foreground command | `next-step` (steer) | after that command returned — still inside the same turn |
| running a background job plus 5-second steps | `next-step` (steer) | **4.0 s** later, in the next step of the *same* turn, while the background job still had ~49 s to run |

The rule behind those numbers: **a steer takes effect at the next step boundary, and the delay is roughly the remaining time of the tool call the current step is executing.** It never waits for the turn to end, but it cannot preempt a tool call that is already running — a foreground command blocks the step, while a background job does not block the turn at all.

The host also downgrades a steer to a queue in one case: if the agent's current turn was already aborted, the message goes to `next-turn` instead (`send()` resolves the target to `next-turn` when the abort signal is set).

**When to pick which** — a correction has to travel on the interrupting channel:

- **`urgent: true`** — a message that *invalidates something the recipient already received*: a correction, a retraction, a changed conclusion. Queued, it would land only after the recipient has finished acting on the wrong instruction and burned the tokens for it.
- **`urgent: false`** (default) — a reply, a clarification, a new request that does not contradict an earlier one.

The test is one line: does this message make an earlier one wrong? If yes, it is `urgent: true`.

## The switch

The plugin is listed in **Settings → Plugins** as `dsh-session-mail` and can be switched off there. Toggling applies on the live profile without a restart: the entry goes to `enabled: false` (the plugin unmounts, the tool disappears from every tool table) and back to `enabled: true` (the tool is registered again).

Switching it off is the same thing as removing the tool: a session that is already running keeps its turn, it just cannot send anything afterwards.

## Verifying a delivery

The host records a delivered message as an ordinary user message, so the evidence of a landing is the message event itself — not the tool call:

```
type === 'user/message'  &&  data.content[0].text.startsWith('From session-')
```

`tool/call` and `tool/result` only say that the *sender* fired the tool; the landing is the `user/message` that follows.

## Telling a delivered message from a typed one

The host records a delivered message with `data.source.kind === 'user'` — exactly what a human's input gets. On the event itself the two cannot be told apart, so there are two markers instead:

- **For a reader (human or model):** the `From <session id> ：` prefix in the body. The tool description tells the receiving model what that prefix means, so it knows the message came from another agent and where to answer.
- **For a program (logs, tooling):** `data.source.rpcId`. The plugin mints its request id as `dsh-session-mail:<uuid>`, so the landing event carries a request id that no human input ever has:

```json
{"type":"user/message","data":{"source":{"kind":"user","rpcId":"dsh-session-mail:01234567-89ab-cdef-0123-456789abcdef"}}}
```

A judge that needs the distinction reads `data.source.rpcId.startsWith('dsh-session-mail:')`. Nothing in the host has to change for this — the request id is the client's to choose.

The envelope's correlation id is **not** touched: `rpcId` in the `client-request` envelope stays a plain UUID (it only pairs the request with its response), while the marker rides on the inner `request.requestId` — whose documented meaning is exactly "client-minted identity persisted on the exact accepted user message". The host copies that field into `data.source.rpcId` when the message lands, which is why the marker shows up there.

Re-sending the same `request.requestId` is safe: the host answers `{accepted: true}` from its own record and does not deliver a second message (measured 2026-10-29 — two identical calls, one splice, one landing).

The dedup scan, read from the host source: `hasPromptRequest` looks at the pending inbox (`nextTurn` + `nextStep`) and then at **the session's append-only event log** (`session.snapshotEvents()`, documented as the cached immutable full snapshot of the private append-only log). The log is never truncated — folding and compaction only *append* events carrying surface metadata — so a message that has been folded out of the visible surface still counts. The practical window is the lifetime of the session itself: delete the session and its record goes with it.

One thing to watch on upgrades: `snapshotEvents()` is marked deprecated in the host ("new calls are prohibited", pending a switch to asynchronous session reads). If that read path changes to a visible-surface view, the dedup would become narrower. Send one self-check message after a DSH upgrade and confirm it lands.

What would need a host change: a distinct role or a `source.kind` of its own, so the message would not be a user message at all. The `session/prompt` route always builds a user message and its parameter schema has no source field, so that is a change in DSH itself, not in this plugin.

## Semantic boundaries

The plugin is a one-way mail slot: it hands one message over and forgets it. That makes loops a convention problem more than a plumbing one, so the rules are stated in the tool description and enforced where enforcement is possible.

**Enforced by the plugin** (2026-10-29, both verified live):

- a session cannot mail itself — `toSessionId === <your own id>` is rejected ("不能发给自己（会形成自问自答的循环）"). That is the tightest possible loop.
- a body cannot carry a `From session-<id> ：` header — rejected. It is either a forged identity or a forwarded message that would bounce forever.

**Asked of the agent, not enforceable from inside the plugin:**

- answer only when the message asks for something, or when the sender explicitly asked for a reply; a reply is not a message to auto-answer;
- stop after two or three exchanges and take the conclusion back to the human;
- keep `urgent` off for routine replies, **and on for corrections** — a message that invalidates an earlier one has to interrupt, or the other side finishes the wrong work first;
- do not queue several messages before the other side answers; they stack up in its `next-turn` inbox.

**Identity separation:** the `From` header is written by the plugin from the caller's runtime session id (`exec.agent.session.id`, falling back to `exec.agent.id`), never taken from the tool arguments, so a session cannot claim to be another one. The body-level guard keeps a second, forged header out. Within one host the sender is therefore authoritative. What this does not do is authenticate across hosts — and delivery is refused when the target lives outside this host.

**Not guarded:** a genuine A↔B ping-pong between two compliant agents — nothing counts hops. The only backstop is the convention above.

## Publishing to the market (not done)

This repository is the source; no marketplace submission has been made. For reference, the marketplace is the `awesome-dsh-plugin` list: a plugin gets in by adding one `data/plugins/<owner>__<name>.yml` entry through a pull request, and the list's CI re-reads this repository's `package.json`.

What the list's CI checks, and where this package stands:

- `dsh.bundle.patch` declared in `package.json` — **present** (a package that only declares `dsh.client` is not installable; this is the most common rejection);
- `repository` / `homepage` / `bugs` — **not filled in yet**;
- the `cordis.patch.yml` uses an `insert` list, no tab characters — **present**;
- the entry file itself — **not created yet**;
- the GitHub repository must be at least one day old before CI accepts the entry — **not created yet**.

A `dsh-plugin.json` manifest is **not** required by this marketplace (a published plugin, `dsh-notify`, has none). `LICENSE` (MIT) and the `files[]` list are in place.

## Running the tests

```sh
node --test test/mail.test.js
```

17 assertions: message format, cookie minting, the request envelope, queue/steer modes, the request-id marker, the tool registration and the disabled path.

All three spellings work on Node 26.8.1 — `node --test`, `node --test test/` and the explicit file. The explicit file form is the one to put in CI: on Node 24 (the runtime DSH itself ships) the directory form fails with `Cannot find module '…\test'` and reports `fail 1`, which looks like a red suite but is an invocation error.

## Install

```sh
node scripts/install.mjs --profile <DSH_HOME>/profiles/desktop
```

That writes the profile dependency, adds the package to `dsh.profile.bundles`, and links it into the profile's `node_modules`.

**No restart is needed for a newly installed plugin.** The host re-composes the profile tree when the profile changes, so the tool is in the tool table on the next turn (measured 2026-10-29 on the desktop profile: the host had been running since 04:00, and the tool worked without a restart). What still needs a restart is editing the *code* of an already loaded plugin — its module is not re-imported. That is the case for internal-method changes and load-time overrides (`internal/config` overlays and the like), not for a tool registration.

## Replying when your session has no tool yet

There is a window between "a message arrives" and "the plugin is mounted"; during it the receiving session can receive but has no way to answer.

One-line test: **does your tool table contain `send_session_message`?** If not, the plugin is not loaded in your session.

Fallback — the host's own RPC route, from the command line:

```sh
node <DSH_HOME>/tools/dsh-api.mjs --method session/prompt --payload-file payload.json
```

```json
{"request":{"requestId":"<uuid>","sessionId":"<target session id>","mode":"queue",
 "content":[{"type":"text","text":"From <your session id> ：\n<your text>"}]}}
```

Two things matter here: the `From` header is **not** added for you, so write it yourself or the receiver cannot tell who sent it; and the cookie the CLI mints comes from the `client-connection/browser-session` credential record.

## Finding a session id

Do **not** look it up with the `session/list` API: it returns the complete projections for every session (turn outlines, full tool tables, usage) and floods the context. Read the id from the session directory instead — `~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd` — and pick the most recently modified one.

## How it delivers

The plugin uses the host's own RPC route, the same one the GUI uses:

```
POST http://127.0.0.1:<port>/api/session/prompt
{"type":"client-request","rpcId":"…","method":"session/prompt",
 "payload":{"args":{"request":{"requestId":"…","sessionId":"…","mode":"queue",
                        "content":[{"type":"text","text":"From … ：\n…"}]}}}}
```

`/api` requests are authenticated with the host's signed browser-session cookie: the name is `dsh-auth-` + base64url(sha256(`host:port`)) and the value is `v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>`, where the secret is the `client-connection/browser-session` credential record and must be base64url-decoded before it is used as the HMAC key.

Because the delivery goes through the host's own route, the target session is resumed with its own agent preset, the next model request uses that session's recorded model, and the message lands in its durable log.

## Limits

- Target session must live in the same DSH host; a second app instance has its own sessions.
- One session can be busy in one turn at a time; a queued message is delivered when the turn ends.
- The plugin needs the host's web server mounted (desktop and web profiles have it).

---

# dsh-session-mail（中文）

同一个 DSH 宿主里，一个会话的代理可以把话发给另一个会话的代理。

投递是**单向**的：对方要回话，再调一次同一个工具即可（目标会话 id 就写在消息抬头里）。

## 收信方看到的内容

插件投递的每条消息都是同一个形状：

```
From <发信方 sessionID> ：
<要说的话>
```

第一行是发信方的 session id —— 收信方据此知道「这是另一个代理发来的，不是主人」，也知道自己该往哪儿回信。收信侧不需要额外机制：消息就是目标会话里的一条普通提示词，工具说明里写清了 `From` 抬头代表什么。

## 工具

`send_session_message`

| 参数 | 类型 | 含义 |
| --- | --- | --- |
| `toSessionId` | string | 目标会话 id（`session-<32 位十六进制>`）。回信时填 `From` 抬头里的那个 id。 |
| `message` | string | 要说的话（正文）。插件会自动加 `From` 抬头。 |
| `urgent` | boolean | `false`（默认）＝顺序发送，等对方当前回合结束再送达；`true`＝插话，立刻插进对方正在跑的回合。 |

## 顺序发送还是插话：`urgent`

`urgent` 决定消息怎么交给目标会话：

| `urgent` | 宿主 mode | inbox target | 什么时候落地 |
| --- | --- | --- | --- |
| `false`（默认） | `queue` | `next-turn` | 等对方当前回合结束 —— 成为下一个回合的第一步 |
| `true` | `steer` | `next-step` | 落在对方**当前回合**的下一步 |

2026-10-29 对着活着的对端会话实测：

- `urgent: false`、对方正忙：入队到 `next-turn`，**21 秒后**落地在下一个回合的第一步（跨完了正在跑的那个整个回合）。
- `urgent: true`、对方空闲：入队到 `next-step`，**当场**起了新回合。
- `urgent: true`、对方在跑 5 秒一步的循环：入队到 `next-step`，**4.0 秒**后落在**同一个回合**的下一步。

一个坑（宿主源码 `dsh-agent-loop` 实读）：插话**不会抢占正在执行的那个工具调用**。对方当前这一步卡在前台命令上（比如 90 秒的 sleep），消息要等那个调用返回 —— 但仍然落在同一个回合里，不是回合之后。

宿主还有一处会把插话**降级**成排队：对方当前回合若已被 abort，消息会改投 `next-turn`（`send()` 在 abort 信号置位时把 target 解析成 `next-turn`）。

**什么时候用哪个** —— 更正类消息必须走打断通道：

- **`urgent: true`**：让「对方已经收到的那条」失效的消息 —— 更正、撤回、结论变了。走排队的话，对方会先把错的指示做完、把 token 烧完，才看到更正。
- **`urgent: false`**（默认）：普通回信、补充说明、新请求（不推翻前面的）。

判据一句话：这条消息是否让早先那条变错？是 ⇒ `urgent: true`。

## 开关

插件在 **Settings → Plugins** 里以 `dsh-session-mail` 出现，可以直接关掉。开关在活 profile 上即时生效，不用重启：关掉后条目变成 `enabled: false`（插件卸载，所有工具表里都不再有这个工具），再开则重新注册。

关掉等同于"把工具拿走"：已经在跑的回合照跑完，只是之后发不出消息。

## 怎么确认消息真的落地

宿主把投递的消息记成一条普通 user message，所以落地凭据是**消息事件本身**，不是工具调用：

```
type === 'user/message'  &&  data.content[0].text.startsWith('From session-')
```

`tool/call` / `tool/result` 只说明**发信方**调了工具；真正落地的是随后那条 `user/message`。

## 怎么区分「投递的消息」和「主人手打的」

宿主把投递的消息记成 `data.source.kind === 'user'`，跟真人输入一模一样 —— **事件本身分不出两者**，所以改用两个标记：

- **给人读（人或模型）**：正文里的 `From <session id> ：` 抬头。工具说明里写清了它代表什么，所以收信模型知道「这是另一个代理发的」以及该往哪儿回。
- **给程序读（日志、工具链）**：`data.source.rpcId`。插件把 requestId 铸成 `dsh-session-mail:<uuid>`，落地事件里的 request id 一眼就能认：

```json
{"type":"user/message","data":{"source":{"kind":"user","rpcId":"dsh-session-mail:01234567-89ab-cdef-0123-456789abcdef"}}}
```

判据：`data.source.rpcId.startsWith('dsh-session-mail:')`。**不用改宿主** —— requestId 本来就是客户端自己定的。

信封里的关联 id **没被动过**：`client-request` 信封的 `rpcId` 始终是裸 UUID（只负责请求↔响应配对），标记挂在**内层 `request.requestId`** 上 —— 它的文档含义正是「客户端自铸、会持久化到被接受的那条 user message 上的身份」。落地时宿主把这个字段抄进 `data.source.rpcId`，所以标记出现在那里。

**重发同一个 `request.requestId` 是安全的**：宿主会从自己的记录里回 `{accepted: true}`，不会再投一条（2026-10-29 实测：同一份 payload 连发两次，只有 1 次 splice、1 次落地）。

去重扫描范围（宿主源码实读）：`hasPromptRequest` 先看待投递的 inbox（`nextTurn` + `nextStep`），再看**会话的 append-only 事件日志**（`session.snapshotEvents()`，其文档写明是「private append-only log 的不可变全量快照」）。日志**从不截断** —— 折叠和压缩只会**追加**带 surface 元数据的事件 —— 所以已经被折叠出可见 surface 的消息仍然算数。真正的有效期＝**会话本身的存在期**：会话被删，记录随之消失。

升级时留意一处：`snapshotEvents()` 在宿主里已标 `@deprecated`（"new calls are prohibited"，待切换成异步会话读取）。若那条读取路径改成只看可见 surface，去重窗口会变窄。DSH 升级后请发一条自检消息确认能落地。

要真正区分就得动宿主本体：给投递一个专属 role 或 `source.kind`，让它根本不是 user message。`session/prompt` 这条路永远造 user message，它的参数 schema 里也没有 source 字段 ⇒ 那是 DSH 本体的改动，不是这个插件能解决的。

## 语义边界（防套娃、防伪造）

插件是个单向投递口：把一条消息交出去就完了，不跟踪后续。所以「循环」主要是约定问题，不是管线问题 —— 能强制的在插件里强制，不能强制的写进工具描述。

**插件强制的两条**（2026-10-29 实测均生效）：

- **不能发给自己** —— `toSessionId === 你自己的 sessionID` 直接拒绝（"不能发给自己（会形成自问自答的循环）"）。这是最紧的那种死循环。
- **正文不能带 `From session-<id> ：` 抬头** —— 拒绝。它要么是伪造身份，要么是转发，转下去会无限弹。

**只靠约定、插件内强制不了的：**

- 只有消息需要你行动、或对方明确要求回信时才回；**收到的是回信就别自动再回**；
- 一轮对话最多两三个来回，需要更多就把结论交回主人；
- 回信默认别用 `urgent`，但**更正必须用** —— 让早先那条失效的消息要打断，否则对方先把错的做完；
- 对方没回之前别连着发多条，会堆在对方的 `next-turn` 队列里。

**身份分离**：`From` 抬头由插件按**调用方运行时的会话 id** 写（`exec.agent.session.id`，回退 `exec.agent.id`），**绝不取工具参数**，所以会话没法冒充别人；正文那一层再挡掉伪造的第二条抬头。同一宿主内发信方因此是可信的。它做不到的是**跨宿主认证** —— 目标不在本宿主时直接拒绝投递。

**没强制的**：两个守规矩的代理之间真打起了 A↔B 乒乓球 —— 插件不数跳数。唯一兜底就是上面的约定。

## 发到市场（未做）

这个仓库就是源码；**没有**提交过市场。供参考：市场是 `awesome-dsh-plugin` 这份清单 —— 插件靠往 `data/plugins/<owner>__<name>.yml` 加一个条目、提一个 PR 收录，清单的 CI 会重新读取本仓库的 `package.json`。

清单 CI 检查什么、本包现状：

- `package.json` 里声明 `dsh.bundle.patch` —— **已有**（只声明 `dsh.client` 的包装不上，这是最常见的被拒原因）；
- `repository` / `homepage` / `bugs` —— **还没填**；
- `cordis.patch.yml` 用 `insert` 列表、无 tab —— **符合**；
- 收录条目文件本身 —— **还没建**；
- GitHub 仓库必须建满一天 CI 才收条目 —— **还没建**。

这份市场**不需要** `dsh-plugin.json` 清单（已上架的 `dsh-notify` 就没有）。`LICENSE`（MIT）与 `files[]` 已就位。

## 跑测试

```sh
node --test test/mail.test.js
```

17 条断言：消息格式、cookie 铸造、请求信封、queue/steer 两种模式、requestId 标记、工具注册、关闭态。

Node 26.8.1 上三种写法都通 —— `node --test`、`node --test test/`、直接指定文件。CI 里请用**直接指定文件**那种：Node 24（DSH 自带的就是它）下传目录会报 `Cannot find module '…\test'` 并汇总成 `fail 1`，看着像全红，其实是调用形式不对。

## 安装

```sh
node scripts/install.mjs --profile <DSH_HOME>/profiles/desktop
```

它会写 profile 依赖、把包加进 `dsh.profile.bundles`、并在 profile 的 `node_modules` 里建链接。

**新装插件不需要重启 DSH**：宿主会在 profile 变化时重算配置树，工具在下一个回合就出现在工具表里（2026-10-29 实测：宿主从 04:00 一直跑着，工具没重启就可用）。
仍需要重启的是**改已装载插件的代码** —— 模块不会被重新 import。这条针对的是改内部方法、加载期覆盖（`internal/config` overlay 之类），不是工具注册。

## 收信方还没有工具时怎么回信

存在一个「消息已到、插件还没挂上」的窗口期，这段时间收信方收得到、却没有回信通道。

一句话判据：**你的工具表里有没有 `send_session_message`？** 没有＝插件还没挂到本会话。

回退路径＝手调宿主自己的 RPC 路由：

```sh
node <DSH_HOME>/tools/dsh-api.mjs --method session/prompt --payload-file payload.json
```

```json
{"request":{"requestId":"<uuid>","sessionId":"<目标会话 id>","mode":"queue",
 "content":[{"type":"text","text":"From <你的 session id> ：\n<正文>"}]}}
```

两点要注意：`From` 抬头**不会**自动加，得自己写，否则对方认不出是谁发的；CLI 签 cookie 用的是 `client-connection/browser-session` 那条凭据记录。

## 怎么找会话 id

⛔ **不要**用 `session/list` API 找：它会把每个会话的完整 projections（turn outline、全量 tools 表、usage）一起吐回来，一次调用就能灌爆上下文。
正确做法是看会话目录 —— `~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd` —— 取最近修改的那个。

## 投递原理

走宿主自己的 RPC 路由（GUI 用的同一条）：

```
POST http://127.0.0.1:<port>/api/session/prompt
```

`/api` 的认证是宿主签的浏览器会话 cookie：名字 `dsh-auth-` + base64url(sha256(`host:port`))，值 `v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>`，密钥是 `client-connection/browser-session` 那条凭据记录，**必须先 base64url 解码成字节**再当 HMAC 密钥。

因为走的是宿主自己的路由，目标会话会带着它自己的 agent preset 被唤醒，模型请求用它记录下来的选型，消息也会进它的持久化日志。

## 边界

- 目标会话必须在同一个宿主里；另一个应用实例有自己的一套会话。
- 一个会话同一时刻只跑一个回合，排队的消息在回合结束后送达。
- 插件需要宿主挂载 web server（desktop / web profile 都有）。
