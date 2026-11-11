// Animated, theme-independent fiber graphics for the login page.
//
// FiberNetworkBackground renders a light fiber-optic backdrop. Feature labels
// are plain text on SVG animateMotion paths, so they stay centered on the lines.

const KEYFRAMES = `
@keyframes lpRise   { from { opacity: 0; transform: translateY(22px); } to { opacity: 1; transform: none; } }
@keyframes lpFlow   { to { stroke-dashoffset: -114; } }
@keyframes lpTwinkle{ 0%,100% { opacity: .2; } 50% { opacity: .7; } }
@keyframes lpRing   { 0% { transform: scale(.55); opacity: .4; } 100% { transform: scale(2.6); opacity: 0; } }
@keyframes lpDot    { 0%,100% { opacity: .55; transform: scale(1); } 50% { opacity: 1; transform: scale(1.5); } }
@keyframes lpSheen  { to { background-position: 200% center; } }
.lp-rise  { opacity: 0; animation: lpRise .75s cubic-bezier(.22,.61,.36,1) forwards; }
.lp-flow  { stroke-dasharray: 14 100; animation: lpFlow 7s linear infinite; }
.lp-node  { transform-box: fill-box; transform-origin: center; animation: lpTwinkle 4s ease-in-out infinite; }
.lp-ring  { transform-box: fill-box; transform-origin: center; animation: lpRing 3.6s ease-out infinite; }
.lp-dot   { animation: lpDot 2.4s ease-in-out infinite; }
.lp-sheen { background-size: 200% auto; animation: lpSheen 7s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .lp-rise, .lp-flow, .lp-node, .lp-ring, .lp-dot, .lp-sheen { animation: none !important; }
  .lp-rise { opacity: 1; transform: none; }
  .lp-flow { stroke-dashoffset: 0; opacity: .5; }
}
`;

// Fiber routes: faint base curves plus travelling light streaks. Label-bearing
// lanes stay on the page edges so they do not pass under the login panel.
const ROUTES: Array<{ d: string; grad: string; dur: number; delay: number }> = [
  { d: "M-80,116 C 220,76 420,152 650,118 S 1050,82 1520,138", grad: "lpTeal", dur: 6.5, delay: 0 },
  { d: "M-80,246 C 210,308 440,188 650,246 S 800,318 930,232", grad: "lpCyan", dur: 8.0, delay: 1.1 },
  { d: "M-80,762 C 290,704 560,828 850,766 S 1190,704 1520,760", grad: "lpAmber", dur: 7.2, delay: 0.6 },
  { d: "M205,-80 C 248,178 148,368 232,562 S 308,782 224,980", grad: "lpBlue", dur: 9.0, delay: 0.3 },
  { d: "M1382,-80 C 1338,172 1420,356 1368,548 S 1280,798 1362,980", grad: "lpCyan", dur: 8.4, delay: 1.6 },
  { d: "M-80,395 C 170,352 360,430 565,382 S 760,330 940,388", grad: "lpTeal", dur: 7.8, delay: 0.9 },
];

const NODES: Array<{ x: number; y: number; r: number; delay: number }> = [
  { x: 220, y: 96, r: 3.5, delay: 0.2 }, { x: 650, y: 118, r: 4, delay: 0.9 },
  { x: 440, y: 188, r: 3.5, delay: 1.4 }, { x: 232, y: 562, r: 4, delay: 0.5 },
  { x: 940, y: 388, r: 3.5, delay: 1.1 }, { x: 850, y: 766, r: 4, delay: 0.7 },
  { x: 205, y: 246, r: 3, delay: 1.7 }, { x: 1368, y: 548, r: 3.5, delay: 0.4 },
  { x: 565, y: 382, r: 3, delay: 1.2 }, { x: 1382, y: 138, r: 3.5, delay: 0.8 },
];

const LABELS: Array<{ text: string; route: number; dur: number; begin: number }> = [
  { text: "ODF Saturation", route: 0, dur: 31, begin: -2 },
  { text: "Trace & Provision", route: 1, dur: 34, begin: -11 },
  { text: "Inventory", route: 3, dur: 29, begin: -17 },
  { text: "Comprehensive Reporting", route: 4, dur: 37, begin: -24 },
  { text: "Impact Analysis", route: 2, dur: 33, begin: -29 },
];

/** Light fiber-optic network backdrop. Also injects the shared keyframes. */
export function FiberNetworkBackground() {
  const dots: Array<{ x: number; y: number }> = [];
  for (let c = 0; c <= 14; c += 1) for (let r = 0; r <= 9; r += 1) dots.push({ x: c * 100, y: r * 100 });
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <style>{KEYFRAMES}</style>
      <svg className="h-full w-full" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="lpTeal" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#0891b2" /><stop offset="1" stopColor="#2563eb" /></linearGradient>
          <linearGradient id="lpCyan" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#22d3ee" /><stop offset="1" stopColor="#3b82f6" /></linearGradient>
          <linearGradient id="lpAmber" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#0ea5e9" /><stop offset="1" stopColor="#6366f1" /></linearGradient>
          <linearGradient id="lpBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3b82f6" /><stop offset="1" stopColor="#0891b2" /></linearGradient>
          <filter id="lpGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>

        {/* faint geometric dot grid */}
        <g fill="#94a3b8" opacity="0.14">
          {dots.map((p, i) => <circle key={`d${i}`} cx={p.x} cy={p.y} r="1.4" />)}
        </g>

        {/* fiber routes: faint base paths for the labels plus dim streaks */}
        <g fill="none" strokeLinecap="round">
          {ROUTES.map((route, i) => <path key={`b${i}`} id={`lpRoute${i}`} d={route.d} stroke="#c2ccd9" strokeWidth="1.4" opacity="0.5" />)}
          <g opacity="0.55">
            {ROUTES.map((route, i) => (
              <path key={`s${i}`} className="lp-flow" d={route.d} pathLength={100} stroke={`url(#${route.grad})`}
                strokeWidth="2.2" filter="url(#lpGlow)" style={{ animationDuration: `${route.dur}s`, animationDelay: `${route.delay}s` }} />
            ))}
          </g>
        </g>

        {/* junction nodes + two pulsing hubs */}
        <g>
          {NODES.map((n, i) => (
            <circle key={`n${i}`} className="lp-node" cx={n.x} cy={n.y} r={n.r} fill="#0e7490" style={{ animationDelay: `${n.delay}s` }} />
          ))}
          {[{ x: 650, y: 118 }, { x: 850, y: 766 }].map((h, i) => (
            <g key={`h${i}`}>
              <circle className="lp-ring" cx={h.x} cy={h.y} r="9" fill="none" stroke="#0891b2" strokeWidth="1.3" style={{ animationDelay: `${i * 1.8}s` }} />
              <circle cx={h.x} cy={h.y} r="4.5" fill="#0e7490" />
            </g>
          ))}
        </g>

        {/* floating feature labels travelling along the fiber lines */}
        <g fontFamily="ui-sans-serif, system-ui, sans-serif">
          {LABELS.map((label) => (
            <g key={label.text}>
              <text x={0} y={-5} textAnchor="middle" dominantBaseline="middle" fontSize={14} fontWeight={700} fill="#075985" opacity="0.86">{label.text}</text>
              <animateMotion dur={`${label.dur}s`} begin={`${label.begin}s`} repeatCount="indefinite" rotate="0" calcMode="linear">
                <mpath href={`#lpRoute${label.route}`} />
              </animateMotion>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
