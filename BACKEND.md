# Shifu Dojo backend plan

The engine runs on the user's Mac. The web UI and the Mac app are clients of the same local service.

Status key: `[x]` built and tested on a real run, `[~]` built but not yet tested on a real run because it needs something Dojo doesn't have here (noted on the line).

## 1. Foundation
- [x] Local engine in TypeScript on Node 24, bound to 127.0.0.1 only
- [x] Per-install token, Host and Origin checks to block other websites reaching it
- [x] SQLite with WAL and FTS5, plus versioned migrations
- [x] Content-addressed file store keyed by SHA-256, so nothing is processed twice
- [x] Live events over SSE with replay after reconnect
- [x] Priority job queue: one heavy job at a time per Mac, cancellable and resumable
- [x] Doctor endpoint that checks claude, ffmpeg, Python and tool packs

## 2. Claude accounts (the main thing)
- [x] Each account gets its own `CLAUDE_CONFIG_DIR`
- [~] Sign-in runs Claude's own `claude auth login`. Dojo never reads or stores tokens (isolation tested; a full second sign-in needs a person at the browser)
- [x] Real 5-hour, weekly and per-model limits, per account
- [x] Real model and effort lists from `supportedModels()`, per account
- [x] Manual account choice per chat. No automatic rotation between accounts
- [~] API key mode for accounts that use a Console key, stored in macOS Keychain (needs a Console key)

## 3. Chats
- [x] One unmodified `claude` process per chat through the Agent SDK
- [x] Streaming replies, tool activity, interrupt and resume after restart
- [x] Per-chat model, effort and account
- [x] Questions become decision cards; hard-to-undo actions wait for approval
- [x] Autopilot: only publishing, paying or deleting source footage stop the edit
- [x] Review list of every call the editor made
- [x] Chats and messages survive a reload

## 4. Skills and hearing
- [x] Vendor the Barty-Bart motion-graphics skills under their MIT licence
- [x] Earshot installed as a tool pack and connected as an MCP server, so Claude can hear audio
- [x] Skills packaged as one Claude Code plugin and loaded per chat
- [x] Dojo skills: editor workflow, B-roll director, full style recreation (`reference-style`), Motion agent (`motion-artist`)

## 5. Native Mac tools (Swift, no paid API)
- [x] Video background removal with Vision, saved once as ProRes 4444 or HEVC with alpha
- [~] Word-timed transcripts with Apple SpeechAnalyzer, including Hindi (English tested; the Hindi model downloads and runs, accuracy on real Hindi speech not tried)
- [x] Frame analysis: on-screen text, faces, saliency, visual feature prints
- [x] Depth and parallax using a licence-safe model pack
- [x] 3D camera tracking using COLMAP

## 6. B-roll engine
- [~] Upload and Google Drive import with de-duplication by hash and perceptual hash (upload tested; Drive tested only with mocked responses, needs a real public link)
- [x] Shot detection, colours, motion, sharpness, on-screen text, faces, filmstrips
- [x] Claude writes meaning cards in growing batches of 10, 20, 30, 40
- [x] Usage estimate after the first 10, and the user picks how many to analyze
- [x] Editors go first: indexing pauses while chats work or usage is low
- [~] OpenRouter embeddings for meaning cards, text only (tested with mocked responses, needs a key; the default model is confirmed on OpenRouter)
- [x] Hybrid search: vector, keyword and filters, fused and diversified
- [x] Generated category tree that never needs re-embedding
- [x] Taste memory from picks and rejections
- [x] Tools for Claude: search_broll, browse_library, view_filmstrip, find_similar, use_clip, log_choice

## 7. Style DNA and memory
- [x] Edit Modes for tutorial, vlog, review and explainer on YouTube and Instagram
- [x] Reference analysis by Claude only, using local measurements as evidence
- [x] Every rule cites timestamps; rules that disagree with measurements get rechecked
- [x] Style Card approval before a style goes live
- [x] Style Card covers pacing, editing, audio, captions, positioning, motion, animation, effects and transitions. Colour grading is left out on purpose
- [x] Local measuring: every join and transition type, jump cuts, solid cards, camera moves (Apple Vision registration), punch-ins, pace, caption and framing stats, Earshot music, effects and sync
- [x] Claude sees movement as frame sequences, and a rule about movement must cite one
- [x] Main editor plus one background Motion agent, which receives the reference. No other agents can start
- [x] Editor controls: camera moves, cut transitions, solid cards, effects, placed and animated overlays, caption animation, per-word styling
- [x] `check_motion` compares a render's pace with the reference. No fixed target
- [x] The Mac stays awake while chats and jobs run
- [x] No built-in styles or prompts. Shared styles live in `library/styles/`, and `npm run style` packs and checks them
- [x] Personal Memory: repeated corrections become rules that can be edited or removed
- [x] Prompt Recipes

## 8. Edit Document and finishing
- [x] One word-anchored Edit Document with versions
- [x] A-roll analysis: fillers, retakes, dead air, candidate intentional pauses
- [x] Render: cuts, B-roll, graphics, captions, sound effects, music with ducking
- [x] Quality check: resolution, frame rate, loudness, duration
- [~] Export MP4, SRT and FCPXML for Resolve (files are written and parse; import into Resolve not tried)
- [~] Epidemic Sound through the user's own key, with the CC0 pack as the free path (CC0 path tested; key delivery tested against a local stand-in, needs a real key)

## 9. Connect the app
- [x] Replace the simulation with the real engine
- [x] Account screen, live life bars, real chat, real decision cards
- [x] Real uploads, tools, library, styles, recipes and review
- [x] Mac app starts and stops the engine

## Rules for this build
- Claude's own login flow only. No token handling, no shared logins, no rotation.
- Every Claude call uses the unmodified `claude` binary.
- Local tools run without AI wherever a measurement can answer the question.
- Anything unverified is marked as unverified in the final report.
