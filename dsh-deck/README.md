# dsh-deck

The [OpenWalkieTalkie](https://github.com/conol-ai/openwalkietalkie) deck as a
DeepSeek Harness peripheral: its 480脳480 screen shows the live agent roster, a
question or an approval arrives as a card you answer with the wheel and ENTER,
and the harness gets that answer back.

**Status.** The wire, the session, the roster and the card board are implemented
and covered by tests. Everything is verified end to end against an in-memory
fake deck (`transport: sim`). Against real hardware, the handshake, the roster
and the card path work on a **0.7.0** deck, which is old enough to lack parts of
the vocabulary; see *Firmware versions* below.

## Install

Build it into your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: deck
      name: dsh-deck
      config:
        transport: hid
```

or install the package and let its own patch layer do it:

```sh
dsh plugin --profile desktop add <path-to-this-directory>
```

The plugin needs no build step and no native modules. On Windows it reaches the
deck through `hid.dll` via koffi, which the Harness already ships.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `transport` | `hid` | `hid` for Windows USB, `remote` for USB or Bluetooth through the Android phone, `sim` for the in-memory fake. |
| `agentLimit` | `255` | Maximum loaded rows, capped by the capacity reported by the device. Larger catalogs can be paged from the roster. |
| `devicePath` | `''` | Pin one HID interface, for a machine with several decks. |
| `log` | `false` | Write link transitions to the harness log. |

## What it does

With `transport: remote`, the desktop plugin accepts one paired phone at the
WebSocket upgrade path `/deck/usb` on the DSH web server. On USB, the phone forwards
64-byte HID reports for control (channel 5) and voice (channel 7). On Bluetooth,
the phone advertises `X-Deck-Transport: ble` in the upgrade request and forwards
each complete microphone notification as `[6, 7, length, ...frame]`. The desktop
profile runs the sessions and speech recognizer. The plugin reads its pairing
key from `~/.dsh/deck-bridge.key`. The Android app receives that key, the relay
cookie, and the public TLS certificate through `android-otg/pair-phone.ps1`.
On the phone, connect the deck by USB, grant access, and select **连接桌面 DSH**.
For Bluetooth, install the Rev A DSH BLE firmware and select **通过蓝牙连接 deck**
in version 1.3 of the Android app. Confirm pairing on first use.
**查看 DSH 会话** opens the same desktop sessions while forwarding continues.

On the deck, use the left and right buttons to switch between groups of current and saved sessions. Turn the wheel to select a session and press ENTER to read its latest reply. Press ENTER again to see its status and recent activity when there is no pending card. Browsing a saved session leaves its agent stopped.
For a supported question, selecting an option on either screen settles the
request and dismisses the other copy.

| Harness | Deck |
|---|---|
| a live agent (`ctx.agents`) | a roster row: name, project, state, last activity |
| `ask_user_question` | a card with the question and its options |
| `ctx.approval.request` | a card: *Allow bash? 鈥? with **Allow once** / **Reject** |
| the user picks a choice | `answer` 鈫?the tool call resumes |
| CANCEL on a card | `snooze` 鈫?handed to the next answerer |

Both harness seams are Cordis waterfalls, so the plugin **lets go** whenever it
cannot present a question: no link, more than one question in a request, a
multi-select, or more choices than the deck can draw. It never swallows a
request it cannot answer 鈥?that would strand the turn behind a button nobody can
press.

## Files

```
lib/index.mjs              plugin entry: wiring, the two waterfalls, deck_status tool
lib/link.mjs               session: hello, wake retry, heartbeat, sync, 8 ms pacing
lib/protocol.mjs           HID framing and the channel-5 message builders
lib/caps.mjs               what a given firmware version accepts
lib/roster.mjs             agent slots, urgency order, change diffing
lib/answerer.mjs           card board + question/approval normalisers
lib/transport/hid-win.mjs  Win32 HID through koffi
lib/transport/hid-reader.mjs  blocking reader thread
lib/adpcm.mjs              IMA ADPCM decode and a WAV writer
lib/transport/sim.mjs      FakeDeck, for tests and for a desk without hardware
bin/probe.mjs              enumerate HID interfaces, or print a live session
bin/demo.mjs               push three agents and a card, print every event
bin/voice.mjs              listen on channel 7, capture PTT speech to a WAV
bin/flash.mjs              flash an ELF over USB recovery (see FLASHING.md)
test/                      node:test files, run in-process
```

## Running it by hand

```sh
node bin/probe.mjs                  # what Windows sees, and whether a deck is on USB
node bin/demo.mjs --seconds 60      # push a demo, then press the deck's buttons
node test/protocol.test.mjs         # framing and message builders
node test/deck.test.mjs             # handshake, roster, cards
```

`node --test test/` spawns a child per file, which the sandbox refuses with
`EPERM`; run the files directly instead.

## Firmware versions

The deck answers `hello` with its firmware version, and this plugin adapts
rather than assuming the newest build. Everything below was measured on a
**0.7.0** deck on USB:

- A `hello` carrying `hm` (the header clock) gets **no reply at all**, so the
  clock waits for 0.8.0. The same hello without `hm` is answered immediately.
- The first hello after a quiet spell is often dropped; the link knocks every
  1.2 s until the deck answers, then falls back to the 5 s heartbeat.
- A card with **three or more choices** makes the deck drop the whole session
  (its reply is `err range`, then the sid resets to 0). Two choices are safe,
  so `maxChoices` is 2 below 0.10.0.
- `kind`, `proj` and `since` are already understood by 0.7.0.

Flashing 0.15.0 removes all of this, and is the intended path:
`tools/flash-usb.py <elf>` from the firmware repository.

### 0.14.0, measured later

Same shape of lessons, plus three that cost the most time:

- **Only one host at a time.** The official `OpenWalkieTalkie.exe` + `deckd.exe`
  keep the link whenever they are running, visible window or not. Two hosts
  alternate session ids, so the deck answers `sid 0` forever and the roster
  flickers between fresh and gray. Nothing in the protocol says who owns the
  device; choosing one host is the whole fix.
- **An answerer must live in the agent's scope.** `ctx.userQuestions.ask()`
  dispatches through `scopeTarget(agent, agent)`, which admits only listeners
  inside that agent's scope. A handler registered on the plugin's own context is
  never called for an agent-scoped question — the Web answerer takes it and the
  plugin looks broken. Register the same handler on `agent.ctx` for every live
  agent (see `wire()` in `lib/index.mjs`).
- **Never `JSON.stringify` a request.** Payloads carry scoped proxies whose
  getters throw (`cannot get property "toJSON" without inject`) and an answerer
  that throws fails the question closed. `describe()` reads named fields only.
- Empty strings are refused: an `agent` line with `"proj":""` or `"title":""`
  is answered `err parse`, and one refused line leaves the session unsynced.
  Omit an empty optional field instead.
- A card choice is **32 bytes**, and a CJK character is three of them, so keep
  option labels short; longer ones are cut with an ellipsis.
- The HID handle dies for good when the device re-enumerates
  (`ERROR_DEVICE_NOT_CONNECTED`), so the port reopens itself rather than writing
  into a dead handle every heartbeat.

## Protocol notes worth keeping

- Report: `[6, 5, len, payload鈥`, 64 bytes, `len 鈮?61`; a line is UTF-8 JSON
  plus LF, `鈮?1024` bytes, and may span reports.
- On this HID driver an **overlapped `WriteFile` completes with zero bytes
  written**; a plain synchronous handle writes all 64. Reads are the opposite:
  overlapped reads complete immediately with nothing, blocking reads deliver.
  Hence one thread writing and a worker thread reading.
- The deck keeps no state on its own authority: `synced` only sticks once the
  `hello` that opened the session was accepted, so a rejected hello looks
  exactly like a deck that never syncs.

