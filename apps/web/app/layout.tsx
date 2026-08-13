import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "CS2 AI Demo Coach · 可运行纵向骨架",
  description: "由 AI 主持节奏、覆盖整场并在关键决策前暂停的 CS2 Demo 复盘原型。"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

