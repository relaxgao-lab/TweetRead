const GETXAPI_BASE = "https://api.getxapi.com"

export interface Tweet {
  id: string
  text: string
  textZh?: string
  url: string
  createdAt: string
  likeCount: number
  retweetCount: number
  replyCount: number
  viewCount: number
  quoteCount: number
  isReply: boolean
  lang: string
  media: TweetMedia[]
  author: TweetAuthor
  quotedTweet?: Tweet | null
}

export interface TweetAuthor {
  userName: string
  name: string
  profilePicture: string
  isBlueVerified: boolean
  followers: number
  description?: string
}

export interface TweetMedia {
  type: "photo" | "video" | "animated_gif"
  url?: string
  previewUrl?: string
}

export interface TweetsResponse {
  tweets: Tweet[]
  hasMore: boolean
  nextCursor?: string
}

function getApiKey(): string {
  const key = process.env.GETXAPI_KEY
  if (!key) throw new Error("GETXAPI_KEY is not set in environment variables")
  return key
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function parseMedia(rawMedia: unknown): TweetMedia[] {
  if (!Array.isArray(rawMedia)) return []
  return rawMedia.map((item) => {
    const media = asRecord(item)
    return {
      type: (media.type as TweetMedia["type"]) ?? "photo",
      url: (media.url as string | undefined) ?? (media.fullUrl as string | undefined) ?? undefined,
      previewUrl: (media.previewUrl as string | undefined) ?? (media.thumbnailUrl as string | undefined) ?? undefined,
    }
  })
}

function parseTweet(raw: unknown): Tweet {
  const tweet = asRecord(raw)
  const author = asRecord(tweet.author)
  return {
    id: (tweet.id as string | undefined) ?? "",
    text: (tweet.text as string | undefined) ?? "",
    url: (tweet.url as string | undefined) ?? `https://x.com/i/web/status/${(tweet.id as string | undefined) ?? ""}`,
    createdAt: (tweet.createdAt as string | undefined) ?? "",
    likeCount: (tweet.likeCount as number | undefined) ?? 0,
    retweetCount: (tweet.retweetCount as number | undefined) ?? 0,
    replyCount: (tweet.replyCount as number | undefined) ?? 0,
    viewCount: (tweet.viewCount as number | undefined) ?? 0,
    quoteCount: (tweet.quoteCount as number | undefined) ?? 0,
    isReply: (tweet.isReply as boolean | undefined) ?? false,
    lang: (tweet.lang as string | undefined) ?? "en",
    media: parseMedia(tweet.media),
    author: {
      userName: (author.userName as string | undefined) ?? "",
      name: (author.name as string | undefined) ?? "",
      profilePicture: (author.profilePicture as string | undefined) ?? "",
      isBlueVerified: (author.isBlueVerified as boolean | undefined) ?? false,
      followers: (author.followers as number | undefined) ?? 0,
      description: (author.description as string | undefined) ?? "",
    },
    quotedTweet: tweet.quoted_tweet ? parseTweet(tweet.quoted_tweet) : null,
  }
}

export async function fetchUserTweets(userName: string, cursor?: string, forceRefresh?: boolean): Promise<TweetsResponse> {
  const apiKey = getApiKey()
  const params = new URLSearchParams({ q: `from:${userName}`, product: "Latest" })
  if (cursor) params.set("cursor", cursor)

  const res = await fetch(`${GETXAPI_BASE}/twitter/tweet/advanced_search?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    ...(forceRefresh ? { cache: "no-store" as RequestCache } : { next: { revalidate: 300 } }), // 刷新时跳过缓存，否则 5 分钟缓存
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GetXAPI error ${res.status}: ${err}`)
  }

  const data = asRecord(await res.json())
  const rawTweets = Array.isArray(data.tweets) ? data.tweets : []

  return {
    tweets: rawTweets.map(parseTweet),
    hasMore: (data.has_more as boolean | undefined) ?? false,
    nextCursor: (data.next_cursor as string | undefined) ?? undefined,
  }
}

export async function fetchTweetConversation(tweetId: string, cursor?: string): Promise<TweetsResponse> {
  const apiKey = getApiKey()
  const params = new URLSearchParams({ q: `conversation_id:${tweetId}`, product: "Latest" })
  if (cursor) params.set("cursor", cursor)

  const res = await fetch(`${GETXAPI_BASE}/twitter/tweet/advanced_search?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    next: { revalidate: 300 },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GetXAPI conversation error ${res.status}: ${err}`)
  }

  const data = asRecord(await res.json())
  const rawTweets = Array.isArray(data.tweets) ? data.tweets : []

  return {
    tweets: rawTweets.map(parseTweet),
    hasMore: (data.has_more as boolean | undefined) ?? false,
    nextCursor: (data.next_cursor as string | undefined) ?? undefined,
  }
}

export async function fetchTweetById(id: string): Promise<Tweet | null> {
  const apiKey = getApiKey()
  const res = await fetch(`${GETXAPI_BASE}/twitter/tweet/detail?id=${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    next: { revalidate: 3600 },
  })

  if (!res.ok) return null

  const data = asRecord(await res.json())
  const raw = data.tweet ?? data
  return parseTweet(raw)
}

export function formatRelativeTime(createdAt: string): string {
  if (!createdAt) return ""
  const date = new Date(createdAt)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  if (days < 7) return `${days}天前`
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
