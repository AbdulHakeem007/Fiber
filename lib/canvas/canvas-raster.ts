// ─────────────────────────────────────────────────────────────────────────────
// Client-only canvas rasterizer shared by the deployment-instructions email and
// the Detailed Trace "Email Report" module. Rasterizes an on-screen topology SVG
// into a high-quality PNG data URL, pinning CSS variables to concrete light-theme
// values and inlining external stencils so colors + icons survive off-DOM.
//
// It also SANITIZES the emailed/printed copy: the live canvas overlays distance
// labels with blue/cyan navigation dots + line-drag handles for on-screen line
// navigation. Those stay on the web dashboard but are stripped from the static
// snapshot so the distance labels print clean and unblemished. The distance
// labels themselves (drawn as <rect>+<text> in the surface/navy palette) and
// every real topology edge (green/violet/amber/orange/teal/red) use non-nav
// colors, so nothing but the nav affordances is removed.
// ─────────────────────────────────────────────────────────────────────────────

// Blue / cyan navigation-dot + line-handle fills stripped from static snapshots.
const NAV_DOT_FILL_RE = /^(#(3b82f6|2563eb|38bdf8|0ea5e9|06b6d4|1d4ed8|60a5fa)|rgba?\(\s*(37|59|56|14|6|96)\s*,)/i;

/** Remove live-only navigation dots / interactive handles from a cloned canvas. */
export function stripScreenOnlyOverlays(clone: SVGSVGElement): void {
  // 1. Explicit opt-out marker (forward-compatible hook for any future overlay).
  clone.querySelectorAll("[data-screen-only]").forEach((element) => element.remove());
  // 2. Blue/cyan nav dots + line-navigation handles, matched by their nav-tone fill.
  clone.querySelectorAll("circle, ellipse, rect, path").forEach((shape) => {
    const fill = (shape.getAttribute("fill") || (shape as SVGElement).style?.fill || "").trim();
    if (NAV_DOT_FILL_RE.test(fill)) shape.remove();
  });
}

/**
 * Rasterize an on-screen topology SVG to a PNG data URL for inline email embed.
 * Returns null if the SVG cannot be serialized/rendered (caller falls back to a
 * text-only email). The static snapshot is sanitized of navigation overlays.
 */
export async function svgToPngDataUrl(svg: SVGSVGElement): Promise<string | null> {
  try {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    const svgNS = "http://www.w3.org/2000/svg";
    const xlinkNS = "http://www.w3.org/1999/xlink";
    clone.setAttribute("xmlns", svgNS);
    clone.setAttribute("xmlns:xlink", xlinkNS);
    // Strip live-only navigation dots / interactive handles from the static image.
    stripScreenOnlyOverlays(clone);
    const style = document.createElementNS(svgNS, "style");
    style.textContent =
      "svg{--surface:#ffffff;--surface-2:#f1f5f9;--muted-text:#64748b;--text-main:#0f172a;--text-strong:#0f172a;--border:#e2e8f0;}";
    clone.insertBefore(style, clone.firstChild);

    // Inline external node stencils (<image href="/network-stencils/*.svg">) as
    // data URIs. Off-DOM rasterization will not fetch relative-URL images, so
    // without this every node collapses to its gray fallback box and the emailed
    // image stops matching the on-screen canvas.
    const fetchCache = new Map<string, string | null>();
    const fetchAsDataUri = async (url: string): Promise<string | null> => {
      if (fetchCache.has(url)) return fetchCache.get(url) ?? null;
      let result: string | null = null;
      try {
        const res = await fetch(url);
        if (res.ok) {
          const blob = await res.blob();
          result = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error("read failed"));
            reader.readAsDataURL(blob);
          });
        }
      } catch {
        result = null;
      }
      fetchCache.set(url, result);
      return result;
    };
    await Promise.all(
      Array.from(clone.querySelectorAll("image")).map(async (img) => {
        let href = img.getAttribute("href") || img.getAttributeNS(xlinkNS, "href") || "";
        if (!href || href.startsWith("data:")) return;
        // The emailed/printed snapshot is pinned to the light theme, so swap the
        // dark-mode tower back to the standard Site.svg before rasterizing.
        href = href.replace(/Site_Dark\.svg(\?.*)?$/i, "site/Site.svg");
        const dataUri = await fetchAsDataUri(new URL(href, window.location.origin).href);
        if (dataUri) {
          img.setAttribute("href", dataUri);
          img.setAttributeNS(xlinkNS, "xlink:href", dataUri);
        }
      }),
    );

    const vb = svg.viewBox?.baseVal;
    const width = Number(svg.getAttribute("width")) || vb?.width || 1200;
    const height = Number(svg.getAttribute("height")) || vb?.height || 600;
    const xml = new XMLSerializer().serializeToString(clone);
    const svgUrl = "data:image/svg+xml;base64," + window.btoa(unescape(encodeURIComponent(xml)));
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("SVG raster load failed"));
      image.src = svgUrl;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // Leave the canvas unfilled so the exported PNG keeps a transparent
    // background (no white backing) — the email body shows through.
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Pick the topology canvas SVG inside a container, NOT the Lucide toolbar icons
 * (which also render as <svg>). Prefer the largest labelled topology canvas,
 * else the largest non-icon SVG. Returns null when the container holds no SVG.
 */
export function pickTopologySvg(container: HTMLElement | null): SVGSVGElement | null {
  if (!container) return null;
  const svgs = Array.from(container.querySelectorAll("svg")) as SVGSVGElement[];
  if (!svgs.length) return null;
  const area = (el: SVGSVGElement) => {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  };
  const labelled = svgs.filter((el) => {
    const label = el.getAttribute("aria-label") ?? "";
    return /topology|trace|ring|chain|trail/i.test(label);
  });
  return (
    labelled.sort((a, b) => area(b) - area(a))[0] ??
    svgs.filter((el) => !el.classList.contains("lucide")).sort((a, b) => area(b) - area(a))[0] ??
    svgs[0]
  );
}
