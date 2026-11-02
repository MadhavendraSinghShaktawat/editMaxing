# Shared styles

Editing styles made by [Shifu Dojo](../../README.md) users and shared with everyone.

Shifu Dojo comes with no built-in styles. You make your own in the app from one reference video, and the best ones are added to this folder. Every style here shows up in everyone's Styles board, with its author's name on it.

## Add your style

Approve your style in the app, and try it on footage of someone else first. Then, from a clone of this repo on the same Mac:

```bash
npm install
npm run style -- list
npm run style -- add "Your Style" --author "Your Name"
npm run style -- check && npm test
```

This writes `library/styles/<your-style>/style.json`. Commit that folder and open a pull request using the [style template](https://github.com/MadhavendraSinghShaktawat/editMaxing/compare/main...?quick_pull=1&template=style.md). Send one style per pull request.

## Rules

- No reference videos or frames from them.
- No footage of people who haven't agreed to it.
- No client names or anything under NDA.
- No colour grading, for now.

The maintainer decides what gets merged.

<details>
<summary><b>If the check fails</b></summary>
<br />

| The check says | What to do |
|---|---|
| `Add an author, so the style has a sensei.` | Pass `--author "Your Name"` |
| `… has no summary. Every area must be filled in.` | Fill that area in, in the app, or learn the style again |
| `It contains a file path from someone's computer.` | Remove the path from `style.json` |
| `A rule mentions colour grading` | Delete that rule |
| `"Name" is still a draft.` | Press **Approve this style** in the app |
| `There's no saved style called "Name".` | Run `npm run style -- list` for the exact name |

</details>
