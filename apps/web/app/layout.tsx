import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "CS2 AI Demo Coach · 整场带看",
  description: "在本机解析 CS2 Demo，由 AI 教练带你看完整场、回到决策点讲清关键选择。"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
