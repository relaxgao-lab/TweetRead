import { NextResponse } from "next/server"
import { searchUserTweets } from "@/lib/twitter"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const userName = searchParams.get("userName")
  const q = searchParams.get("q")
  const cursor = searchParams.get("cursor") ?? undefined

  if (!userName || !q) {
    return NextResponse.json({ error: "Missing userName or q" }, { status: 400 })
  }

  try {
    const result = await searchUserTweets(userName, q, cursor)
    return NextResponse.json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error"
    console.error("searchUserTweets error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
