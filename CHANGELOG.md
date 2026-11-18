# Changelog
## [1.0.9] — 2026-11-18

### Fixed

- **The first message in a new conversation was sent in Chinese even though the English shadow was
  showing.** The plugin only ever learned the composer's `inputActions` from the
  `conversation.composer.dock` panel, which does not exist on the new-conversation screen. Without it,
  sending fell back to writing the English into the DOM — but the app submits from its own React state,
  which still held the Chinese, so the Chinese went out. The `conversation.input.left` tool row is
  present on that screen and does receive `inputActions`, so it now feeds the bridge too. This removes
  the DOM-only path as a correctness dependency.
- `writeEditorText()` now reads the editor back after writing and reports failure when the text did not
  actually change, instead of trusting `execCommand`'s return value (Lexical repaints from its own
  state, so a DOM-only write can be wiped).
- The "stop trying the hero fallback" flag was permanent after a single failure, which made every later
  attempt skip the fallback and release the original text. It now expires after a short cooldown.
- Synthetic clicks (`button.click()`) are no longer intercepted by the plugin's own capture-phase
  handler, and clicks the plugin did not originate (`isTrusted === false`) are never taken over — either
  case previously swallowed the send.

## [1.0.8] — 2026-11-18

### Fixed

- If the translation for a message the user already tried to send fails (network error, 502, timeout),
  the plugin now sends the original draft itself instead of leaving it in the box waiting for a second
  Enter. "Send the original when translation fails" is now what actually happens, in one press.

## [1.0.7] — 2026-11-18

### Fixed

- A Chinese message whose English translation contained words like `me`, `no`, `de` (common in several
  Latin-script languages) could be rejected as "not English": the Latin-language detector counted
  two hits and reported Spanish, the transcript validator then threw `502 empty` and the message never
  left the composer. English function words are now ignored when scoring, and a tie between languages
  is treated as "not another language", so English translations validate again.

## [1.0.6] — 2026-11-18

### Fixed

- The start-screen composer now sends the English version instead of swallowing the message: the
  plugin waits for the composer's own send button to become enabled and clicks it, verifies that
  `actions.submit()` actually cleared the draft, and — if neither works — puts the original draft back
  and lets the next Enter go straight to the app. A new conversation can always send.

## [1.0.5] — 2026-11-18

### Fixed

- The **first message in a brand-new conversation** is translated now. The start-screen composer has
  no `inputActions` yet, so the old code refused to intercept and the raw draft went out. The plugin
  now falls back to writing the English into the editor and clicking the composer's own send button,
  and the interception check accepts that path instead of bailing out.

## [1.0.4] — 2026-11-18

### Changed

- The **发送译文** switch moved into the composer tool row, next to the permission and reasoning
  controls, so it reads as part of the input box instead of a separate strip below it.
- The dock under the composer now carries only a one-glyph status: `EN` when the English version is
  ready, `···` while it is being produced, `!` when it failed and the original will be sent.
- `docs/preview-input.png` re-shot with the switch inside the box.


All notable changes to Shadow Bilingual are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] — 2026-11-18

- Documentation screenshots are now real UI captures from a neutral demo conversation: the composer with the English shadow line (`docs/preview-input.png`) and the bilingual transcript (`docs/preview.png`).

The display language now really works for every language the plugin offers, and the plugin finally
has its own name, icon and screenshot.

### Added

- Chinese name **影译** and a 512×512 icon (`docs/icon.png`).
- A real screenshot of the running desktop app (`docs/preview.png`), replacing the drawn sketch.

### Fixed

- Ten Latin-script display languages — `es fr de pt it nl pl tr vi id` — never translated anything:
  the host treated *any* text containing Latin letters as already in the target language. Detection
  now identifies the source language (`detectLatinLanguage`) and compares it with the target.
- Simplified Chinese was never converted to Traditional (or back): "already in the target language"
  now tells `zh` from `zh-TW` (`looksTraditional`), and `translationTarget` keeps them apart.
- Han-only Chinese with a `ja` target was accepted as Japanese: Japanese now requires kana.
- Spanish/German drafts were mistaken for English and sent unchanged: `looksEnglish` now also demands
  that the text is not another Latin-script language.

### Changed

- The session-header toggle shows the plugin's own name and build version (`影译 v1.0.3`) instead of
  the inherited `双语 v4.4`; the label is read from `package.json` at build time.

## [1.0.2] — 2026-11-18

Packaging release so the repository can be listed in the DSH plugin directory. Behaviour is identical
to 1.0.1; nothing in the translation path changed.

### Changed

- `package.json` now declares `repository`, `bugs` and `homepage` — the plugin directory reads the
  GitHub↔npm mapping from those fields.
- Removed `peerDependencies.react`. React comes from the DSH client runtime, never from npm; the peer
  declaration only made every install print `missing peer react`.
- `docs/preview.png` redrawn: the old picture still said `dsh-bilingual` and showed the pre-fork
  layout (Chinese body with English underneath), which is the opposite of what this fork does.
- README gained an **Install** section with the `dsh plugin --profile desktop add github:...`
  command and the "quit normally, then reopen" step the host half needs.

## [1.0.1] — 2026-11-18

A correctness release: bilingual subtitles reach the assistant side again, mixed-language paragraphs
are translated instead of silently skipped, and a Chinese sentence that embeds an English identifier
can no longer trap the composer.

### Fixed

- **Assistant subtitles never rendered.** Translations were fetched and cached, but the renderer
  looked them up under a key without the target-language suffix, so nothing matched and the reply
  stayed English. `decorate()` now falls back to the suffix-free key and `translationsFor()` writes
  both keys, so cached subtitles render.
- **Mixed paragraphs were skipped wholesale.** A single Han character (or one full-width punctuation
  mark) made a paragraph "Chinese", which the client then treated as already being in the display
  language. Language is now decided by the dominant script: Latin text needs at least 8 letters, a
  Han share of at most 0.35, and at least two English function words (`ENGLISH_HINTS`).
- **The host misjudged "already English" by letter count.** `帮我装插件hermes-loop` (10 Latin letters
  against 5 Han characters) was passed through untranslated. The host now uses the same
  `looksEnglish()` rule as the client: no CJK text passes, but text containing CJK must hit two
  English function words before it counts as English.
- **An unusable translation swallowed the send forever.** When the translation came back identical to
  the draft, the client cleared the pending state but left `shadow.error` empty, so the send gate kept
  consuming Enter without ever sending. That branch now sets a failure state, the panel says
  `翻译失败，将发送原文`, and the next Enter sends the original text.
- **Han-with-long-identifier text produced a 502.** A Chinese paragraph containing a long Latin
  identifier crossed the old 0.5 share threshold and was sent for translation, where an unchanged
  reply was rejected as invalid. "Already in the target language" is now decided at a 0.3 share, so
  such paragraphs pass through instead of failing.

### Changed

- Text as a whole is classified once per unit, then translated per target; paragraphs that are
  already in the target language are passed through without a model request or an API key.
- The host exposes a `logic` marker on `/api/shadow-bilingual/health` so a stale host can be detected
  without guessing.

### Removed

- `scripts/restart-dsh.sh`. It quit the app, waited, then `SIGTERM`-ed the host process, which made
  Electron report an unexpected stop and show its crash dialog — the cause of the 2026-11-17 restart
  loop. It is replaced by `scripts/apply-changes.sh`, which only reads: it rebuilds the client bundle
  and reports whether the running host is stale, exiting `2` with the safe remedy (quit normally, then
  reopen). Nothing in this repo signals the app.

## [1.0.0] — 2026-11-17

First published cut of the fork: English-only conversation with bilingual display.

### Added

- Assistant replies keep their English body and gain a subtitle in the local display language.
- User messages show the local-language original under the English text that was actually sent.
- `发送译文` checkbox (on by default) in the composer dock.
- Local-language input in the three send paths — composer, steer note (`dsh-steer-note`), and the
  queued-message inbox — is rewritten to English before it leaves; nothing non-English reaches the
  model.
- Live English shadow preview under the draft, with per-paragraph diffing and cached paragraphs.
- Send gate: nothing is submitted before the translation is ready, which prevents the
  "original first, English second" double send.
- Any of 18 local display languages, switchable in Settings → 双语; translations are cached per target
  language.
- System-prompt section `bilingual:response-language` keeps the model answering in English.
