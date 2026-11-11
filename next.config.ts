import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  typedRoutes: true,
  outputFileTracingRoot: path.join(__dirname),
  // Removes the floating, draggable Next.js dev-tools indicator (the circular
  // "N" button that opens a menu). It is a Next.js dev-only overlay — Next owns
  // its event listeners and it never ships in a production build — so disabling
  // it here is the correct, complete removal; there is no app component to
  // delete. Set to an object like { position: "bottom-right" } to re-enable.
  devIndicators: false,
};

export default nextConfig;
