import { NextResponse } from "next/server"
import { fetchTweetById } from "@/lib/twitter"

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { id } = params
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 })

  try {
    const tweet = await fetchTweetById(id)
    if (!tweet) return NextResponse.json({ error: "Tweet not found" }, { status: 404 })
    return NextResponse.json({ tweet })
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
