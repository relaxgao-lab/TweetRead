import { NextResponse } from "next/server"
import { fetchUserTweets } from "@/lib/twitter"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const userName = searchParams.get("userName")
  const cursor = searchParams.get("cursor") ?? undefined

  if (!userName) {
    return NextResponse.json({ error: "Missing userName" }, { status: 400 })
  }

  try {
    const result = await fetchUserTweets(userName, cursor)
    return NextResponse.json(result)
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error"
    console.error("fetchUserTweets error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
