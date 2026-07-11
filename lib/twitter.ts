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

export interface ArticleInlineStyle {
  offset: number
  length: number
  style: "Bold" | "Italic"
}

export interface ArticleBlock {
  type: "unstyled" | "header-two" | "header-three" | "image" | "divider" | "blockquote" | "ordered-list-item" | "unordered-list-item"
  text?: string
  url?: string
  width?: number
  height?: number
  inlineStyleRanges?: ArticleInlineStyle[]
}

export interface Article {
  id: string
  tweetId: string
  title: string
  previewText: string
  coverImageUrl?: string
  author: TweetAuthor
  likeCount: number
  replyCount: number
  quoteCount: number
  viewCount: number
  createdAt: string
  contents: ArticleBlock[]
}

function getApiKey(): string {
  const key = process.env.GETXAPI_KEY
  if (!key) throw new Error("GETXAPI_KEY is not set in environment variables")
  return key
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
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
    text: decodeHtmlEntities((tweet.text as string | undefined) ?? ""),
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
  const params = new URLSearchParams({ userName })
  if (cursor) params.set("cursor", cursor)

  const res = await fetch(`${GETXAPI_BASE}/twitter/user/tweets?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    ...(forceRefresh || cursor ? { cache: "no-store" as RequestCache } : { next: { revalidate: 300 } }), // 刷新或分页时跳过缓存，否则 5 分钟缓存
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GetXAPI error ${res.status}: ${err}`)
  }

  const data = asRecord(await res.json())
  const rawTweets = Array.isArray(data.tweets) ? data.tweets : []

  return {
    tweets: rawTweets.map(parseTweet),
    hasMore: (data.has_more as boolean | undefined) ?? !!(data.next_cursor),
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
    hasMore: (data.has_more as boolean | undefined) ?? !!(data.next_cursor),
    nextCursor: (data.next_cursor as string | undefined) ?? undefined,
  }
}

export async function fetchTweetAuthorReplies(
  tweetId: string,
  authorUserName: string,
  options?: { maxReplies?: number; maxPages?: number },
): Promise<Tweet[]> {
  const apiKey = getApiKey()
  const maxReplies = options?.maxReplies ?? 20
  const maxPages = options?.maxPages ?? 2
  const q = `conversation_id:${tweetId} from:${authorUserName}`
  let cursor: string | undefined
  let pages = 0
  const replies: Tweet[] = []
  const seen = new Set<string>()

  while (pages < maxPages && replies.length < maxReplies) {
    const params = new URLSearchParams({ q, product: "Latest" })
    if (cursor) params.set("cursor", cursor)

    const res = await fetch(`${GETXAPI_BASE}/twitter/tweet/advanced_search?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`GetXAPI author replies error ${res.status}: ${err}`)
    }

    const data = asRecord(await res.json())
    const rawTweets = Array.isArray(data.tweets) ? data.tweets : []
    for (const tweet of rawTweets.map(parseTweet)) {
      if (!tweet.id || tweet.id === tweetId || seen.has(tweet.id)) continue
      seen.add(tweet.id)
      replies.push(tweet)
      if (replies.length >= maxReplies) break
    }

    pages += 1
    const hasMore = (data.has_more as boolean | undefined) ?? !!(data.next_cursor)
    cursor = (data.next_cursor as string | undefined) ?? undefined
    if (!hasMore || !cursor) break
  }

  return replies
}

export async function searchUserTweets(userName: string, query: string, cursor?: string): Promise<TweetsResponse> {
  const apiKey = getApiKey()
  const q = `from:${userName} ${query}`
  const params = new URLSearchParams({ q, product: "Latest" })
  if (cursor) params.set("cursor", cursor)

  const res = await fetch(`${GETXAPI_BASE}/twitter/tweet/advanced_search?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`GetXAPI search error ${res.status}: ${err}`)
  }

  const data = asRecord(await res.json())
  const rawTweets = Array.isArray(data.tweets) ? data.tweets : []

  return {
    tweets: rawTweets.map(parseTweet),
    hasMore: (data.has_more as boolean | undefined) ?? !!(data.next_cursor),
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

export function isArticleTweet(tweet: Tweet): boolean {
  return /^https?:\/\/x\.com\/i\/article\//.test(tweet.text.trim())
}

export async function fetchArticle(tweetId: string): Promise<Article | null> {
  const apiKey = getApiKey()
  const res = await fetch(`${GETXAPI_BASE}/twitter/article/get?id=${tweetId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    next: { revalidate: 3600 },
  })

  if (!res.ok) return null

  const data = asRecord(await res.json())
  const raw = asRecord(data.article)
  const author = asRecord(raw.author)

  const contents: ArticleBlock[] = Array.isArray(raw.contents)
    ? (raw.contents as unknown[]).map((b) => {
        const block = asRecord(b)
        return {
          type: (block.type as ArticleBlock["type"]) ?? "unstyled",
          text: (block.text as string | undefined) ?? undefined,
          url: (block.url as string | undefined) ?? undefined,
          width: (block.width as number | undefined) ?? undefined,
          height: (block.height as number | undefined) ?? undefined,
          inlineStyleRanges: Array.isArray(block.inlineStyleRanges)
            ? (block.inlineStyleRanges as ArticleInlineStyle[])
            : undefined,
        }
      })
    : []

  return {
    id: (raw.id as string | undefined) ?? "",
    tweetId,
    title: (raw.title as string | undefined) ?? "",
    previewText: (raw.preview_text as string | undefined) ?? "",
    coverImageUrl: (raw.cover_media_img_url as string | undefined) ?? undefined,
    author: {
      userName: (author.userName as string | undefined) ?? "",
      name: (author.name as string | undefined) ?? "",
      profilePicture: (author.profilePicture as string | undefined) ?? "",
      isBlueVerified: (author.isBlueVerified as boolean | undefined) ?? false,
      followers: (author.followers as number | undefined) ?? 0,
      description: (author.description as string | undefined) ?? "",
    },
    likeCount: (raw.likeCount as number | undefined) ?? 0,
    replyCount: (raw.replyCount as number | undefined) ?? 0,
    quoteCount: (raw.quoteCount as number | undefined) ?? 0,
    viewCount: (raw.viewCount as number | undefined) ?? 0,
    createdAt: (raw.createdAt as string | undefined) ?? "",
    contents,
  }
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
