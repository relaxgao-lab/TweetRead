import { NextResponse } from "next/server"
import { fetchArticle } from "@/lib/twitter"

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const article = await fetchArticle(id)
    if (!article) return NextResponse.json({ error: "Article not found" }, { status: 404 })
    return NextResponse.json({ article })
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error"
    console.error("fetchArticle error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
