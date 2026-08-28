import type { ReactNode } from "react";
import { AuthProvider } from "../lib/auth/AuthProvider";
import AuthGate from "../components/auth/AuthGate";
import "./globals.css";

export const metadata = {
  title: "Varannan",
  description: "Delad kalender och information för samarbetande föräldrar",
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
