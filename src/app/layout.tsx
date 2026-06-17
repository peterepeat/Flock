import type { Metadata, Viewport } from "next";
import { Inter, DM_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Flock — find your flock",
  description:
    "Everyone starts somewhere. Flock figures out the routes so you spend as much time running together as possible.",
};

export const viewport: Viewport = {
  themeColor: "#17171A",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${dmMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
