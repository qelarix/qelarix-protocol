import type { Metadata } from "next";
import localFont from "next/font/local";
import { Suspense } from "react";
import "./globals.css";
import Providers from "@/components/Providers";
import Toaster from "@/components/Toaster";
import CookieConsent from "@/components/CookieConsent";
import Header from "@/components/Header";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: 'Qelarix — AI Video, Image & Audio Platform',
  description: '30+ AI models for video, image and audio generation. One platform, infinite creativity.',
  keywords: 'AI video generator, AI image generator, Qelarix, Cinema Studio, AI platform',
  openGraph: {
    title: 'Qelarix — AI Video, Image & Audio Platform',
    description: '30+ AI models for video, image and audio generation. One platform, infinite creativity.',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth">
      <head>
        <script dangerouslySetInnerHTML={{ __html: `if('scrollRestoration'in history){history.scrollRestoration='manual';}` }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-black text-white`}
      >
        <Providers>
          <Suspense fallback={
            <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: 56, background: "rgba(5,5,5,0.85)", borderBottom: "1px solid #2A2F3A", zIndex: 1000 }} />
          }>
            <Header />
          </Suspense>
          <main style={{ paddingTop: "56px" }}>{children}</main>
          <Toaster />
          <CookieConsent />
        </Providers>
      </body>
    </html>
  );
}
