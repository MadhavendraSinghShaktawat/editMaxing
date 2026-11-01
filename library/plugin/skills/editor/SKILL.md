---
name: editor
description: The full five-stage video edit in Shifu Dojo. Use at the start of any request to edit a video, and whenever you need to know which stage comes next.
---

# The edit

You are one editor doing the whole video. Work through the stages yourself. Don't hand stages to subagents, because each one starts cold and costs more.

Every change goes through the Edit Document. Words are the anchor, so a change to one stage never breaks another.

## Before you start

1. Call `open_footage` with the main video in `inputs/`. It transcribes on this Mac and saves version 1.
2. Read the mode, style and memory rules in your instructions. They were decided once. Don't ask about them again.
3. If a reference is attached and no style is selected, use the `reference-style` skill first.

Before each stage, call `set_stage`. It moves you around the studio and tells the user where you are.

## Stage 1: A-cuts (`cutting`)

1. Call `analyze_takes`. It lists repeated takes, false starts and fillers with word ranges.
2. Read `get_edit_doc` and judge each one. Keep the last clean take unless an earlier one is clearly better.
3. Remove with `edit_ops`. Use `set_max_pause` for dead air.
4. Keep intentional pauses with `keep_pause`. A pause is intentional when it follows a hard truth, a question, a punchline or a moment of feeling. Dead air is a pause with no weight: searching for a word, or a stumble.

A pause you aren't sure about stays in. Log it with `log_call`.

## Stage 2: B-roll (`broll`)

Use the `broll-director` skill.

## Stage 3: Captions and animation (`captions`)

Use `edit_ops` with `set_captions`. Take size, words per line, casing and colour from the style. Check that captions don't cover a face or on-screen text.

## Stage 4: Motion graphics (`graphics`)

Only where a picture explains better than a face: numbers, processes, comparisons, chapter changes. Pick one skill and stay with it for the video:

- `explainer-default`, `explainer-engaging` or `explainer-high-energy` for full explainers
- `motion-broll` for clips timed to the speaker's words

Motion clips live in `motion/`. Playwright is already linked in `motion/node_modules`, so `setup.sh` won't install anything. Add each finished clip with `add_graphic`, using the transparent `.mov` when there is one.

When a clip needs the speaker cut out, call `remove_background` and use the file it returns. Never run `object-separation` unless `remove_background` can't isolate the subject, as with a product rather than a person.

## Stage 5: Sound (`sound`)

1. Use the `sound-effects` skill and the bundled kit, or `epidemic` tools when they're connected.
2. You can't hear. Use the `earshot` tools before you say anything about how audio sounds, and quote the reading.
3. Add effects with `add_sfx` on a word, and music with `add_music`. Music ducks under speech by default.

## Finish

1. Call `render_preview` and check it with `view_frames`, at a few moments that matter.
2. Call `render_final`. It renders, runs the quality check and writes the MP4, SRT and FCPXML.
3. If the quality check fails, fix it and render again.
4. Call `set_stage` with `review`, then give a short summary: what you made, and the calls worth checking.

## Fixes after review

Treat each note as a change to the Edit Document, make it with `edit_ops`, and render again. `restore_version` brings back any earlier version.
