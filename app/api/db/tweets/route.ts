import { NextResponse } from "next/server"
import sql from "@/lib/db"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const userName = searchParams.get("userName")?.toLowerCase()
  const cursor = searchParams.get("cursor") // 上一页最后一条的 created_at ISO 字符串

  if (!userName) return NextResponse.json({ error: "Missing userName" }, { status: 400 })

  const limit = 20

  const rows = cursor
    ? await sql`
        SELECT id, text, created_at, like_count, reply_count, view_count, quote_count,
               retweet_count, is_reply, lang, author_name, author_username,
               author_profile_picture, author_is_blue_verified, media
        FROM tweets
        WHERE user_name = ${userName}
          AND created_at > ${new Date(cursor)}
        ORDER BY created_at ASC
        LIMIT ${limit}
      `
    : await sql`
        SELECT id, text, created_at, like_count, reply_count, view_count, quote_count,
               retweet_count, is_reply, lang, author_name, author_username,
               author_profile_picture, author_is_blue_verified, media
        FROM tweets
        WHERE user_name = ${userName}
        ORDER BY created_at ASC
        LIMIT ${limit}
      `

  const hasMore = rows.length === limit
  const nextCursor = hasMore ? rows[rows.length - 1].created_at.toISOString() : undefined

  // 转换为前端 Tweet 结构
  const tweets = rows.map(r => ({
    id: r.id,
    text: r.text,
    url: `https://x.com/${r.author_username}/status/${r.id}`,
    createdAt: r.created_at.toISOString(),
    likeCount: r.like_count,
    replyCount: r.reply_count,
    retweetCount: r.retweet_count,
    viewCount: r.view_count,
    quoteCount: r.quote_count,
    isReply: r.is_reply,
    lang: r.lang ?? "",
    media: JSON.parse(r.media ?? "[]"),
    author: {
      userName: r.author_username,
      name: r.author_name,
      profilePicture: r.author_profile_picture,
      isBlueVerified: r.author_is_blue_verified,
      followers: 0,
    },
  }))

  return NextResponse.json({ tweets, hasMore, nextCursor })
}
