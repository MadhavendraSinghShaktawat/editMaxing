import { useEffect, useRef, useState } from "react";
import { Thumb, LOOKS } from "../sim/data";
import { Editor } from "../sim/store";
import { R } from "../world/pixel";
import { portraitFor } from "../world3d/character";

export function Portrait({ editor, scale = 2 }: { editor: Editor; scale?: number }) {
  const [url, setUrl] = useState("");
  useEffect(() => setUrl(portraitFor(editor.look, LOOKS[editor.look])), [editor.look]);
  const size = 24 * scale;
  return url ? <img src={url} width={size} height={size} className="portrait" alt="" /> : <span className="portrait" style={{ width: size, height: size }} />;
}

function scene(ctx: CanvasRenderingContext2D, kind: Thumb, f: number) {
  const w = 64;
  const h = 36;
  const sky = (top: string, bottom: string) => {
    for (let y = 0; y < h; y++) R(ctx, 0, y, w, 1, y < 18 ? top : bottom);
  };
  switch (kind) {
    case "run":
      sky("#f2a65e", "#6f7f88");
      R(ctx, 42, 7, 8, 8, "#ffe6a3");
      R(ctx, 0, 24, w, 12, "#3f4a57");
      R(ctx, 16 + f * 5, 15, 4, 4, "#d9a071");
      R(ctx, 15 + f * 5, 19, 6, 6, "#2d2a33");
      R(ctx, 13 + f * 5, 25, 3, 5, "#2d2a33");
      R(ctx, 20 + f * 5, 25, 3, 5, "#2d2a33");
      break;
    case "desk":
      sky("#1d2840", "#27334f");
      R(ctx, 8, 24, 48, 3, "#8a5230");
      R(ctx, 25, 11, 18, 12, "#10141f");
      R(ctx, 26, 12, 16, 10, f % 2 ? "#7fd6ff" : "#a8ecf5");
      R(ctx, 13, 19, 8, 5, "#f6f0e4");
      R(ctx, 16, 12 - f, 1, 5, "#ffffff55");
      break;
    case "coffee":
      sky("#c98a55", "#7a4a2c");
      R(ctx, 20, 18, 22, 14, "#f6f0e4");
      R(ctx, 42, 21, 6, 7, "#d9d0bd");
      R(ctx, 22, 18, 18, 3, "#4a2a1b");
      R(ctx, 30, 2, 3, 16, "#3b2319");
      R(ctx, 26 + f, 8, 2, 2, "#ffffff66");
      break;
    case "sunrise":
      sky("#ffb45e", "#2a6f7a");
      R(ctx, 26, 8 - f, 12, 12, "#ffe9a8");
      R(ctx, 0, 20, w, 16, "#14505c");
      R(ctx, 12, 24, 30 + f * 2, 1, "#ffe9a8");
      break;
    case "city":
      sky("#30486b", "#1d2a42");
      for (let i = 0; i < 8; i++) R(ctx, i * 8 + 1, 10 + ((i * 7) % 9), 7, 26, i % 2 ? "#131c30" : "#1a2740");
      R(ctx, 14 + f * 3, 31, 3, 3, "#ffd27f");
      break;
    case "type":
      sky("#1b2138", "#1b2138");
      R(ctx, 16, 12, 32, 18, "#27324f");
      R(ctx, 18, 14, 28, 13, "#9fe2e8");
      R(ctx, 10, 30, 44, 3, "#49506a");
      R(ctx, 20, 18, 8 + f * 3, 1, "#14323b");
      R(ctx, 20, 21, 16, 1, "#14323b");
      break;
    case "climb":
      sky("#7fc8e8", "#7fc8e8");
      R(ctx, 8, 20, 48, 16, "#5f6b78");
      R(ctx, 18, 12, 30, 24, "#7a8794");
      R(ctx, 28, 5, 12, 31, "#99a6b2");
      R(ctx, 30 + f, 2, 3, 5, "#e8574a");
      break;
    default:
      sky("#f0dcb4", "#e3cb9a");
      R(ctx, 10, 5, 44, 26, "#fbf6e8");
      R(ctx, 14, 9, 22, 2, "#1f8c7f");
      R(ctx, 14, 14, 30, 1, "#2d2a33");
      R(ctx, 14, 18, 18 + f * 3, 1, "#e8772e");
      R(ctx, 14, 22, 26, 1, "#2d2a33");
  }
}

/** A short filmstrip stands in for real B-roll frames in this UI-only build. */
export function Filmstrip({ kind, playing = true, frames = 3 }: { kind: Thumb; playing?: boolean; frames?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    let f = 0;
    const draw = () => {
      for (let i = 0; i < frames; i++) {
        ctx.save();
        ctx.translate(i * 66, 0);
        scene(ctx, kind, (f + i) % 4);
        ctx.restore();
      }
      f++;
    };
    draw();
    if (!playing) return;
    const id = window.setInterval(draw, 420);
    return () => window.clearInterval(id);
  }, [kind, playing, frames]);
  return <canvas ref={ref} width={frames * 66 - 2} height={36} className="filmstrip" />;
}
