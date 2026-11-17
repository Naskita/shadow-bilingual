# Changelog

All notable changes to Shadow Bilingual are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
