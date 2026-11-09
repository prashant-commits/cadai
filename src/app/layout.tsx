import type { Metadata } from 'next';
import { Inter, Geist_Mono } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

const inter = Inter({
  variable: '--font-inter',
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
        className={`${inter.variable} ${geistMono.variable} font-sans bg-slate-950 text-slate-100 h-full flex flex-col antialiased overflow-hidden select-none`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
