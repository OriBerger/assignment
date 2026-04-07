import "./globals.css";

export const metadata = {
  title: "Jetson YOLO Dashboard",
  description: "YOLOv3-tiny video detection dashboard"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
