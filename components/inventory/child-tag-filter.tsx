"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Tag } from "lucide-react";
import { CHILD_LINK_TAGS } from "@/lib/config/child-link-tags";
import { tagBadgeClass } from "@/components/inventory/child-link-tag-dropdown";

/**
 * Multi-select service-type filter that sits next to the inventory search box.
 * It only owns its own open/close UI state and reports the chosen tag set up via
 * `onChange`; the parent applies the actual row predicate. Pure presentational
 * control — no data fetching — so it never interferes with the search inputs'
 * predictive-suggestion logic.
 */
export function ChildTagFilter({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
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

  function toggle(tag: string) {
    onChange(value.includes(tag) ? value.filter((item) => item !== tag) : [...value, tag]);
  }

  const label = value.length ? `Service type (${value.length})` : "Service type: All";

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        className="input-dark flex items-center gap-2 whitespace-nowrap"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Tag className="h-4 w-4" aria-hidden="true" />
        <span>{label}</span>
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="suggest-menu absolute left-0 z-[1000] mt-1 w-56"
          role="listbox"
          aria-label="Filter by child-row service type"
          style={{ maxHeight: 300 }}
        >
          {CHILD_LINK_TAGS.map((tag) => {
            const selected = value.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                role="option"
                aria-selected={selected}
                className="suggest-option"
                onClick={() => toggle(tag)}
              >
                <span className={`tag-badge ${tagBadgeClass(tag)} !min-h-0`}>{tag}</span>
                {selected ? <Check className="h-3.5 w-3.5 flex-none" style={{ color: "var(--accent-text)" }} aria-hidden="true" /> : null}
              </button>
            );
          })}
          {value.length ? (
            <button type="button" className="suggest-option justify-center font-semibold" onClick={() => onChange([])}>
              Clear service types
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
