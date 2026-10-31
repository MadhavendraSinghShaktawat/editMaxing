# Shifu Dojo: frontend to-do

Platform: web app (React, TypeScript, Vite, Three.js), plus a native Swift Mac app that hosts the same UI.
Scope: UI only. All data is mock data and the simulation is local.

## World
- [x] Rebuilt in real 3D with an angled 2.5D camera
- [x] Bali lagoon founder's villa, cutaway rooms, golden thatch, teal water
- [x] Rooms: Library, Cutting Room, Animation, Captions, Living Room, Sound Room
- [x] Outdoor spots: Render Shed, Review Bale, hammock, deck, dock
- [x] Animated water, light rays, tree sway, day and night cycle, lanterns
- [x] Ambient life: black cat, koi, ducks, butterflies, birds, fireflies, smoke, petals
- [x] Click interactions: cat, trees, water, stations; drag to pan, scroll to zoom

## Video editors
- [x] Each editor is one chat, working at the same time as the others
- [x] Unique 3D characters with name tags and walking, typing, thinking, reading, coffee, chatting, celebrating, resting, stuck and "needs you" states
- [x] Status bubble over each head that shows the live state
- [x] Pathfinding between rooms, one editor moving through all stages
- [x] New editors arrive by boat

## HUD
- [x] Top bar life bars: 5-hour session, weekly, weekly Fable
- [x] Account picker and world clock
- [x] Crew roster with live state and stage progress
- [x] Right-side chat with agent picker
- [x] B-roll decision cards with select-only options
- [x] New mission flow: drop video, pick style, one line of why, Go
- [x] Review screen: preview, click to comment, Review list, versions
- [x] Boards: Styles, Prompts, B-roll Library, Tools

## Attachments and models
- [x] Attach reference videos by drag, paste or file picker, as T3 Code does
- [x] Real video thumbnail and duration, Send locked until the file is added
- [x] Reference video option in the New Video flow
- [x] Model and effort picker per chat, using Claude Code's models

## Mac app
- [x] Native Swift app with a local server on 127.0.0.1 only
- [x] Open in Browser, Copy Studio Address, Reload
- [x] Native file picker for file buttons
- [x] App icon, app bundle and DMG

## Chats and themes
- [x] Studio starts empty; each new chat brings in its editor
- [x] End chat sends the editor home, with a limit of 8
- [x] Neutral chat UI using Google Sans and Inter
- [x] Day, Evening and Night themes, saved between visits

## Finish
- [x] Reduced motion support
- [x] Check in a real browser at laptop and large desktop sizes
- [x] Production build passes
