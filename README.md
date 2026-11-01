# Shifu Dojo

An AI video editing studio for the Social Shifu team. Each editor in the villa is one Claude chat, and several can work at once. There is no timeline: you direct the edit through chat, and editors only stop for publishing, paying or deleting source footage.

Everything runs on your own Mac. The Mac app and the web page are two windows onto the same local engine.

## What you need on the Mac

- macOS 26 or newer on Apple Silicon. Word-timed transcripts use Apple's SpeechAnalyzer, which starts in macOS 26.
- [Claude Code](https://code.claude.com), signed in
- ffmpeg: `brew install ffmpeg`

Python 3.10 or newer is needed for the Earshot and Motion packs: `brew install python@3.13`. Install packs in **Settings > Tool packs**.

## Mac app

```bash
./scripts/build-mac.sh
```

This creates `build/Shifu Dojo.app` and `build/ShifuDojo.dmg`. The app starts the engine when it opens and stops it when it quits. **Studio > Open in Browser** opens the same studio, already signed in.

The build is ad-hoc signed, so it runs on the Mac that built it. Sharing it with teammates needs an Apple Developer ID and notarization.

## Running from source

```bash
npm install
swift build -c release --package-path mac --product dojo-native
npm run build
npm run engine
```

Open the address the engine prints. It contains this Mac's sign-in link. For frontend work, leave the engine running and use `npm run dev`, which signs requests for you.

Add `?demo` to the address to see a sample crew with no engine data.

| Command | What it does |
| --- | --- |
| `npm run engine` | Starts the local engine on port 51791 |
| `npm test` | Runs the engine tests |
| `npx tsc -p engine/tsconfig.json` | Type-checks the engine |

## Accounts

Each Claude account signs in through Claude's own login page and gets its own config folder. Dojo never reads or stores a token. You choose the account for each chat, and limits for every account appear together. Dojo never moves a chat between accounts.

## Keys

Add these in **Settings**. They go to the macOS Keychain and are never shown again.

| Key | Used for | Needed? |
| --- | --- | --- |
| OpenRouter | Embeddings for B-roll meaning search. Only text is sent. | For meaning search. Keyword search works without it. |
| Google | Listing Drive folders | Only for folder links. File links work without it. |
| Epidemic Sound | Music and effects | Optional. Bundled CC0 effects are always free. |

## Project layout

| Path | Role |
| --- | --- |
| `engine/src/` | Local TypeScript engine: accounts, chats, jobs, tools, library, styles, render |
| `engine/src/claude/` | Accounts, chat runtime and permission policy |
| `engine/test/` | Engine tests |
| `library/plugin/` | The Claude Code plugin with every skill. See `NOTICE.md` for credits. |
| `mac/Sources/DojoNative/` | Swift tools: background removal, transcription, frame analysis, captions, depth, parallax |
| `mac/Sources/ShifuDojo/` | Mac app that runs the engine and hosts the studio |
| `src/sim/` | Engine client and the store that drives the world |
| `src/components/` | Top bar, chat, decision cards and boards |
| `src/world3d/`, `src/world/` | 3D world, characters and pathfinding |

See `BACKEND.md` for what is built and what still needs a real-world test.
