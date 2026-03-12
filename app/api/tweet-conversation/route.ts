import { NextResponse } from "next/server"
import { fetchTweetConversation } from "@/lib/twitter"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  const cursor = searchParams.get("cursor") ?? undefined

  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 })
  }

  try {
    const result = await fetchTweetConversation(id, cursor)
    return NextResponse.json({
      comments: result.tweets,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error"
    console.error("fetchTweetConversation error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

