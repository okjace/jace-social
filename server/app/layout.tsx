import "./globals.css";
import { LegalLinks } from "@/components/Legal";

export const metadata = {
  title: "Jace Social", description: "Friends, chat and servers - with Minecraft built in",
  appleWebApp: { capable: true, title: "Jace Social", statusBarStyle: "black-translucent" as const },
};
export const viewport = { themeColor: "#111317", width: "device-width", initialScale: 1, viewportFit: "cover" as const };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}<LegalLinks /></body>
    </html>
  );
}
