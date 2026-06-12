import { config } from "dotenv"
import { resolve } from "path"
config({ path: resolve(process.cwd(), ".env.local") })

import postgres from "postgres"

const sql = postgres(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!, { max: 1 })
const GETXAPI_BASE = "https://api.getxapi.com"
const API_KEY = process.env.GETXAPI_KEY!
const USER_NAME = process.argv[2]

if (!USER_NAME) {
  console.error("用法: npx tsx scripts/sync-tweets.ts <username>")
  process.exit(1)
}

async function searchPage(query: string, cursor?: string) {
  const params = new URLSearchParams({ q: query, product: "Latest" })
  if (cursor) params.set("cursor", cursor)
  const res = await fetch(`${GETXAPI_BASE}/twitter/tweet/advanced_search?${params}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`)
  return res.json() as Promise<{ tweets: unknown[]; has_more: boolean; next_cursor?: string }>
}

function parseTweet(raw: Record<string, unknown>) {
  const author = (raw.author ?? {}) as Record<string, unknown>
  const mediaArr = Array.isArray(raw.media) ? raw.media : []
  return {
    id: String(raw.id ?? raw.tweet_id ?? ""),
    user_name: USER_NAME.toLowerCase(),
    text: String(raw.text ?? raw.full_text ?? ""),
    created_at: new Date(String(raw.createdAt ?? raw.created_at)),
    like_count: Number(raw.likeCount ?? raw.favorite_count ?? 0),
    reply_count: Number(raw.replyCount ?? raw.reply_count ?? 0),
    retweet_count: Number(raw.retweetCount ?? raw.retweet_count ?? 0),
    view_count: Number(raw.viewCount ?? raw.views ?? 0),
    quote_count: Number(raw.quoteCount ?? raw.quote_count ?? 0),
    is_reply: Boolean(raw.isReply ?? raw.in_reply_to_status_id),
    lang: String(raw.lang ?? ""),
    author_name: String(author.name ?? ""),
    author_username: String(author.userName ?? author.screen_name ?? ""),
    author_profile_picture: String(author.profilePicture ?? author.profile_image_url ?? ""),
    author_is_blue_verified: Boolean(author.isBlueVerified ?? false),
    media: JSON.stringify(mediaArr),
  }
}

// 生成从 startYear 到今天的每月区间
function monthRanges(startYear: number) {
  const ranges: { since: string; until: string }[] = []
  const now = new Date()
  let d = new Date(startYear, 0, 1)
  while (d <= now) {
    const since = d.toISOString().slice(0, 10)
    d.setMonth(d.getMonth() + 1)
    const until = d.toISOString().slice(0, 10)
    ranges.push({ since, until })
  }
  return ranges
}

async function syncMonth(since: string, until: string): Promise<number> {
  const query = `from:${USER_NAME} since:${since} until:${until}`
  let cursor: string | undefined
  let total = 0

  while (true) {
    const data = await searchPage(query, cursor)
    const tweets = (data.tweets ?? []) as Record<string, unknown>[]
    if (tweets.length === 0) break

    const rows = tweets.map(parseTweet).filter(t => t.id && !isNaN(t.created_at.getTime()))
    if (rows.length > 0) {
      await sql`
        INSERT INTO tweets ${sql(rows)}
        ON CONFLICT (id) DO UPDATE SET
          like_count    = EXCLUDED.like_count,
          reply_count   = EXCLUDED.reply_count,
          retweet_count = EXCLUDED.retweet_count,
          view_count    = EXCLUDED.view_count,
          synced_at     = NOW()
      `
      total += rows.length
    }

    if (!data.has_more || !data.next_cursor) break
    cursor = data.next_cursor
    await new Promise(r => setTimeout(r, 300))
  }

  return total
}

async function main() {
  console.log(`\n开始同步 @${USER_NAME} 的推文（搜索模式，按月分段）...\n`)

  const ranges = monthRanges(2022)
  let grand = 0

  for (const { since, until } of ranges) {
    const count = await syncMonth(since, until)
    if (count > 0) {
      grand += count
      console.log(`${since} ~ ${until}：写入 ${count} 条，累计 ${grand} 条`)
    } else {
      process.stdout.write(".")
    }
    await new Promise(r => setTimeout(r, 200))
  }

  console.log(`\n\n✓ 同步完成，共写入 ${grand} 条推文\n`)
  await sql.end()
}

main().catch(e => {
  console.error("\n同步失败:", e)
  process.exit(1)
})
