import type { Tweet } from "@/lib/twitter"

const DEFAULT_MAX_PAGES = 15
const DEFAULT_MAX_COMMENTS = 400
const PROMPT_BODY_MAX_CHARS = 45_000

export async function fetchTweetCommentsPage(
  tweetId: string,
  cursor?: string,
): Promise<{ comments: Tweet[]; hasMore: boolean; nextCursor: string | undefined }> {
  const params = new URLSearchParams({ id: tweetId })
  if (cursor) params.set("cursor", cursor)
  const res = await fetch(`/api/tweet-conversation?${params.toString()}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`评论接口 ${res.status}`)
  const data = await res.json()
  return {
    comments: (data.comments ?? []) as Tweet[],
    hasMore: Boolean(data.hasMore),
    nextCursor: data.nextCursor as string | undefined,
  }
}

export type CommentAccumulateStart = {
  existing: Tweet[]
  cursor: string | undefined
  hasMore: boolean
  /** false = 当前内存评论属于别的推文，从首屏重新拉 */
  tweetMatches: boolean
}

export async function accumulateCommentsForTweet(
  tweetId: string,
  start: CommentAccumulateStart,
  options?: { maxPages?: number; maxComments?: number },
): Promise<{
  comments: Tweet[]
  hasMore: boolean
  nextCursor: string | undefined
  hitCap: boolean
}> {
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES
  const maxComments = options?.maxComments ?? DEFAULT_MAX_COMMENTS

  let list = start.tweetMatches ? [...start.existing] : []
  let cursor = start.tweetMatches ? start.cursor : undefined
  let hasMore = start.tweetMatches ? start.hasMore : true

  if (!start.tweetMatches) {
    list = []
    cursor = undefined
    hasMore = true
  }

  if (!hasMore) {
    return { comments: list, hasMore: false, nextCursor: cursor, hitCap: false }
  }

  let pages = 0
  let hitCap = false

  while (hasMore && pages < maxPages && list.length < maxComments) {
    const page = await fetchTweetCommentsPage(tweetId, cursor)
    pages += 1
    const room = maxComments - list.length
    const slice = page.comments.slice(0, room)
    list = [...list, ...slice]

    if (list.length >= maxComments && page.comments.length > slice.length) {
      hitCap = true
      hasMore = true
      cursor = page.nextCursor
      break
    }

    hasMore = page.hasMore
    cursor = page.nextCursor
    if (!page.hasMore) break
    if (!cursor) break
  }

  if (pages >= maxPages && hasMore) hitCap = true

  return { comments: list, hasMore, nextCursor: cursor, hitCap }
}

function formatOneComment(c: Tweet, index: number): string {
  const zh = c.textZh?.trim()
  const body = zh ? `${c.text.trim()}\n（译文：${zh}）` : c.text.trim()
  return `${index + 1}. @${c.author.userName}：${body}`
}

export function buildCommentAnalysisPrompt(
  tweet: Tweet,
  comments: Tweet[],
  opts?: { hitCap?: boolean },
): string {
  const header = `以下是原推文（供你对照语境）：
@${tweet.author.userName}：${tweet.text.trim()}

下面是一条推文下的评论列表。请用中文归纳、总结评论中的主要观点，可按立场或主题分组，并简要说明各组的代表意见。若评论为空或极少，直接说明即可。回答请使用 [SPEAK]...[/SPEAK] 包裹适合朗读的摘要。`

  const capNote = opts?.hitCap
    ? "\n\n（说明：评论数量较多，以下仅包含已加载的部分评论，归纳时请注明分析基于部分评论。）\n"
    : "\n"

  let body = comments.map((c, i) => formatOneComment(c, i)).join("\n\n")
  if (!body.trim()) body = "（暂无评论）"

  if (body.length > PROMPT_BODY_MAX_CHARS) {
    body = `${body.slice(0, PROMPT_BODY_MAX_CHARS)}\n\n…（以下省略，因篇幅过长已截断）`
  }

  return `${header}${capNote}\n评论列表：\n${body}`
}
