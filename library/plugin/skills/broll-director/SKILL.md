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
3. Pass filters only when they matter: `orientation`, `minSeconds`, `energy`, and:
   - `role`, the job the shot must do: `literal`, `proof` (a screen, document, result or number that backs the claim), `metaphor`, `contrast`, `list` (one of a set, for montages and steps) or `texture` (atmosphere for a breath).
   - `layout`, when it won't be full screen: `split_half`, `picture_in_picture`, `behind_subject` or `background_plate`.
   Older shots have no role, so they always pass these filters.
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

## Envato Elements

When `envato` tools are connected and the library has nothing that fits, search Envato Elements with `search_stock_video` (or `search_video_templates` for a designed moment). Envato only searches. You can't download or place an Envato item.

- Search with the line's meaning, not its words, the same way you search the library.
- In the `log_call` for that line, give up to three items, each with its title and Envato link, and say which one you'd use.
- In your summary, ask the user to download the ones they want into the B-roll library. Once they're analyzed, search the library again and place them.
- Never describe an Envato item as placed, and never use a frame from its preview.
