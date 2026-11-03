---
name: motion-artist
description: How the Motion agent designs and builds motion graphics that match a reference, fast. For the Motion agent only.
---

# Motion graphics

You build one thing for one moment: a graphic that explains what the speaker is saying better than their face could. It must look like it came from the same studio as the motion reference. A clean graphic in a different visual language is a failure, however polished.

## 1. Read the house rules (1 minute)

Read `$DOJO_MOTION_KIT/SKILL.md`, at least "Style defaults", "Banned" and "Gotchas", and `$DOJO_MOTION_KIT/reference/engine-api.md`. The house style is the default whenever the reference says nothing.

## 2. Study the reference and write the design sheet (3 minutes, once for all clips)

1. Read every brief. Note each job, length, size and output path.
2. Open every sequence sheet of the reference marked for motion or explainer graphics. If none is marked, use the one that has designed graphics. A talking-head reel whose only graphics are captions tells you about type and timing, not about how a graphic looks.
3. Write `motion/work/design.md` before any HTML, each line citing a reference time:
   - **Canvas:** background colour or footage, with sampled hex values.
   - **Palette:** 3 to 5 hex values and where each is used. Accent colours are used on single words or marks, not on surfaces.
   - **Type:** family feel (geometric, grotesk, serif), weight, case, size contrast, and how words arrive (typed, faded, blurred in, colour per word).
   - **Objects:** what is shown and how real it is (real app UI recreated faithfully, real logos, photos, simple shapes).
   - **Camera and transitions:** zooms into UI, pans, a cursor clicking, morphs from one state to the next, wipes.
   - **Density:** how much is on screen at once.
4. Every clip follows `design.md`. All clips share one system.

## 3. The slop list

These are what makes a graphic look AI-generated. Never use one unless the motion reference shows it at a time you can cite in `design.md`:

- neon, glow, bloom, lens flares, light leaks
- purple, violet, cyan or blue gradients, gradient buttons or bubbles, aurora blobs
- the four-point sparkle or star "AI" icon, particles, floating dots, star fields, confetti
- a dark phone or laptop mockup floating on black with a coloured glow behind it
- 3D CSS "cities", canyons or walls of screens
- glassmorphism cards, generic gradient app icons, emoji
- placeholder text ("YOUR APP HERE", "Lorem", "App name"), invented metrics (view counters, follower counts, revenue), invented card titles, logos nobody mentioned
- digit scrambles, odometers and glitch text whose in-between frames show garbled characters
- a duplicate "glint" or "shine" copy of a word sweeping across the frame

The brief can't override this list. If a brief asks for one of these and the reference doesn't show it, build it without that element and say so in your report.

## 4. What makes it premium

- **Real objects, faithfully drawn.** If the speaker names an app, a site or a product, recreate its real interface with its real colours and layout, the way a product explainer does. Show the thing, not a symbol of it.
- **Camera does the work.** Zoom into the part that matters, follow a cursor, pan to the next state. Slow camera drift keeps a held frame alive; decorative effects don't.
- **One state becomes the next.** Things travel and morph from where they were. Avoid elements simply disappearing and others appearing, unless the reference cuts hard on purpose.
- **Movement has weight.** Springs and ease-outs, at most a tiny overshoot, parts arriving in a slight stagger. Linear movement looks like software.
- **Every beat lands on a word.** Clip time equals the word's `start` in `words.json`.
- **One idea, little text, generous space.** Type is design: size and weight contrast do most of the work.
- **Never invent facts.** No numbers, names, quotes or results that aren't in the words or the brief.

## 5. Build, fast

Work in `motion/`, which already has Playwright linked in `motion/node_modules`. Don't run `setup.sh`.

1. Write all clips first: `motion/clips/<id>.html` with W, H and T from the brief (`bg:null` for an overlay), then `python3 $DOJO_MOTION_KIT/engine/build.py motion/dist motion/clips/<id>.html`.
2. Stills: `NODE_PATH=motion/node_modules node $DOJO_MOTION_KIT/engine/beats.js motion/dist/<id>.html motion/work/<id>.png <times>`. Fix anything cramped, clipped, unreadable, off-word or off the design sheet.
3. **Draft render every clip in parallel, in one command:**
   ```bash
   for id in a1 b2 c3; do NODE_PATH=motion/node_modules node $DOJO_MOTION_KIT/engine/render.js motion/dist/$id.html motion/work/$id-draft.mov <fps> draft & done; wait
   ```
   A draft skips motion blur and is about 4 times quicker. Look at it with `view_frames`, including frames between beats.
4. **Final render every clip in parallel**, the same way without `draft`, each to the output path in its brief (`motion/out/<id>.mov` or `.mp4`). An overlay saves to `.mov` (keeps transparency); a full-screen clip saves to `.mp4`. Set `T` to the brief's length exactly.

Always wait for your command to finish (`wait` at the end of the line). Never leave a render running after the command returns.

## 6. Check it yourself

1. Put a frame of each clip next to a reference frame and compare: palette, type, objects, density. Anything that wouldn't belong in the reference gets fixed.
2. Call `check_motion` on a clip only to find `frozenStretches`. Its `referencePace` is for the whole video, so a 3-second clip's events per minute or longest gap can't be compared with it. Don't re-render to chase those numbers.
3. One fix round per clip. If a clip still fails after that, report it as unfinished and say why, rather than rendering again and again.
4. Confirm each file exists at the path in the brief, at the right length.

## Report back

Give the path of each clip, its length, one line on what it shows, and which `design.md` lines it follows. Say plainly anything you left out from a brief and why.
