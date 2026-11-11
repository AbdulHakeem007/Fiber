"use client";

import { useEffect, useState } from "react";

// Reactive dark-mode flag driven by the app theme (ThemeToggle sets both
// `html[data-theme="dark"]` and the `dark` class). A SINGLE shared MutationObserver
// fans out to every subscriber, so rendering many themed nodes (topology towers)
// does not spawn one observer per node.

let currentValue = false;
const listeners = new Set<(value: boolean) => void>();
let observer: MutationObserver | null = null;

function computeIsDark(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.documentElement;
  return el.dataset.theme === "dark" || el.classList.contains("dark");
}

function ensureObserver(): void {
  if (observer || typeof document === "undefined") return;
  currentValue = computeIsDark();
  observer = new MutationObserver(() => {
    const next = computeIsDark();
    if (next === currentValue) return;
    currentValue = next;
    for (const listener of listeners) listener(next);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
}

export function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState<boolean>(() => computeIsDark());
  useEffect(() => {
    ensureObserver();
    setIsDark(currentValue);
    listeners.add(setIsDark);
    return () => {
      listeners.delete(setIsDark);
    };
  }, []);
  return isDark;
}
