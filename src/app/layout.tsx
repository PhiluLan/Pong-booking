import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const commons = localFont({
  src: "./TTCommonsClassic-Regular.ttf",
  variable: "--font-commons",
  display: "swap",
});

const tricks = localFont({
  src: "./TTRicks-Regular.ttf",
  variable: "--font-tricks",
  display: "swap",
});

const isTeamApp = process.env.NEXT_PUBLIC_APP_SURFACE === "team";

export const metadata: Metadata = {
  title: isTeamApp ? "Volta Pong | Team App" : "Volta Pong | Tisch buchen",
  description: isTeamApp
    ? "Geschützter Spielbetrieb von Volta Pong."
    : "Tisch buchen, Spielzeit verwalten und Teil der Volta Community werden.",
  robots: isTeamApp ? { index: false, follow: false } : undefined,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body className={`${commons.variable} ${tricks.variable}`}>{children}</body>
    </html>
  );
}
