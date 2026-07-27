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
  metadataBase: new URL("https://www.mymachines.dev"),
  title: {
    default: "My Machines",
    template: "%s | My Machines",
  },
  description: "Infinite, on-demand computers for all your work.",
  openGraph: {
    title: {
      default: "My Machines",
      template: "%s | My Machines",
    },
    description: "Infinite, on-demand computers for all your work.",
    images: [
      {
        url: "/opengraph.png",
        width: 1200,
        height: 630,
        alt: "Works on My Machines",
      },
    ],
    siteName: "My Machines",
  },
  twitter: {
    card: "summary_large_image",
    images: ["/opengraph.png"],
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
