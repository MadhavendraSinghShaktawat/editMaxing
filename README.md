# Shifu Dojo

An AI video editing studio. Each editor in the villa is one chat, working at the same time as the others.

This is the frontend only. Usage bars, chats, uploads and video previews are simulated.

The studio starts empty. **New chat** (Cmd+K) brings in a new editor, and ending a chat sends them home. Add `?demo` to the address to see a full sample crew. Use the top bar to switch between Day, Evening and Night.

## Web app

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Mac app

Needs Xcode command line tools. This builds the web UI, compiles the Swift app and creates a DMG:

```bash
./scripts/build-mac.sh
```

The app and DMG land in `build/`.

Inside the app, **Studio > Open in Browser** opens the same studio in your browser. Both use one web UI, so a design change only happens once.

The build is ad-hoc signed, so it runs on the Mac that built it. Sharing it with other people needs an Apple Developer ID and notarization.

## Project layout

| Path | Role |
| --- | --- |
| `src/world3d/` | 3D world, characters, lighting and post-processing |
| `src/world/` | Map layout and pathfinding |
| `src/sim/` | Simulated editors, missions and usage |
| `src/components/` | Top bar, crew, chat, model picker, attachments and boards |
| `mac/` | Swift app with a loopback-only local server |
