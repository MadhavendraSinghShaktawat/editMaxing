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
- [~] Each card records the shot's role (literal, proof, metaphor, contrast, list, texture) and the layouts it fits; search can filter on both, and older cards without them still match (schema and filters tested; needs a real batch of cards)

## 7. Style DNA and memory
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

## 10. Teams, Studio Hub and smarter memory
- [x] Studio mode in Settings: Single user (default), Studio Hub, or Join a Hub. Owner only, from the Mac app on the Hub
- [x] Versioned migration: everything already on a Mac belongs to one Owner, with a "My B-roll" library (tested on a copy of a real studio)
- [x] Members with Owner, Admin and Editor roles. Only the Owner hands out admin rights
- [x] One-time invite links that expire in 7 days. The token sits after `#` and only its SHA-256 hash is stored
- [x] Passkey sign-in with SimpleWebAuthn: discoverable credentials, user verification required, `none` attestation
- [x] Sessions in an HttpOnly, SameSite=Strict cookie (`__Host-` and Secure on https), 30-day sliding expiry, revocable per device
- [x] Origin check on every change made with a cookie, Host allow-list, rate limits on sign-in, no-frame and no-plugin headers
- [x] Every request knows its person. Chats, Claude accounts, jobs, files, recipes and usage are private to their owner
- [x] Live events only reach the person they belong to
- [x] Admin Team section: invites, roles, removal, devices, clients and an activity log
- [x] Admin Users section: view and remove any member's chats, styles, memory, libraries and recipes, all logged. No editing
- [x] Members are told admins can see their work, on the invite page and in My account
- [x] Closing a Hub: 14 days to export, then access ends and data is archived, not deleted
- [x] Export of a person's work as a zip (chats with finished files, memory, styles, recipes, B-roll list)
- [x] Everyone brings their own Claude login. A chat can only run on an account its person owns. Epidemic keys are per person
- [x] Personal B-roll libraries, shared by their owner with chosen colleagues or the whole team, as "use" or "add"
- [x] A clip is analysed once however many libraries hold it; near-copies borrow the original's card without exposing it
- [x] Styles share the same way, as "use" or "edit"
- [x] Memory at three levels: personal, client, team. The most specific wins. Clients are created and assigned by admins
- [x] Memory learns with a small Claude call on the person's own login, after a chat goes quiet, from their messages, B-roll picks and version restores only
- [x] Lessons are suggestions until kept in one tap, or until they come up twice. Contradictions replace old rules; missed rules are flagged; unused rules are set aside after 120 days
- [x] B-roll taste: picks against the options passed over become taste rules, and ranking learns per person. With enough taste, the editor asks less
- [x] Admins see personal rules three or more people learned, and can make them team rules
- [~] Company Google Shared Drive through a service account: shared libraries upload with resumable chunks (signing and chunk flow tested with fakes; needs a real service account and Shared Drive)
- [~] Tailscale integration: status, use its https name as the Hub address, turn Tailscale Serve on or off (needs Tailscale installed)
- [~] On a Hub, teammates' editors run in Claude Code's sandbox and can't read other people's files (needs a real teammate chat, including a Motion render inside the sandbox)
- [~] Claude sign-in for a teammate on another computer, by pasting Claude's code back (needs a real remote sign-in)
- [~] Passkeys on the real Hub address (tested up to the passkey challenge on localhost; needs the https subdomain)
- [ ] A Mac member working locally with sync to the Hub. Needs a reachable Hub to build against; not started

## 11. Motion library
- [x] Versioned migration 3: Motion library tables, a "motion" share type, and the six built-in Edit Modes removed (stored mode values cleared, so old mode-only memory now applies everywhere)
- [x] Taxonomy by mechanism, not look: Operation → Domain → Technique → Execution, from a seed list added on every start
- [x] Claude proposes a technique the list doesn't have; near-duplicate names map to the existing one; admins approve or merge proposals
- [~] Learning a style also saves every animation in its frame sequences as a short loop, poster and filmstrip with a rebuild spec, plus the caption preset and one thumbnail frame. Only moments Claude saw as a sequence are kept (checks tested; needs a real reference run on a signed-in account)
- [x] Search text and full-text index per item; OpenRouter embeddings when a key is set
- [x] `suggest_animations` gives 3 to 5 options, one per technique, lifted by the chat's style and the person's past picks
- [x] Editor tools: suggest_animations, view_animation, browse_motion, get_caption_preset; ask_choice shows loops; brief_motion_agent carries chosen examples to the Motion agent
- [x] Shared like styles: private, then "use" or "edit" for chosen colleagues or the team; admins view and remove, logged
- [x] Motion board, a Style's saved animations and thumbnail, Sharing and Users sections in Settings
- [ ] Motion library items aren't part of `npm run style -- add`, because they're cut from someone's reference

## 12. Scrape Creators
- [x] Each person adds their own Scrape Creators API key in My account. It's checked with the free credit-balance call before it's saved, and stored in the Keychain
- [x] Paste a social link as raw footage or a reference in New video, or to learn a new style. The engine checks the link first, so an unsupported one is refused with the reason and costs nothing
- [x] Supported: TikTok, Instagram, Facebook, X, Threads, Reddit, Snapchat Spotlight, Pinterest, Bluesky, Truth Social, Twitch clips, Kick clips, Rumble. YouTube and LinkedIn are refused, because Scrape Creators returns only their details
- [x] Finds the video file in each response (no-watermark TikTok, HD Facebook, the highest-bitrate MP4 on X, Reddit's stream with sound), downloads it to the file store, and checks it has video
- [x] Only public https files are downloaded, and every redirect is checked, so a response can't point the engine at a private address
- [x] If the platform's CDN refuses, TikTok, Instagram and Truth Social retry once with Scrape Creators' permanent copy (about 10 credits)
- [~] Downloading from the CDN was tested with a real Instagram reel; the Scrape Creators API calls were tested with recorded and fake responses (needs a real key, and real video posts on X, Threads, Reddit, Snapchat, Pinterest, Bluesky, Twitch, Kick and Rumble, whose video fields the docs don't show)
- [~] Optional hosted Scrape Creators MCP in chats, turned on per person in Integrations, with the key passed through the environment as `x-api-key` (needs a real key)

## 13. Several raw clips and scripts
- [x] New video takes many raw clips: dropped files, a Google Drive file or a whole shared folder (subfolders too), or social links. With no Drive connected, everything downloads to this Mac
- [x] Public Drive folders are listed without a Google key; the studio key is used when set (tested live on a 29-clip folder)
- [x] Optional script, pasted or uploaded (.txt, .md, .docx, .doc, .rtf, .odt through macOS textutil). The editor follows it line by line and says which lines it couldn't find
- [x] `read_clips` transcribes every clip on this Mac and returns timed lines; `assemble_story` checks every take against its clip and joins them, at the first clip's size and frame rate, into the main footage (tested with mixed sizes, frame rates and a silent clip)
- [~] The editor choosing the best takes across many clips (needs a real multi-clip edit)

## 14. Several references, drafts and downloads that resume
- [x] New video takes several reference videos (files, Drive files and folders, social links), each optionally marked for editing, motion graphics, explainer graphics, captions or sound. The editor and the Motion agent use each for what it's marked for
- [x] Fixed: a message could only carry 20 attachments, so a large Drive folder lost clips. Now up to 200
- [~] Styles board learns one style from up to 5 videos; every rule cites which video it came from and is checked against that video (verification tested; needs a real multi-video run)
- [x] Mix saved styles: pick which style each area comes from. No analysis; starts as a draft. Mixed styles find their parents' animations and caption preset
- [x] New video and New style keep a draft in the engine per person, saved as you go, restored on open, cleared on start or Discard
- [x] Pasted links download as background jobs in their own lane, keep going when the window closes, and resume from the last byte after a crash (tested live: the engine was killed at 18.7 MB of a 134 MB Drive clip and finished from there)
- [x] A link already fetched returns its file at once; the same link pasted again joins the running download
- [x] Dropped files are fingerprinted (name, size, date, first and last 4 MB) and skipped if that person uploaded them before

## 15. Compact context (as in T3 Code)
- [x] Context-window meter beside Send: a ring, and a popup with "Context Window", percent and tokens used of the window, the auto-compact line, and **Compact context** (disabled while the editor is working)
- [x] `/compact` typed in the chat runs Claude Code's own compact
- [x] Each compaction is a divider in the chat: "Compacting context", then "Context compacted 412k → 38k tokens", or "Context compaction failed"
- [x] A chat over 200,000 tokens that comes back after Claude's prompt cache expired (about an hour on a subscription, 5 minutes with an API key) shows a **Compact** chip by Send; Send becomes **Compact and send**, and the chip switches to **Keep**
- [x] The context reading comes from Claude Code after each turn and each compaction (checked on a real session: `/compact` emits compacting, success and the boundary with before and after tokens)
- [ ] Not built: T3 Code's "Auto-compact after" setting and "Compact idle threads" (Before the cache expires / When you return / Never)

## 16. Agents survive closing the app (as in T3 Code)
- [~] The engine runs as a launchd login service (`com.socialshifu.dojo.engine`), not as the app's child, so closing the window, quitting or a crashed app never stops editors. launchd starts it at login and again after a crash; logs go to `~/Library/Logs/Shifu Dojo/engine.log` (compiles; needs a real install)
- [~] After an update the app restarts an older engine, asking first when editors are working (needs a real install)
- [~] Closing the window keeps the app in the menu bar: who's working, Open Studio, Open in Browser, Stop or Start the engine (compiles; needs a real install)
- [x] After a restart, each cut-off turn continues by itself with T3 Code's "Continue where you left off…" message; Motion agent work that died is named so it's started again; the chat says "Shifu Dojo restarted and resumed this turn"
- [x] A chat that restarts 3 times within 5 minutes stops continuing and waits for a message
- [x] Awaited work a restart orphaned, like a render, is closed instead of showing as running forever
- [x] Settings → This Mac shows the background engine and who's working, with Stop for the Owner

## 17. Spawned agents get a watch-only chat
- [x] When a chat starts an agent (the Motion agent today), it appears as its own chat and character, named "Motion agent", showing its words and every step live, with "Started by Kai · watch only" and Open Kai
- [x] It can't be written to: no message box, and the engine refuses messages, compact, settings, stop, end and restore for it, pointing back to the starting chat. Its approvals still appear in the starting chat
- [x] The starting chat's "The Motion agent started building" line has Watch, which opens it
- [x] It shows Finished or Stopped when the agent ends; ending the starting chat ends it; after a restart it says it stopped
- [x] Spawned agents don't take one of the 8 studio seats

## Rules for this build
- Claude's own login flow only. No token handling, no shared logins, no rotation.
- Every Claude call uses the unmodified `claude` binary.
- Local tools run without AI wherever a measurement can answer the question.
- Anything unverified is marked as unverified in the final report.
