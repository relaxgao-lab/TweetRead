import type { Metadata, Viewport } from "next"
import "./globals.css"

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL

export const metadata: Metadata = {
  metadataBase: siteUrl ? new URL(siteUrl) : undefined,
  title: "TweetRead · AI 推文阅读",
  description: "用 AI 辅助阅读感兴趣的推文，深度解析市场资讯",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-96x96.png", type: "image/png", sizes: "96x96" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    shortcut: ["/favicon.ico"],
  },
  openGraph: {
    title: "TweetRead · AI 推文阅读",
    description: "用 AI 辅助阅读感兴趣的推文，深度解析市场资讯",
    siteName: "TweetRead",
    type: "website",
    locale: "zh_CN",
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "TweetRead · AI 推文阅读",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "TweetRead · AI 推文阅读",
    description: "用 AI 辅助阅读感兴趣的推文，深度解析市场资讯",
    images: ["/opengraph-image.png"],
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="h-full min-h-[var(--app-height)] bg-background antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  )
}
