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

export const metadata: Metadata = {
  title: "Volta Pong | Buchungen",
  description: "Buchungen und Spielbetrieb von Volta Pong verwalten.",
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
