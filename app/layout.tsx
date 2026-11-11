import "@xyflow/react/dist/style.css";
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fiber Inventory Management Portal",
  description: "Telecom ODF-port-centric fiber inventory management portal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
try {
  var saved = localStorage.getItem('fiber-theme');
  var theme = saved ? (saved === 'dark' ? 'dark' : 'light') : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
} catch (_) {}
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
