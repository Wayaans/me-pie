# ask-me and Telegram AFK

`ask_me` remains one tool. By default it opens the existing TUI questionnaire or RPC dialogs. AFK sends that questionnaire to a private Telegram bot chat instead. The tool stays pending until you submit or cancel, then returns the same question-and-answer transcript and details. Telegram replies are answer data, never Pi messages, commands or shell input.

## Local questionnaire

`question` accepts a free-form multiline answer. `selection` offers one option or a custom answer. `confirmation` offers Yes, No or a custom answer. Multiple mixed questions appear as a questionnaire and end on a review screen. Each question can include decision context and a recommendation with a reason.

TUI controls:

- Enter / Tab saves and opens the next question.
- Shift+Tab goes to the previous question. Arrow keys move through options.
- Shift+Up / Shift+Down scrolls long question context.
- Shift+Enter inserts a newline in text input.
- Ctrl+R applies a recommendation only when unanswered. It never overwrites an answer or submits automatically.
- Esc returns from custom input or cancels the questionnaire.
- Ctrl+T transfers the saved draft to Telegram.

The compact tool row reports creating, waiting, completion, cancellation or failure. The completed transcript keeps the interview title, every question and answer, option descriptions and any Overall response. Cancellation explicitly marks unanswered questions. The same transcript goes to the agent.

RPC uses Pi's abort-aware standard input and selection dialogs. Recommendations are displayed, but multiline editing, previous-question navigation and the TUI-only shortcuts are unavailable. Without AFK, print and JSON modes still report that interactive input is unavailable.

## First-time setup on macOS

Do this once. Normal Pi instances then load the saved destination without exports or a wrapper.

1. Open the verified **@BotFather** account in Telegram and send `/newbot`. Follow its prompts to create a dedicated bot. Keep the token private.
2. Open your new bot's **private chat** and tap **Start**, or send `/start`. A bot cannot message you until you start its chat. Do not add it to a group.
3. Obtain your numeric user ID and private chat ID using the recipe below, or your own trusted method. Usernames are not accepted.
4. In the local Pi terminal, run `/ask-me setup`. Choose **Global (recommended)** so all your projects can use it.
5. Paste the BotFather token into the masked token field. It shows only a fixed mask, never the token. Enter the numeric user ID and private chat ID.
6. Review the scope, file, destination IDs and token-presence indicator, then explicitly confirm **Save**. Esc cancels without writing settings or credentials.
7. When leaving your desk, run `/ask-me afk on`, or start another session with `pi --afk`. Setup does not enable AFK automatically.

Never paste the token into agent chat, an ordinary prompt, a tool argument, a config file or a shell command. Setup is a local TUI command, not an agent tool. RPC, print and JSON modes can use saved settings, but cannot run secure setup.

### Get the numeric IDs safely

Before enabling AFK, send `/start` to your bot again. If you have Python 3, run this snippet yourself in a normal terminal, not through an agent tool. It prompts for the token without echo, calls Telegram once, and prints only IDs from private messages. The token is not in command arguments, shell history or a temporary file. Do not run it while the bot has another poller.

```sh
python3 - <<'PY'
import getpass, json, warnings, urllib.request
warnings.simplefilter("error", getpass.GetPassWarning)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
try:
    token = getpass.getpass("BotFather token (hidden): ")
    request = urllib.request.Request(
        "https://api.telegram.org/bot" + token + "/getUpdates",
        data=b'{"timeout":0}', headers={"Content-Type": "application/json"})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
        body = response.read(1048577)
    if len(body) > 1048576:
        raise ValueError()
    result = json.loads(body)
    if not isinstance(result, dict) or result.get("ok") is not True:
        raise ValueError()
    pairs = set()
    for update in result.get("result", []):
        message = update.get("message", {})
        sender, chat = message.get("from", {}), message.get("chat", {})
        user_id, chat_id = sender.get("id"), chat.get("id")
        if (chat.get("type") == "private" and sender.get("is_bot") is False
                and type(user_id) is int and type(chat_id) is int
                and user_id > 0 and chat_id > 0):
            pairs.add((user_id, chat_id))
    for user_id, chat_id in sorted(pairs):
        print("User ID:", user_id, "Private chat ID:", chat_id)
    if not pairs:
        print("No private message found. Send /start to your bot and retry.")
except Exception:
    print("Could not get IDs. Check the token, connection and that no other poller is running.")
PY
```

For a private conversation, the user ID and chat ID normally match. If several pairs appear, do not guess which one is yours. Use a fresh dedicated bot you have not shared, or verify the IDs independently. The wizard does not contact Telegram or test whether a token or destination works.

### Storage, scope and Keychain permissions

The token lives in macOS Keychain under service `mepie.ask-me.telegram`, with a random item reference. Writes use `/usr/bin/security -i -q` with a private stdin pipe, never a token in subprocess arguments or a plaintext file. Reads occur only when routing a questionnaire, not during status or AFK toggles. Each operation has a 30-second deadline and hides raw subprocess errors.

macOS may ask permission when the token is first read. Approve the expected Keychain item. Choosing **Always Allow** remembers access for `/usr/bin/security`; choosing **Allow** can prompt again next time. This permission trusts that utility, not just this extension. Local processes running as your Unix user are already inside the extension's trust boundary.

Only nonsecret settings go in an owner-private `0600` JSON file:

- Global: `~/.pi/agent/ask-me.json`, resolved with Pi's `getAgentDir()`, including `PI_CODING_AGENT_DIR` overrides.
- This project: `<cwd>/.pi/ask-me.json`, using Pi's `CONFIG_DIR_NAME`. Pi must trust the project before the extension reads or changes this override.

Each file contains `version: 1`, numeric `userId` and `chatId`, and an opaque `tokenRef`. It must be a complete destination; tokens and extra fields are rejected. Saves use an exclusive lock, an optimistic revision check and atomic replacement. Files with unsafe permissions, symlinks, invalid JSON or read failures fail explicitly rather than selecting another destination.

Run `/ask-me setup` again to keep the existing token without reading it, replace it, or set up a separate project destination. For a project with global settings available, **Use global destination (remove project override)** asks for confirmation and removes only that project's settings file. It inherits future global changes rather than copying credentials. Shared Keychain items are preserved.

Replacing a token creates a new Keychain item. It never overwrites or deletes an old item that another scope or process may use. A failed save can leave an unused new item, but keeps the old configuration. Remove unused items yourself in Keychain Access only after checking their references. If a setup process is killed, its `ask-me.json.lock` may need manual removal after verifying no other setup is running.

### Precedence and environment compatibility

The first complete applicable destination wins:

1. Explicit ask-me environment override.
2. Complete project settings, only when Pi trusts that project.
3. Global settings.

The token and IDs always come from the same source. An applicable but invalid source, unreadable file or failed Keychain read is an error, not permission to fall back to another chat. Untrusted project configuration is ignored without reading it.

The environment override is active if **any** of these variables is defined, even as an empty string:

- `MEPIE_ASK_ME_TOKEN_ENV`
- `MEPIE_ASK_ME_TELEGRAM_USER_ID`
- `MEPIE_ASK_ME_TELEGRAM_CHAT_ID`

When active, both ID variables and a valid token must be present. `MEPIE_ASK_ME_TOKEN_ENV` names the token variable and defaults to `TELEGRAM_BOT_TOKEN` only when unset. It must be a variable name, not a token or command. An unrelated `TELEGRAM_BOT_TOKEN` by itself does not override saved setup. To return to saved settings, unset all three `MEPIE_ASK_ME` variables above.

Linux retains this environment-based operation using an existing secret manager. Interactive secure storage setup currently supports macOS only. For example, with `MY_TELEGRAM_TOKEN` already supplied by your secret manager:

```sh
export MEPIE_ASK_ME_TOKEN_ENV=MY_TELEGRAM_TOKEN
export MEPIE_ASK_ME_TELEGRAM_USER_ID='<NUMERIC_USER_ID>'
export MEPIE_ASK_ME_TELEGRAM_CHAT_ID='<NUMERIC_PRIVATE_CHAT_ID>'
pi --afk
```

The bridge launcher uses Node and the installed Pi package's jiti runtime and peer packages. No extra package or TypeScript runner is needed. The Node Pi installation is supported on macOS and Linux. Starting a bridge from Bun or a compiled Pi executable is not supported. An already-running compatible bridge can still accept a client.

## Commands and handoff

- `/ask-me afk` toggles AFK for this Pi session.
- `/ask-me afk on` enables it. A currently open local questionnaire stays local; use its shortcut to transfer it.
- `/ask-me afk off` disables it. A pending Telegram questionnaire returns to TUI or RPC with its saved draft. Without interactive UI, it cancels instead of hanging.
- `/ask-me setup` configures a destination once without changing AFK preference or restarting any bridge.
- `/ask-me status` reports the active source, nonsecret destination IDs, configuration readiness, full pending request ID, connection/progress state and request errors. It does not read Keychain or test Telegram. In RPC, this uses the normal notification protocol.
- Inside the custom TUI questionnaire, **Ctrl+T** saves the current typed draft, enables AFK and sends the draft to Telegram. This is necessary because the main editor cannot accept slash commands while the questionnaire owns it. Missing configuration keeps the local questionnaire open.

The footer stays short: `☾ AFK` when enabled, `◌ AFK connecting` or `◌ AFK sending` during delivery, `? AFK 1/2` while waiting, and `? AFK writing 1/2` after opening text input. `✗ AFK error` marks a Telegram failure; `✗ ask-me error` marks a local failure. IDs, paths and error details belong in `/ask-me status`, not the footer. Local mode normally has no indicator.

TUI reclaim opens the questionnaire with saved answers. RPC reclaim asks unanswered questions, shows the saved answers and requires explicit final submission. Returning to local input never submits the remote draft by itself.

`--afk` enables and persists AFK on process startup, overriding the resumed branch's preference. Without the flag, the active branch's saved preference is restored, or defaults to local. `/reload`, `/tree` and subsequent session replacement restore that branch's entries rather than reapplying the startup flag. An explicit `afk off` therefore survives reload. Forks inherit entries on their selected branch. There is no global AFK switch and the subagent launcher is unchanged; each new session must opt in separately.

AFK also works in print and JSON modes without UI. Only `ask_me` is routed. Other extensions' dialogs, permission gates and terminal prompts are not forwarded.

## Answering on Telegram

Each page has a compact project/session header, a short display request ID such as `#1a2b3c4d`, and the question position. The question is bold, with context and recommendation reason below it. Choice buttons show their labels; Yes and No share a row. Long labels are shortened only on buttons, with their full text and descriptions in the body. Long pages split into numbered messages with the same identity. Question context is not truncated, and special characters are escaped before Telegram displays them.

Tap **Write answer**, or **Write another answer** on selection and confirmation questions. Telegram opens its reply field with a prompt for that exact question. Type your own answer and send it. This saves a typed answer, even when the question offers Yes/No. It never counts as a selected option or an automatically accepted recommendation.

You can also reply directly to any message in the current page of the intended request. Bare text is ignored. Replies to old pages are rejected, never assigned to whichever session asked most recently. The short display ID is not used for routing; full IDs and the exact message/question revision stay internal.

Use the original page's navigation or Cancel to leave writing without answering. Navigation and saved answers expire both the original page and its writing prompt. Repeated taps on Write do not create multiple prompts for the same page.

Use Next, Previous and Review where available. Optional questions have Skip. Recommendations require an explicit button press and are never accepted automatically. Saving an answer does not finish the interview. Use **Submit** on the review page to complete it. Submit appears only when the required answers are present. Multi-question reviews also offer **Write overall response**, or accept a direct reply to the review page. An overall response can answer the whole request instead of separate required answers, but still requires Submit.

Cancel retains saved partial answers and means no decision. Handoff, cancellation, disconnect, abort, reload, session switch, branch navigation and shutdown invalidate the old controls. Old Telegram buttons may remain visible, but the bridge rejects them. Only one terminal outcome is accepted when submission races with cancellation or handoff.

## Local bridge and failures

One detached process per bot owns `getUpdates` long polling. Pi clients connect through a user-owned Unix socket at:

```text
/tmp/mepie-ask-me-<UNIX_UID>/<BOT_ID>/socket
```

The parent directory and per-bot election directory are mode `0700`; the socket and PID file are mode `0600`. The token is passed only in the bridge process environment, never in arguments, socket messages, transcript, PID file or logs. Processes running as your own Unix user remain within the trust boundary.

An atomic directory election prevents multiple Pi processes from becoming pollers. The bridge refuses an existing webhook or a conflicting poller. It never deletes webhooks or takes over another consumer. Stop that integration yourself or use another dedicated bot. Clients using the same bot must agree on the token and authorized user/chat IDs. The handshake rejects changed settings or an incompatible bridge version before sending a questionnaire. Configuration edits never restart or take over a running bridge. Finish its pending requests and let it exit before retrying with changed settings.

### Loading an update

`/reload` refreshes the Pi extension, not a detached bridge that is still serving other clients. This update uses bridge protocol 3 for typed progress states. An older bridge is rejected before any questionnaire is sent; it is never killed or replaced automatically.

To load the update safely:

1. Finish or explicitly cancel the pending Telegram questionnaires in every Pi instance using this bot.
2. Leave the bot idle for at least 15 seconds so its bridge exits normally. Pi sessions can stay open; completed requests disconnect from the bridge.
3. Run `/reload` in each Pi instance that will use AFK, then retry the questionnaire. The next request starts the updated bridge.

Do not remove locks or terminate a bridge that still owns another session's questionnaire. If a version mismatch persists, check that all clients use the same updated package before retrying.

The bridge exits after 15 seconds without clients and releases its resources on normal shutdown. A lost client invalidates its questionnaire without affecting other clients. There is no crash recovery for an in-flight questionnaire. Transport failure fails the tool; start a fresh `ask_me` rather than answering old pages.

HTTP requests have deadlines: 15 seconds normally, 40 seconds for polling. Retryable reads have at most three attempts, separated by 500 ms. Sending is paced across sessions. Ambiguous send failures are not retried because Telegram has no idempotency key for `sendMessage`; retrying could duplicate a prompt. Authorization errors, rate limits and malformed responses fail explicitly. These transport budgets do not limit how long a connected user may take to answer.

IPC records are capped at 256 KiB, HTTP response bodies at 1 MiB, active requests at 32 and clients at 64. Drafts and final results must fit Pi's complete 50 KiB or 2,000-line transcript limit. Oversized answers are rejected without discarding the previous draft.

### A crashed bridge left a lock

A hard kill can leave the per-bot directory behind. The extension deliberately does not guess whether a PID is stale or steal a lock, which could start two pollers.

Stop the affected Pi clients. Inspect the exact per-bot directory and its `pid` file, and verify that its bridge process is no longer running. Then remove only that bot's stale `socket`, `pid` and empty per-bot directory yourself. Do not remove another bot's directory or a live bridge. The next AFK questionnaire can start a fresh bridge. No questions or tokens are stored in those files.

## Privacy and availability

Your laptop must remain awake, online and running Pi while you answer. AFK does not keep it awake. Telegram bot chats are cloud chats, not end-to-end encrypted secret chats. Telegram and anyone with access to your bot/chat account may see questionnaire content. Content protection is a forwarding deterrent, not a confidentiality guarantee.

Only the questionnaire and its project/session label are sent, not the preceding assistant message or full history. Put enough decision context in each `ask_me` question's `detail`. Never include credentials or unrelated private history.

## Verification

Tests use mocked Keychain calls, masked-input components, temporary configuration files, mocked HTTP and temporary Unix sockets, including independent Node/jiti bridge processes. They never contact Telegram or the real Keychain. Run:

```sh
bun install
bun run check
```

A real bot/phone smoke test is intentionally operator-run after configuration. Check two concurrent sessions, custom replies, Submit, cancellation and both handoff directions before relying on AFK for consequential decisions.
