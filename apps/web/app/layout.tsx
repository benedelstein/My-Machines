import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Sonner } from "@/components/ui/sonner";

const dmSerifDisplay = localFont({
  src: "./fonts/DMSerifDisplay-Regular.ttf",
  variable: "--font-dm-serif-display",
  display: "swap",
  preload: true,
});

const schoolbell = localFont({
  src: "./fonts/Schoolbell-Regular.ttf",
  variable: "--font-schoolbell",
  display: "swap",
  preload: true,
});

export const metadata: Metadata = {
  title: {
    default: "My Machines",
    template: "%s | My Machines",
  },
  description: "Persistent computers for your agent team.",
  openGraph: {
    title: {
      default: "My Machines",
      template: "%s | My Machines",
    },
    description: "Persistent computers for your agent team.",
    siteName: "My Machines",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${dmSerifDisplay.variable} ${schoolbell.variable}`}>
      <body className="antialiased">
        {children}
        <Sonner />
      </body>
    </html>
  );
}
