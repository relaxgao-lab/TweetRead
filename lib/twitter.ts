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

function parseTweet(raw: any): Tweet {
  return {
    id: raw.id ?? "",
    text: raw.text ?? "",
    url: raw.url ?? `https://x.com/i/web/status/${raw.id}`,
    createdAt: raw.createdAt ?? "",
    likeCount: raw.likeCount ?? 0,
    retweetCount: raw.retweetCount ?? 0,
    replyCount: raw.replyCount ?? 0,
    viewCount: raw.viewCount ?? 0,
    quoteCount: raw.quoteCount ?? 0,
    isReply: raw.isReply ?? false,
    lang: raw.lang ?? "en",
    media: Array.isArray(raw.media) ? raw.media.map((m: any) => ({
      type: m.type ?? "photo",
      url: m.url ?? m.fullUrl ?? undefined,
      previewUrl: m.previewUrl ?? m.thumbnailUrl ?? undefined,
    })) : [],
    author: {
      userName: raw.author?.userName ?? "",
      name: raw.author?.name ?? "",
      profilePicture: raw.author?.profilePicture ?? "",
      isBlueVerified: raw.author?.isBlueVerified ?? false,
      followers: raw.author?.followers ?? 0,
      description: raw.author?.description ?? "",
    },
    quotedTweet: raw.quoted_tweet ? parseTweet(raw.quoted_tweet) : null,
  }
}

export async function fetchUserTweets(userName: string, cursor?: string): Promise<TweetsResponse> {
  const apiKey = getApiKey()
  const params = new URLSearchParams({ q: `from:${userName}`, product: "Latest" })
  if (cursor) params.set("cursor", cursor)

  const res = await fetch(`${GETXAPI_BASE}/twitter/tweet/advanced_search?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    next: { revalidate: 300 }, // 5 分钟缓存
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GetXAPI error ${res.status}: ${err}`)
  }

  const data = await res.json()
  const rawTweets: any[] = data.tweets ?? []

  return {
    tweets: rawTweets.map(parseTweet),
    hasMore: data.has_more ?? false,
    nextCursor: data.next_cursor ?? undefined,
  }
}

export async function fetchTweetById(id: string): Promise<Tweet | null> {
  const apiKey = getApiKey()
  const res = await fetch(`${GETXAPI_BASE}/twitter/tweet/detail?id=${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    next: { revalidate: 3600 },
  })

  if (!res.ok) return null

  const data = await res.json()
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
