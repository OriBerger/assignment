import "./globals.css";

export const metadata = {
  title: "Jetson AI Dashboard",
  description: "YOLOv3-tiny video detection dashboard"
};

/** Next.js root layout: sets page metadata, html language, and wraps the app body around client pages. */
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
