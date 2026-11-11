"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { GripHorizontal, X } from "lucide-react";

interface DraggablePanelProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Width preset, reuses the modal sizing classes (e.g. "modal-wide"). */
  className?: string;
  /** Initial top-left in px. Defaults to a near-centered offset near the top. */
  initialPosition?: { x: number; y: number };
}

function defaultPosition(): { x: number; y: number } {
  if (typeof window === "undefined") return { x: 140, y: 72 };
  return { x: Math.max(16, Math.round(window.innerWidth / 2 - 540)), y: 72 };
}

/**
 * A backdrop-LESS, draggable overlay panel. Unlike .modal-backdrop (which still
 * renders a dimming layer pinned top-right), this leaves the entire portal
 * behind it fully visible, scrollable, and clickable — only the panel itself
 * captures pointer events. Drag it by its header to reposition while you keep
 * referencing the inventory tables underneath.
 */
export function DraggablePanel({ title, subtitle, onClose, children, className = "", initialPosition }: DraggablePanelProps) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => initialPosition ?? defaultPosition());
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      drag.current = { dx: event.clientX - pos.x, dy: event.clientY - pos.y };
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    },
    [pos.x, pos.y],
  );

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    if (!drag.current) return;
    // Keep a sliver of the panel on-screen so it can never be lost off an edge.
    const maxX = window.innerWidth - 80;
    const maxY = window.innerHeight - 56;
    const x = Math.min(Math.max(event.clientX - drag.current.dx, 8 - 0), maxX);
    const y = Math.min(Math.max(event.clientY - drag.current.dy, 8), maxY);
    setPos({ x, y });
  }, []);

  const endDrag = useCallback((event: React.PointerEvent) => {
    drag.current = null;
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
  }, []);

  return (
    <div className="draggable-layer" role="dialog" aria-modal="false" aria-label={typeof title === "string" ? title : undefined}>
      <div className={`modal-panel draggable-panel ${className}`} style={{ left: pos.x, top: pos.y }}>
        <div
          className="draggable-handle"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="flex min-w-0 items-start gap-2">
            <GripHorizontal className="mt-0.5 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold leading-tight text-slate-950 dark:text-white">{title}</div>
              {subtitle ? <div className="subtle truncate">{subtitle}</div> : null}
            </div>
          </div>
          <button
            type="button"
            className="draggable-close"
            aria-label="Close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="draggable-body">{children}</div>
      </div>
    </div>
  );
}
