import { NextResponse } from "next/server"
import { fetchTweetAuthorReplies, fetchTweetById, fetchTweetConversation } from "@/lib/twitter"
import type { Tweet } from "@/lib/twitter"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  const cursor = searchParams.get("cursor") ?? undefined
  const authorUserName = searchParams.get("authorUserName") ?? undefined
  const authorOnly = searchParams.get("authorOnly") === "1"

  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 })
  }

  try {
    const result = authorOnly
      ? { tweets: [] as Tweet[], hasMore: false, nextCursor: undefined as string | undefined }
      : await fetchTweetConversation(id, cursor)
    let authorReplies: Tweet[] = []
    if (!cursor) {
      try {
        const rootTweet = authorUserName ? null : await fetchTweetById(id)
        const userName = authorUserName ?? rootTweet?.author.userName
        if (userName) {
          const normalizedUserName = userName.toLowerCase()
          const repliesFromSearch = await fetchTweetAuthorReplies(id, userName)
          const repliesFromFirstPage = authorOnly
            ? []
            : result.tweets.filter((tweet) =>
                tweet.id !== id && tweet.author.userName.toLowerCase() === normalizedUserName
              )
          const seen = new Set<string>()
          authorReplies = [...repliesFromSearch, ...repliesFromFirstPage].filter((tweet) => {
            if (!tweet.id || seen.has(tweet.id)) return false
            seen.add(tweet.id)
            return true
          })
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error"
        console.warn("fetchTweetAuthorReplies error:", msg)
      }
    }
    return NextResponse.json({
      comments: result.tweets,
      authorReplies,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error"
    console.error("fetchTweetConversation error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
