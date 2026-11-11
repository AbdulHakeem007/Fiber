"use client";

import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CHILD_LINK_TAGS } from "@/lib/config/child-link-tags";

export function tagBadgeClass(tag?: string | null): string {
  const slug = String(tag ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return slug ? `tag-${slug}` : "tag-none";
}

const MENU_WIDTH = 200;
const MENU_MAX_HEIGHT = 290;

export function ChildLinkTagDropdown({
  childId,
  value,
  onChange,
}: {
  childId: string;
  value?: string | null;
  onChange?: (tag: string, payload?: { updatedIds?: string[]; serviceCode?: string | null; updatedCount?: number }) => void;
}) {
  const [tag, setTag] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // The menu is rendered through a portal so it can never be clipped by the
  // scrollable table shells that wrap child-row tables (overflow-x: auto turns
  // overflow-y into auto and swallows absolutely positioned popovers).
  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }
    function place() {
      const anchor = wrapRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const spaceBelow = window.innerHeight - anchor.bottom;
      const top = spaceBelow < MENU_MAX_HEIGHT + 12 && anchor.top > MENU_MAX_HEIGHT + 12
        ? anchor.top - MENU_MAX_HEIGHT - 6
        : anchor.bottom + 6;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - MENU_WIDTH - 8));
      setMenuPosition({ top, left });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  async function update(nextTag: string) {
    setOpen(false);
    if (nextTag === tag) return;
    const previous = tag;
    setTag(nextTag);
    setSaving(true);
    try {
      const response = await fetch(`/api/odf-mappings/child-links/${encodeURIComponent(childId)}/tag`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: nextTag }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Tag update failed.");
      onChange?.(payload.tag ?? nextTag, payload);
    } catch {
      setTag(previous);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative inline-block" ref={wrapRef}>
      <button
        type="button"
        className={`tag-badge ${tagBadgeClass(tag)} !min-h-0 cursor-pointer gap-1.5 transition-opacity hover:opacity-85 disabled:cursor-wait`}
        disabled={saving}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tag ? `Service tag: ${tag}` : "Assign service tag"}
        onClick={() => setOpen((current) => !current)}
      >
        {tag || "Tag"}
        {saving
          ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
      </button>
      {open && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              className="suggest-menu"
              role="listbox"
              aria-label="Type of service tags"
              style={{
                position: "fixed",
                top: menuPosition.top,
                left: menuPosition.left,
                right: "auto",
                width: MENU_WIDTH,
                maxHeight: MENU_MAX_HEIGHT,
                zIndex: 1000,
              }}
            >
              {CHILD_LINK_TAGS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="option"
                  aria-selected={option === tag}
                  className="suggest-option"
                  onClick={() => update(option)}
                >
                  <span className={`tag-badge ${tagBadgeClass(option)} !min-h-0`}>{option}</span>
                  {option === tag ? <Check className="h-3.5 w-3.5 flex-none" style={{ color: "var(--accent-text)" }} aria-hidden="true" /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
