import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Young_Serif } from "next/font/google";

import "./globals.css";

const serif = Young_Serif({ weight: "400", subsets: ["latin"], variable: "--font-serif", display: "swap" });
const sans = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Corner Café checkout",
  description: "A RingPay demo: order, pay privately, and watch the order get marked paid.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#e9eeea" },
    { media: "(prefers-color-scheme: dark)", color: "#121a16" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
