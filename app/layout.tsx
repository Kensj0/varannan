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

const PROJECT_ID = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="sv">
      <head>
        {/*
          Öppna TLS-anslutningen till Firebase-backendarna redan medan
          JS-bunten laddar, så det första data-anropet inte betalar för
          handskakningen. Firestore (WebChannel), Auth och token-refresh
          plus callables-regionen.
        */}
        <link rel="preconnect" href="https://firestore.googleapis.com" crossOrigin="" />
        <link rel="preconnect" href="https://identitytoolkit.googleapis.com" crossOrigin="" />
        <link rel="preconnect" href="https://securetoken.googleapis.com" crossOrigin="" />
        {PROJECT_ID && (
          <link
            rel="preconnect"
            href={`https://europe-north1-${PROJECT_ID}.cloudfunctions.net`}
            crossOrigin=""
          />
        )}
      </head>
      <body className="bg-stone-100">
        <AuthProvider>
          <AuthGate>{children}</AuthGate>
        </AuthProvider>
      </body>
    </html>
  );
}
