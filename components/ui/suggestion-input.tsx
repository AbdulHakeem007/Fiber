"use client";

import {
  type KeyboardEvent,
  type KeyboardEventHandler,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

type Suggestion = {
  value: string;
  label?: string;
  [key: string]: unknown;
};

const FETCH_DEBOUNCE_MS = 140;
const MAX_VISIBLE_SUGGESTIONS = 40;

/**
 * Predictive auto-suggest input.
 *
 * Replaces the native <datalist> mechanism (which drew an overlapping circular
 * picker icon inside the input frame) with a fully styled combobox dropdown:
 *  - suggestions stream in as the user types (debounced fetch)
 *  - ArrowUp / ArrowDown to navigate, Enter to pick, Escape to dismiss
 *  - Enter with no highlighted option falls through to the caller's onKeyDown,
 *    so page-level "Enter runs the search" behavior is preserved
 *  - the selected suggestion object is forwarded to onChange for autofill flows
 */
export function SuggestionInput({
  kind,
  value,
  onChange,
  placeholder,
  className = "input-dark",
  params = {},
  type = "text",
  onKeyDown,
}: {
  kind: string;
  value: string;
  onChange: (value: string, suggestion?: Suggestion) => void;
  placeholder?: string;
  className?: string;
  params?: Record<string, string | null | undefined>;
  type?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}) {
  const listboxId = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const paramSite = params.site ?? "";
  const paramRack = params.rack ?? "";
  const paramOdf = params.odf ?? "";

  useEffect(() => {
    if (type === "date") return;
    const controller = new AbortController();
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      const query = new URLSearchParams();
      if (value.trim()) query.set("q", value.trim());
      for (const [key, item] of Object.entries({ site: paramSite, rack: paramRack, odf: paramOdf })) {
        if (item?.trim()) query.set(key, item.trim());
      }
      fetch(`/api/suggestions/${kind}?${query.toString()}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : { suggestions: [] }))
        .then((payload) => {
          const rows = Array.isArray(payload.suggestions) ? (payload.suggestions as Suggestion[]) : [];
          setSuggestions(rows.slice(0, MAX_VISIBLE_SUGGESTIONS));
          setActiveIndex(-1);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSuggestions([]);
        });
    }, FETCH_DEBOUNCE_MS);
    return () => {
      controller.abort();
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [kind, paramSite, paramRack, paramOdf, type, value]);

  // Dismiss the menu on any outside interaction.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const visibleSuggestions = useMemo(() => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return suggestions;
    // Server already filters by q, but rank prefix matches first for instant scanning.
    return [...suggestions].sort((a, b) => {
      const aPrefix = a.value.toLowerCase().startsWith(trimmed) ? 0 : 1;
      const bPrefix = b.value.toLowerCase().startsWith(trimmed) ? 0 : 1;
      return aPrefix - bPrefix;
    });
  }, [suggestions, value]);

  function commitTyped(nextValue: string) {
    const exact = suggestions.find((suggestion) => suggestion.value === nextValue || suggestion.label === nextValue);
    onChange(nextValue, exact);
  }

  function pickSuggestion(suggestion: Suggestion) {
    onChange(suggestion.value, suggestion);
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (type !== "date" && open && visibleSuggestions.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % visibleSuggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index <= 0 ? visibleSuggestions.length - 1 : index - 1));
        return;
      }
      if (event.key === "Enter" && activeIndex >= 0 && visibleSuggestions[activeIndex]) {
        event.preventDefault();
        pickSuggestion(visibleSuggestions[activeIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
        return;
      }
    }
    if (event.key === "Enter") {
      setOpen(false);
      setActiveIndex(-1);
    }
    onKeyDown?.(event);
  }

  if (type === "date") {
    return (
      <input
        className={className}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
      />
    );
  }

  return (
    <div className="suggest-wrap" ref={wrapRef}>
      <input
        className={`${className} w-full`}
        type={type}
        role="combobox"
        aria-expanded={open && visibleSuggestions.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => {
          commitTyped(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
      />
      {open && visibleSuggestions.length > 0 ? (
        <div className="suggest-menu" id={listboxId} role="listbox">
          {visibleSuggestions.map((suggestion, index) => {
            const hint = suggestion.label && suggestion.label !== suggestion.value ? suggestion.label : null;
            return (
              <button
                key={`${suggestion.value}-${suggestion.label ?? index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex || undefined}
                className="suggest-option"
                onPointerDown={(event) => {
                  // Select before the input blur fires so focus handling stays stable.
                  event.preventDefault();
                  pickSuggestion(suggestion);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="suggest-option-value">{suggestion.value}</span>
                {hint ? <span className="suggest-option-hint">{hint}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
