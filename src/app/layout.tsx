import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'CAD AI — 3D Modeling & Parametric CAD Assistant',
  description: 'AI-powered 3D parametric CAD modeling and FDM 3D print validation in your browser.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans bg-slate-950 text-slate-100 h-full flex flex-col antialiased overflow-hidden select-none`}
      >
        {children}
      </body>
    </html>
  );
}
