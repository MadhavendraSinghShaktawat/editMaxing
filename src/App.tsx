import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { BoardId, Crew, Dock, EmptyStudio, TopBar } from "./components/Hud";
import { Board, NewMission, Review, Toast } from "./components/Modals";
import { WorldCanvas } from "./components/WorldCanvas";
import { useStore } from "./sim/store";

export default function App() {
  const s = useStore();
  const [mission, setMission] = useState(false);
  const [board, setBoard] = useState<BoardId | null>(null);
  const [review, setReview] = useState<string | null>(null);
  const closeMission = useCallback(() => setMission(false), []);
  const closeBoard = useCallback(() => setBoard(null), []);
  const closeReview = useCallback(() => setReview(null), []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.newChat();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [s]);

  return (
    <main className="app">
      <WorldCanvas panelOpen={!!s.selectedId} />
      <TopBar />
      <Crew />
      <EmptyStudio />
      <ChatPanel onReview={setReview} onVideo={() => setMission(true)} />
      <Dock onBoard={setBoard} />
      <Toast />
      {mission && <NewMission onClose={closeMission} />}
      {board && <Board id={board} onClose={closeBoard} />}
      {review && <Review id={review} onClose={closeReview} />}
    </main>
  );
}
