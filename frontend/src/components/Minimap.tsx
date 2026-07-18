import type { ReactElement, RefObject } from "react";
/**
 * Change-density strip (spec §7.3): hunk locations as tick marks, comment
 * markers as dots, viewport as a band. Density-only — not a rendered-code
 * minimap. Only rendered above the changed-line threshold (~500).
 * Positions are row-index-proportional: cheap, stable, and accurate enough
 * for navigation at the scale where the strip appears at all.
 */

import { memo, useEffect, useRef } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { selectMinimap } from "../state/selectors";
import { useStore } from "../state/store";
import { scrollToRow } from "../state/controller";

const COLORS: Record<string, { tick: string; draft: string; unresolved: string; orphan: string }> =
  {
    light: { tick: "#a0a7b4", draft: "#8b93a1", unresolved: "#2563eb", orphan: "#b45309" },
    dark: { tick: "#464e5e", draft: "#676f7d", unresolved: "#3b82f6", orphan: "#f0b429" },
  };

export const Minimap = memo(function Minimap({
  scrollRef,
  virtualizerRef,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  virtualizerRef: RefObject<Virtualizer<HTMLDivElement, Element>>;
}): ReactElement | null {
  const model = useStore(selectMinimap);
  const theme = useStore((s) => s.theme);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Draw ticks + comment dots.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model) return;
    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      const palette = COLORS[theme] ?? COLORS["dark"]!;
      const y = (index: number): number =>
        model.rowCount <= 1 ? 0 : Math.round((index / model.rowCount) * (h - 2)) + 1;
      ctx.fillStyle = palette.tick;
      for (const tick of model.ticks) {
        ctx.fillRect(2, y(tick), w - 6, 1.5);
      }
      for (const c of model.comments) {
        ctx.fillStyle =
          c.state === "orphaned"
            ? palette.orphan
            : c.state === "resolved"
              ? palette.draft
              : palette.unresolved;
        ctx.beginPath();
        ctx.arc(w / 2, y(c.index), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [model, theme]);

  // Viewport band follows scroll.
  useEffect(() => {
    const el = scrollRef.current;
    const band = bandRef.current;
    const wrap = wrapRef.current;
    if (!el || !band || !wrap || !model) return;
    let raf = 0;
    const update = (): void => {
      raf = 0;
      const total = el.scrollHeight;
      const h = wrap.clientHeight;
      if (total <= 0 || h <= 0) return;
      const top = (el.scrollTop / total) * h;
      const height = Math.max(8, (el.clientHeight / total) * h);
      band.style.top = `${top}px`;
      band.style.height = `${height}px`;
    };
    const onScroll = (): void => {
      if (raf === 0) raf = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(onScroll);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [model, scrollRef]);

  if (!model) return null;

  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const wrap = wrapRef.current;
    const v = virtualizerRef.current;
    if (!wrap || !v) return;
    const rect = wrap.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    scrollToRow(Math.round(frac * (model.rowCount - 1)));
  };

  return (
    <div className="minimap" ref={wrapRef} onClick={onClick} title="Change density">
      <canvas ref={canvasRef} />
      <div className="band" ref={bandRef} />
    </div>
  );
});
