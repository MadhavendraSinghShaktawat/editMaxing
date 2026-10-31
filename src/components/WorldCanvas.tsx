import { Armchair, BookOpen, Check, Clapperboard, Coffee, Lightbulb, Moon, Music, PenTool, Scissors, Settings, Sparkles, TriangleAlert, Type, Hand, MessageCircle } from "lucide-react";
import { ComponentType, useEffect, useRef, useState } from "react";
import { LOOKS } from "../sim/data";
import { Editor, bubbleFor, store, useStore } from "../sim/store";
import { STATIONS, StationId } from "../world/layout";
import { World3D } from "../world3d/world";

const BUBBLES: Record<string, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  scissors: Scissors,
  book: BookOpen,
  pen: PenTool,
  text: Type,
  note: Music,
  gear: Settings,
  think: Lightbulb,
  coffee: Coffee,
  chat: MessageCircle,
  alert: Hand,
  star: Sparkles,
  check: Check,
  zzz: Moon,
  warn: TriangleAlert,
  film: Clapperboard,
  rest: Armchair,
};

function Label({ e, refFn }: { e: Editor; refFn: (el: HTMLDivElement | null) => void }) {
  const icon = bubbleFor(e);
  const Icon = icon ? BUBBLES[icon] : null;
  const needs = e.activity === "needs";
  return (
    <div ref={refFn} className={`tag ${needs ? "needs" : ""} ${e.activity === "stuck" ? "stuck" : ""} ${store.selectedId === e.id ? "on" : ""}`}>
      <button onClick={() => store.select(e.id)} aria-label={`Open ${e.name}'s chat`}>
        <span className="tag-icon" style={{ background: LOOKS[e.look].shirt }}>
          {Icon && <Icon size={11} strokeWidth={2.8} />}
        </span>
        <b>{e.name}</b>
      </button>
    </div>
  );
}

export function WorldCanvas({ panelOpen }: { panelOpen: boolean }) {
  const s = useStore();
  const ref = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; id: StationId } | null>(null);
  const [failed, setFailed] = useState(false);
  const panelRef = useRef(panelOpen);
  panelRef.current = panelOpen;
  const tags = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    const canvas = ref.current!;
    let world: World3D;
    try {
      world = new World3D(canvas);
    } catch {
      setFailed(true);
      return;
    }
    let raf = 0;
    let last = performance.now();
    let drag: { x: number; y: number; moved: boolean } | null = null;
    let lastSelected: string | null = null;

    const resize = () => world.resize(window.innerWidth, window.innerHeight);
    resize();

    const loop = (now: number) => {
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      store.update(dt);
      if (store.selectedId !== lastSelected) {
        lastSelected = store.selectedId;
        const e = store.selected();
        if (e) world.focus(e.x, e.y, panelRef.current ? 120 : 0);
        else world.home();
      }
      const following = store.selected();
      if (following?.path.length) world.focus(following.x, following.y, panelRef.current ? 120 : 0);
      world.frame(dt);
      for (const [id, el] of tags.current) {
        const p = world.anchor(id);
        if (p) el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        if (drag.moved) {
          world.panBy(dx, dy);
          drag.x = e.clientX;
          drag.y = e.clientY;
        }
        setTip(null);
        return;
      }
      const editor = world.editorAt(e.clientX, e.clientY);
      world.hoverEditor = editor?.id ?? null;
      const g = world.groundAt(e.clientX, e.clientY);
      const station = editor || !g ? null : world.stationAt(g.x, g.y);
      world.hoverStation = station;
      canvas.style.cursor = editor ? "pointer" : "grab";
      setTip((old) => (station ? { x: e.clientX, y: e.clientY, id: station } : old ? null : old));
    };
    const onUp = (e: PointerEvent) => {
      const wasDrag = drag?.moved;
      drag = null;
      if (wasDrag) return;
      const editor = world.editorAt(e.clientX, e.clientY);
      if (editor) return store.select(editor.id);
      const g = world.groundAt(e.clientX, e.clientY);
      if (g) world.poke(g.x, g.y);
    };
    const onLeave = () => {
      world.hoverEditor = null;
      world.hoverStation = null;
      setTip(null);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      world.zoomBy(e.deltaY < 0 ? 1 : -1);
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", resize);
      world.dispose();
    };
  }, []);

  return (
    <>
      <canvas ref={ref} className="world" aria-label="Your video editors at work in a lagoon villa" />
      {failed && <div className="no-gl">This view needs WebGL. Turn on hardware acceleration in your browser and reload.</div>}
      <div className="tags">
        {s.editors.map((e) => (
          <Label
            key={e.id}
            e={e}
            refFn={(el) => {
              if (el) tags.current.set(e.id, el);
              else tags.current.delete(e.id);
            }}
          />
        ))}
      </div>
      {tip && (
        <div className="world-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
          <b>{STATIONS[tip.id].label}</b>
          <span>{STATIONS[tip.id].blurb}</span>
        </div>
      )}
    </>
  );
}
