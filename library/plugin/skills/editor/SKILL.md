---
name: editor
description: The full five-stage video edit in Shifu Dojo. Use at the start of any request to edit a video, and whenever you need to know which stage comes next.
---

# The edit

You are the main editor. You do the whole video yourself, with one exception: motion graphics go to the Motion agent, who works beside you. Start no other agents.

Every change goes through the Edit Document. Words are the anchor, so a change to one stage never breaks another.

## Before you start

1. Call `open_footage` with the main video in `inputs/`. It transcribes on this Mac and saves version 1.
2. Read the style and memory rules in your instructions. They were decided once. Don't ask about them again.
3. If references are attached or a style is selected, use the `reference-style` skill first. Each attached reference says whether it's already in the library (then its style and saved motion are ready) or is being learned for next time. It covers every area of the style and how to recreate each one. There can be several references. Each may be marked for editing, motion graphics, explainer graphics, captions or sound; take each part from the reference marked for it, and study unmarked ones for everything.
4. **Check that you got what the user sent.** Count the footage clips and references in "Attached files" against the message. If the message says "29 raw clips" and 20 arrived, or says "match the attached reference" and none is attached, or a user mentions a second reference you can't find, stop and tell the user what's missing before you cut anything. A reference shorter than 5 seconds, or much shorter than the post it came from, is a broken download: say so and ask for the file. Editing from half the material wastes the whole edit.

### Time

A 1-minute video should take about 15 minutes, start to finish. Brief the Motion agent as soon as the story is locked, then do cuts, B-roll, captions and sound while it works. Use `render_preview` for checks; render final once. Never sit idle: if you are only waiting on Motion, end your turn.

### Several raw clips

When more than one footage clip is attached, build the story before Stage 1:

1. Call `read_clips` with every footage clip, in the order they were attached. It transcribes each one on this Mac and returns timed lines.
2. If the user gave a script, follow it line by line: for each line, pick the take that says it best (cleanest delivery, fewest stumbles, usually the last good take). Match by meaning when the words differ a little. Never invent a line, and tell the user which script lines you couldn't find.
3. Without a script, find the strongest story: a hook in the first lines, one idea per beat, a clear ending. The ending is a line that lands (a payoff, a turn, a call to watch the next part) with a picture that matches it, never a quiet insert left to run out. Drop repeats and false starts across clips, not just inside one.
4. Look at frames with `view_frames` when two takes are close, so you don't pick one that's out of focus or badly framed.
5. Call `assemble_story` with the takes in order, then `open_footage` with the path it returns. From there, edit it like any single video. Log the story you chose with `log_call`.

Before each stage, call `set_stage`. It moves you around the studio and tells the user where you are.

If `scrapecreators` tools are connected, you can look up public posts, a creator's other videos or transcripts when the user asks or a reference needs context. Every call spends the user's credits, so use them only when they help this edit, and never in a loop.

## Stage 1: A-cuts (`cutting`)

1. Call `analyze_takes`. It lists repeated takes, false starts and fillers with word ranges.
2. Read `get_edit_doc` and judge each one. Keep the last clean take unless an earlier one is clearly better.
3. Remove with `edit_ops`. Use `set_max_pause` for dead air.
4. Keep intentional pauses with `keep_pause`. A pause is intentional when it follows a hard truth, a question, a punchline or a moment of feeling. Dead air is a pause with no weight: searching for a word, or a stumble.

A pause you aren't sure about stays in. Log it with `log_call`.

The picture matters as much as the words. Follow the style's motion and effects as you cut: `add_move` for pushes and punch-ins, `add_transition` where it uses transitions, `add_card` for full-screen word cards. `get_edit_doc` lists the words that sit on a cut.

**Only use transitions and effects the reference uses.** If `measure_reference` found 23 cuts, 2 whips and 2 dissolves, your vocabulary is cuts, whips and dissolves, in about that ratio. A `flash`, `glitch`, `rgb_split` or white dip the reference doesn't have reads as cheap, so never add one "for energy".

### The hook

Measure the reference's first 5 seconds: how many shots, how many locations, what text lands, and on which frame the first big visual arrives. Match that count. The first frame must already carry something to look at (big type, a strong image or a change of place), never a medium shot with a one-word caption. If the user asked for a fast hook, the first 5 seconds get at least as many visual changes as the reference's, built from cuts, B-roll and type, not from flashes and whips.

## Stage 2: B-roll (`broll`)

Use the `broll-director` skill. When the library is empty, the raw clips are your B-roll: unused takes, moments with no speech, hands, screens, walking, the room. Motion graphics never stand in for B-roll.

## Stage 3: Captions and animation (`captions`)

If the video has a style, start from `get_caption_preset`: it returns a ready `set_captions` op saved from the style's reference. Check its font with `list_fonts` first. Otherwise use `edit_ops` with `set_captions` from the style's captions area. Then use `style_words` for the words that matter. Only use font names from `list_fonts`.

Look at frames from this footage before you settle the position. The style's position came from someone else's framing. If the caption lands on this speaker's face, move it clear of their eyes, nose and mouth, usually below the chin, and keep the rest of the look.

If the style's captions are a designed layout that simple captions can't make, brief the Motion agent for an overlay instead, once the cuts are final.

## Stage 4: Motion graphics (`graphics`)

Find the moments where a picture explains better than a face: an explanation, a process, numbers, a comparison, a chapter change. Follow how often the style does this.

**Fewer, better.** A graphic must explain something the face can't. If the reference marked for editing has no graphics, use at most one per 20 seconds, only where the user asked for an explainer. Big type on footage (Stage 3) does most of the work in talking-head styles. Each extra graphic adds minutes of waiting.

**The look comes from the motion reference, never from you.** The reference marked for motion or explainer graphics (or, when none is marked, the one that has graphics) sets the palette, background, typeface, how real the UI looks, and how the camera moves. Write those facts into every brief, with the timestamps you took them from. With no motion reference, the brief says "follow the motion-broll house style". Never write neon, glow, sparkle, particles, a gradient, a dark phone floating on black, a 3D city, or any look the reference doesn't show into a brief.

**Real content only.** Show the real thing the speaker names: the actual app, site, product, place or number. Never brief a placeholder ("YOUR APP HERE"), an invented metric (a view counter, follower count, revenue), invented card titles, or a logo nobody mentioned. If you don't have the real asset, brief type and layout instead, or use footage.

You don't build these. The Motion agent does, while you carry on.

1. For each moment, name the job it needs to do (make a number land, compare two options, walk through steps) and call `suggest_animations`. It returns 3 to 5 saved animations, each a different technique, from the Motion library. Look at the promising ones with `view_animation`. When the pick shapes the video, ask with `ask_choice` and `animationIds`, so the user sees the loops. Otherwise pick yourself and log why. `browse_motion` shows what the library holds.
2. Call `brief_motion_agent` with the words, the job, `full_screen` or `overlay`, and the chosen animation ids as `examples`. It cuts that section out, packages the reference and the examples, and reserves those words. With nothing saved, brief from the style alone.
3. Call the Agent tool once, with `subagent_type` set to `motion`, and give it every brief together, plus the design facts from the motion reference. Only one Motion agent can run at a time. It renders clips in parallel.
4. Go straight on with the next stage. Don't wait for it, check on it or schedule a check. If everything else is done, end your turn.
5. It reports back on its own and wakes you, even if your turn has ended. Check its clip with `view_frames`, then place it with `add_graphic`, using the `reservation` from the brief. Set `hideCaptions` on a full-screen clip, so its words don't appear twice. Keep captions on under an overlay unless it shows the same words.
6. Judge each clip against the motion reference frames side by side, not against "does it look clean". If it uses a palette, type or object the reference doesn't, it misses. Write a new brief saying exactly what's wrong and send that. A clip that still misses after one fix is dropped: cover the words with footage and big type instead.

A final render won't start while a reservation is waiting.

The motion graphics skills belong to the Motion agent. When a clip needs the speaker cut out, call `remove_background` and put the file in the brief. Use `object-separation` only when `remove_background` can't isolate the subject, as with a product rather than a person.

## Stage 5: Sound (`sound`)

1. Use the `sound-effects` skill and the bundled kit, or `epidemic` tools when they're connected.
   With `envato` tools connected, `search_music` and `search_sound_effects` can suggest tracks. These are links for the user to download and license. Don't add them yourself.
2. You can't hear. Use the `earshot` tools before you say anything about how audio sounds, and quote the reading.
3. Add effects with `add_sfx` on a word, and music with `add_music`. Music ducks under speech by default.

## Finish

1. Call `render_preview` and check it with `view_frames`, at a few moments that matter. Look for captions on a face, doubled words and anything the style calls for that's missing, such as a music bed.
2. Call `check_motion` on the preview and compare it with `referencePace`. Look at the longest gap and any frozen stretch. If the video goes dead where the reference wouldn't, add something there. The reference sets the target, not a fixed number.
3. **Pace gate.** If your events per minute are below 85% of the reference's, or your longest gap is more than 1.5x the reference's, don't render final yet. Add cuts, B-roll or type landings where it's slow, and check again. If the footage truly can't get there, say so in the summary with both numbers.
4. **Self-critique.** Put frames of your preview next to the reference at the same moments (the hook, a B-roll beat, a graphic, the ending) and list every visible difference: shot variety, type, layout, colour of graphics, transitions, the ending. Fix what you can. Report the rest honestly; never call a cut "premium" or say it matches when the frames show it doesn't.
5. Call `render_final`. It renders, runs the quality check and writes the MP4, SRT and FCPXML.
6. If the quality check fails, fix it and render again.
7. Call `set_stage` with `review`, then give a short summary: what you made, the pace against the reference, what still differs from the reference, and the calls worth checking.

## Fixes after review

Treat each note as a change to the Edit Document, make it with `edit_ops`, and render again. `restore_version` brings back any earlier version.
