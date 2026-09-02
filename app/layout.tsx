import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth/AuthProvider";
import AuthGate from "../components/auth/AuthGate";
import "./globals.css";

export const metadata = {
  title: "Varannan",
  description: "Delad kalender och information för samarbetande föräldrar",
  manifest: "/manifest.webmanifest",
  applicationName: "Varannan",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    // iOS läser den här när man sparar på hemskärmen. Utan den tar
    // Safari en skärmdump av sidan i stället för att använda ikonen.
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "Varannan",
    statusBarStyle: "black-translucent",
  },
};

export const viewport = {
  themeColor: "#24201F",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="sv">
      <body className="bg-stone-100">
        <AuthProvider>
          <AuthGate>{children}</AuthGate>
        </AuthProvider>
      </body>
    </html>
  );
}
