import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Bot · Workspace",
  description: "Your persistent conversations with Bot",
  robots: { index: false, follow: false }
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
