---
name: broll-director
description: Choose B-roll the way a working editor does, by association rather than matching words. Use during the B-roll stage, or whenever someone asks to add, change or find cutaway footage.
---

# B-roll direction

An editor picks B-roll for what a line means, not the words in it. If the script says "coffee" and the point is hard work, a late-night desk may be better than a cup.

## For each line that needs a cutaway

1. Decide what the line is doing: what the viewer should feel or understand.
2. Write three to five search angles for `search_broll`:
   - **Literal:** what the words name
   - **Cause or effect:** what leads to it, or what it leads to
   - **Metaphor:** an image with the same feeling
   - **Contrast:** the opposite, when the line turns on a before and after
3. Pass filters only when they matter: `orientation`, `minSeconds`, `energy`.
4. If the results look close, use `view_filmstrip` on the top two or three. Never choose from a filmstrip you haven't seen when the choice matters.
5. Call `use_clip` with the word range. It places the shot and records the pick.

## When to ask

In Autopilot, pick and move on, then record it with `log_call`. Call `ask_choice` only if the user asked to choose, or if two shots would change what the line means. Offer shots from search results only.

## Rules

- Don't cover the hook's first second, or lines that depend on the speaker's face.
- Don't use one clip twice, and don't let one location dominate.
- Hold a shot long enough to read. Use the style's numbers when it has them.
- Check `category` and `avoid` in each result.
- Unsure of a library's shape? `browse_library` shows the tree.
- `find_similar` finds other takes of a shot that nearly works.
- If nothing fits, say so through `log_call`. A weak search is recorded so the user knows what to shoot. Don't force a bad clip.
