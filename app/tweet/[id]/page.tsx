import { notFound } from "next/navigation"

import type { Tweet } from "@/lib/twitter"
import { fetchTweetById, fetchTweetConversation } from "@/lib/twitter"
import { TweetDetailShell } from "@/app/tweet/TweetDetailShell"

type PageProps = {
  params: { id: string }
}

export default async function TweetDetailPage({ params }: PageProps) {
  const id = decodeURIComponent(params.id)

  let rootTweet: Tweet | null = null
  try {
    rootTweet = await fetchTweetById(id)
  } catch {
    rootTweet = null
  }

  if (!rootTweet) {
    notFound()
  }

  let initialComments: Tweet[] = []
  let initialCommentsHasMore = false
  let initialCommentsCursor: string | undefined

  try {
    const conv = await fetchTweetConversation(id)
    initialComments = conv.tweets
    initialCommentsHasMore = conv.hasMore
    initialCommentsCursor = conv.nextCursor
  } catch {
    // 评论加载失败时允许页面仍然渲染，只是没有初始评论
  }

  return (
    <TweetDetailShell
      rootTweet={rootTweet}
      initialComments={initialComments}
      initialCommentsHasMore={initialCommentsHasMore}
      initialCommentsCursor={initialCommentsCursor}
    />
  )
}

