# OpenInstinct — user guide

You can start talking to Gajae in the Chat window as soon as you sign in to an
AI account. iMessage is optional: connect it later when you want to text from your
phone. This guide is for the person installing and using it, not for developers.
Everything technical is in the [runbook](runbook.md).

## Optional: prepare iMessage (5 minutes, once)

Skip this section for a Chat-only install. If you want phone texting, Gajae uses
this Mac's Messages account only through the optional iMessage lane. If that
account is your own, every reply it sends lands in your own conversations. Use a
dedicated Apple ID:

1. Create a new Apple ID for Gajae (any email; it needs a phone for the
   verification code, but that phone is not Gajae's number).
2. On the Mac: Messages → Settings → iMessage → sign out → sign in with the new
   Apple ID.
3. Add the new Apple ID's email to your iPhone contacts as "Gajae" so you have
   something to text.

The panel checks this only when you choose the optional iMessage branch. It shows
the account it sees and refuses that lane if Messages is still signed in as your
own Apple ID.

## Install

1. Open Terminal and paste this, then press Enter:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Yeachan-Heo/openinstinct/main/scripts/install-remote.sh | sh
   ```

   (Rather not pipe into a shell? Download the `.tar.gz` from the
   [Releases](https://github.com/Yeachan-Heo/openinstinct/releases/latest) page,
   unpack it, and run `sh <folder>/scripts/bootstrap-from-payload.sh <folder>`.)
2. The release archive copies the files and opens the menu-bar panel. Click the
   speech-bubble icon → **Chat…**; sign in under **Settings… → AI account**.
3. Chat is usable as soon as the AI account is ready. Phone number, Messages
   identity, Full Disk Access, Automation, and Accessibility are not needed for
   Chat.
4. To add phone texting later, open **Settings… → iMessage**, enter an owner
   handle, and complete the optional identity and permission prompts. Connecting
   or disconnecting this lane does not restart the shared Chat session.

The panel shows live status for each branch and tells you what to do when one is
blocked. There is no installer app; curl or the checksum-verified release archive
is the supported installation path.

## Chat without iMessage

The Chat window is a separate window with iMessage-like bubbles and plain text:

1. Click the menu-bar icon → **Chat…**.
2. Sign in to an AI account or add an API key under **Settings… → AI account**.
3. Type and send. Chat does not need a phone number, `chat.db`, Full Disk Access,
   Automation, or Accessibility.

The composer is blocked only when the daemon cannot be reached, no AI credential
is available, or Gajae is paused. A detached iMessage lane never blocks Chat.
Gajae's replies, segments, and images appear in the window; the panel composer is
text-only.

Chat and the optional iMessage lane feed one shared session and owner-turn ingress;
connecting or disconnecting phone texting does not fork or reset the conversation.

## Optional iMessage setup

To add phone texting after Chat is working:

1. Open **Settings… → iMessage** and enter your phone number with its country code
   (or an email handle).
2. Press **Connect**. The daemon checks Full Disk Access for `chat.db` and then
   attaches the iMessage lane when it can. Grant Automation so it can send through
   Messages; grant Accessibility if you want typing and read-receipt presence.
3. Watch the iMessage status in that tab. Connecting or disconnecting does not
   restart Gajae, and Chat remains available while the lane is detached.
4. To stop phone texting, press **Disconnect**. Changing the number retires the
   old number's pending deliveries before the new lane can attach.

## Using it

Type in the Chat window, or text Gajae from your phone once the optional iMessage
lane is connected. Some things it's good at:

- "내일 일정 뭐 있어" / "이 링크 요약해줘" / "이 사진 뭐야" (send a photo)
- "매일 아침 9시에 오늘 일정 브리핑해줘" — creates a scheduled task
- "이 페이지 가격 바뀌면 알려줘, 이번 주만" — a watch with an end date
- "카카오 선물하기에서 아메리카노 한 잔 보내줘" — it uses its own Chrome
- "이거 기억해둬: …" — saved to memory, recalled later
- "그 모니터 꺼" / "지워" — toggle or delete a scheduled task
Use **Run now** on a scheduled task to dispatch it immediately without changing
its schedule or enabled state.

Long work comes back as "on it" first, then the result. It never uses Markdown,
never quotes your message back, and replies in whatever language you text in.

### Typing indicator and read receipts (optional)

The typing indicator and read receipts are optional presence features. To use
them, grant `~/.openinstinct/bin/openinstinctd` **Accessibility** permission in
System Settings → Privacy & Security → Accessibility. Sending messages does not
need this permission.

### Giving it passwords

You can. Text a login and it stores it in `~/.openinstinct/secrets/` (owner-only
file permissions) and uses it next time without asking. It never repeats a
secret back to you. One-time codes are used once and not stored.

## The menu bar

Click the icon:

- **Health line** — "Awake and listening", "Paused", "Needs setup", "Something's
  off", or "Not running".
- **Chat…** — open the always-available Chat window.

- **Working on** — background tasks in flight.
- **Scheduled tasks** — every monitor with its next and last run in your local
  time. Switch off with the toggle; delete a switched-off one with the trash
  icon. The two lock icons are built-in memory upkeep and can't be removed.
  Time-boxed ones show "until …" and then "Ended …".
- **Quick actions…** — pause/resume, open Gajae's browser, refresh personality.
- **Settings…** — full settings window (below), including the optional iMessage
  connection.
- **Version line** — the installed release at the bottom. The panel checks
  GitHub once a day; when a newer release exists the line turns into
  **Update to vX.Y.Z**. Click it: the installer re-runs in the background, the
  menu bar icon disappears for about a minute and comes back on the new
  version. Your conversation, memory, permissions, and settings are kept.
  **Check for updates** checks right now. Source-checkout installs have no
  version line; update those with `git pull && bash scripts/install.sh`.

If something needs you (a missing AI account, or a permission problem on an
attached iMessage lane), a popup appears once and the icon gets an orange dot
until it's fixed. A detached optional lane is not a Chat error.

## Settings window

- **AI account** — sign in with a subscription (dropdown, popular ones first),
  paste an API key, or connect a custom endpoint (base URL + key + model). Pick
  which model Gajae thinks with.
  Existing Claude or ChatGPT/Codex CLI sign-ins can be listed with **Discover**;
  choose **Adopt** explicitly to use one. Gajae never adopts a subscription on its
  own because that could start billing it.
- **You** — your name.
- **iMessage** — optionally connect or disconnect your phone number, see the lane
  and permission status, and keep using Chat without it.
- **Browser** — "Open Gajae's browser": a Chrome window on Gajae's own profile.
  Sign into Gmail, Kakao, your bank, whatever you want it to use, then close it.
  Your own Chrome is never touched, and those sites won't log *you* out.
- **Limits** — how long it waits for a silent reply; how many background tasks
  at once; how long finished tasks stay warm, when idle tasks are forgotten,
  how often progress is bundled, and the per-task update rate.
- **Personality** — the text that makes Gajae Gajae. Edit and apply; the
  conversation continues with the new personality.

## Pausing

Quick actions → **Pause**. Texts you send while paused are kept, not answered;
when you resume, Gajae tells you how many it missed.

## When it's not working

| You see | Do |
|---|---|
| "Needs a permission" | If iMessage is attached, follow the permission detail under **Settings… → iMessage**. Chat itself does not need that permission. |
| "Messages is signed in as you" | Only the optional iMessage lane is blocked; sign out of Messages and sign in with Gajae's dedicated Apple ID before pressing **Connect**. |
| "Gajae has no AI account yet" | Settings → AI account. |
| "iMessage is detached" | Read the reason under Settings → iMessage. You can keep using Chat while you fix it or leave it disconnected. |
| Replies stop mid-task | Nothing to do — long work has a 5-minute silence limit and it will tell you if it gave up. |
| Pictures arrive as captions only | When using iMessage, Messages must be open (hidden is fine, quit is not) and Automation must allow `openinstinctd` to control Messages. |
| "Not running" | Wait a few seconds; if it stays, run the installer again. |
| "The last update did not finish" | The log tail is shown under the version line. Fix the cause (usually network), then **Update** again; or run `sh ~/.openinstinct/src/scripts/update.sh` in Terminal and watch `~/.openinstinct/logs/update.log`. |
| Something else | Quick actions → Show log files, and send `daemon.ndjson`. |

## Uninstall

In the menu-bar panel, choose **Settings… → Uninstall Gajae…**. If the panel is
not available, use this fallback:

`bash ~/.openinstinct/src/scripts/uninstall.sh` (or delete `~/.openinstinct`,
`~/Applications/OpenInstinctPanel.app`, and the two `co.openinstinct.*` files in
`~/Library/LaunchAgents`). Remove `openinstinctd` from the permission lists if
you like. Memory lives in `~/.openinstinct/memory` — copy it first if you want
to keep it.
