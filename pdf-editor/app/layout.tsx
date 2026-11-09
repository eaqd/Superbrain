import type { Metadata, Viewport } from "next";
import { Caveat, Dancing_Script, Great_Vibes, Inter } from "next/font/google";
import "./globals.css";
import "./pdf.css";

const body = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-body", display: "swap" });
// Handwriting faces for typed signatures.
const sig1 = Dancing_Script({ subsets: ["latin"], weight: ["600"], variable: "--font-sig1", display: "swap" });
const sig2 = Great_Vibes({ subsets: ["latin"], weight: ["400"], variable: "--font-sig2", display: "swap" });
const sig3 = Caveat({ subsets: ["latin"], weight: ["600"], variable: "--font-sig3", display: "swap" });

export const metadata: Metadata = {
  title: "Superbrain PDF — edit, sign, organize and protect PDFs",
  description:
    "A full PDF editor that runs entirely in your browser: edit text and images, comment, fill and sign, organize pages, redact, protect, compress and convert. Files never leave your device.",
  applicationName: "Superbrain PDF",
  appleWebApp: { capable: true, title: "Superbrain PDF", statusBarStyle: "default" },
  icons: { icon: [{ url: "/pdf-icon.svg", type: "image/svg+xml" }] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1f2430",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${body.variable} ${sig1.variable} ${sig2.variable} ${sig3.variable}`}>
      <body className="pdf-root">{children}</body>
    </html>
  );
}
