---
name: motion-artist
description: How the Motion agent designs and builds premium motion graphics from a brief and a reference. For the Motion agent only.
---

# Motion graphics

You build one thing for one moment: a graphic that explains what the speaker is saying better than their face could, and holds attention while it does.

## Study before you design

1. Read the brief. Note the job, the exact length and size, and where the clip must be saved.
2. Watch the section. Read `section.mp4` frames with `view_frames`, and read `words.json`. Your timing comes from the speaker.
3. Study the reference. Open every sequence sheet the brief lists. Each row is one moment, six frames left to right, so compare neighbours. Read the style and measurements.
4. If the brief has "Examples to follow", study each one: `examples/N.jpg` shows the move frame by frame, `examples/N.mp4` is the loop, and `examples/N.json` has its rebuild spec (layer, timing, easing, stagger, what it lands on, and the steps). Rebuild the mechanism with this section's words and content. Don't copy the reference's subject or text.
5. Write down, in a few lines, what you learned about its motion language: how things enter, how they settle, how fast, what keeps moving, its type, and how much is on screen at once. Design from those notes.

The reference sets the taste. Everything below is a default for when it says nothing.

## What makes it premium

**Nothing is ever still.** While an element sits on screen it's still alive: a slow drift, a gentle camera push, a soft parallax between layers, a glow breathing. If you paused any frame, something should have been on its way somewhere. A clip that lands and then freezes looks like a slide.

**Something new keeps happening.** In a short video, the viewer should rarely wait more than a few seconds for a change. This isn't a number to hit. Use the reference's `pace` as your guide, and let the speaker's words set the beats.

**Motion is continuous, not stepped.** Things travel from where they were. One element becoming the next feels better than one disappearing and another appearing. Avoid a hard change unless the reference uses one on purpose.

**Movement has weight.** Use springs and ease-outs. Things accelerate, overshoot a touch, and settle. Linear movement looks like software. Parts of a group arrive in a slight stagger, never all at once.

**Motion blur is on.** `render.js` renders it. Fast movement without blur looks cheap, so don't work around it.

**Every beat lands on a word.** Clip time equals the word's `start` in `words.json`. A change that lands on the word feels like the speaker caused it.

**One idea.** Show the thing being said, using real objects from the line. Generous empty space, large type, little of it.

**Type is design.** Size contrast, weight contrast and careful spacing do most of the work. Match the reference's character.

**Never invent facts.** No numbers, names, quotes or results that aren't in the words or the brief.

## Build

Use the motion kit in `$DOJO_MOTION_KIT`. It draws every frame as a pure function of time, so renders are exact and have real motion blur.

Read `$DOJO_MOTION_KIT/reference/engine-api.md` before writing a clip, and look at `$DOJO_MOTION_KIT/examples/opus-aoe2/` for the quality bar. The kit's one-shape look is only a starting point. Its banned list doesn't apply when the reference does those things.

Work in `motion/`, which already has Playwright linked in `motion/node_modules`. Don't run `setup.sh`.

```bash
mkdir -p motion/clips motion/dist motion/work
# write motion/clips/<id>.html, with W, H and T from the brief, and bg:null for an overlay
python3 $DOJO_MOTION_KIT/engine/build.py motion/dist motion/clips/<id>.html
NODE_PATH=motion/node_modules node $DOJO_MOTION_KIT/engine/beats.js motion/dist/<id>.html motion/work/<id>.png 0.4 1.2 2.1
NODE_PATH=motion/node_modules node $DOJO_MOTION_KIT/engine/render.js motion/dist/<id>.html <output path from the brief> <fps from the brief>
```

- An overlay uses `bg:null` and saves to `.mov`, which keeps transparency.
- A full-screen clip saves to `.mp4`.
- Set `T` to the brief's length exactly.

Rendering is slow, because every frame is drawn four times. Wait for it. Never run it in the background.

## Check it yourself

1. Read the stills from `beats.js` before you render. Fix anything cramped, clipped, unreadable or off-word.
2. After rendering, look at frames with `view_frames`, including moments between beats. Those show whether things are really moving.
3. Call `check_motion` on the clip. Look at `longestGapSeconds` and `frozenStretches`, and compare them with `referencePace`. If part of the clip goes dead, add life there and render again.
4. Confirm the file exists at the path in the brief, at the right length.

## Report back

Give the path of each clip, its length, and one line on what it shows. If something couldn't be finished, say exactly what's missing.
