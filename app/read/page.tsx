'use client'

import { Suspense, useState, useCallback, useEffect, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft, ChevronDown, Heart, MessageCircle, Eye } from 'lucide-react'
import Image from 'next/image'
import type { Tweet } from '@/lib/twitter'

type TweetsResponse = { tweets: Tweet[]; hasMore: boolean; nextCursor?: string }
import { formatRelativeTime, formatCount } from '@/lib/twitter'

// ── 单条推文卡片（复刻首页 TweetCard 视觉样式）────────────────────────────
function ReadTweetCard({ tweet }: { tweet: Tweet }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const shouldShowExpand = tweet.text && tweet.text.length > 140

  return (
    <article className="px-4 py-4 bg-white/75 tweet-card">
      <div className="flex gap-3">
        <div className="shrink-0">
          {tweet.author.profilePicture ? (
            <Image
              src={tweet.author.profilePicture}
              alt={tweet.author.name}
              width={40} height={40}
              className="w-10 h-10 rounded-full object-cover"
              unoptimized
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-sm font-bold">
              {tweet.author.name?.[0] ?? '?'}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="font-semibold text-base text-gray-900 truncate">{tweet.author.name}</span>
            <span className="text-sm text-gray-400 shrink-0">@{tweet.author.userName}</span>
            <span className="text-sm text-gray-300 shrink-0">·</span>
            <span className="text-sm text-gray-400 shrink-0">{formatRelativeTime(tweet.createdAt)}</span>
          </div>
          <p className={`mt-1.5 text-base text-gray-800 leading-relaxed whitespace-pre-wrap break-words select-text ${isExpanded ? '' : 'line-clamp-6'}`}>
            {tweet.text}
          </p>
          {shouldShowExpand && (
            <button
              type="button"
              className="mt-1.5 text-xs text-emerald-600 hover:text-emerald-700 font-medium"
              onClick={e => { e.stopPropagation(); setIsExpanded(v => !v) }}
            >
              {isExpanded ? '收起' : '展开全文'}
            </button>
          )}
          {tweet.media.length > 0 && tweet.media[0].type === 'photo' && tweet.media[0].url && (
            <div className="mt-2 rounded-xl overflow-hidden border border-gray-200/80">
              <img
                src={tweet.media[0].url}
                alt="media"
                className="w-full max-h-48 object-cover"
                loading="lazy"
                onClick={e => e.stopPropagation()}
              />
            </div>
          )}
          <div className="mt-2.5 flex items-center gap-4 text-sm text-gray-400">
            <span className="flex items-center gap-1"><Heart className="h-3.5 w-3.5" />{formatCount(tweet.likeCount)}</span>
            <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" />{formatCount(tweet.replyCount)}</span>
            {tweet.viewCount > 0 && (
              <span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" />{formatCount(tweet.viewCount)}</span>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

// ── 骨架屏 ──────────────────────────────────────────────────────────────────
function Skeleton() {
  return (
    <div className="divide-y divide-gray-100/80">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="px-4 py-4 bg-white/75 animate-pulse">
          <div className="flex gap-3">
            <div className="w-10 h-10 rounded-full bg-gray-200 shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 bg-gray-200 rounded" />
              <div className="h-3 w-full bg-gray-200 rounded" />
              <div className="h-3 w-4/5 bg-gray-200 rounded" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function ReadPageFallback() {
  return (
    <div className="h-[var(--app-height)] flex flex-col bg-background overflow-hidden">
      <header className="sticky top-0 z-20 shrink-0 bg-white/80 border-b border-gray-200 shadow-sm backdrop-blur-sm">
        <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <div className="h-7 w-7 rounded-md bg-gray-100" />
          <div className="h-5 w-32 rounded bg-gray-100" />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto overscroll-none">
        <div className="max-w-3xl mx-auto">
          <Skeleton />
        </div>
      </div>
    </div>
  )
}

// ── 主页面 ───────────────────────────────────────────────────────────────────
function ReadPageContent() {
  const searchParams = useSearchParams()
  const scrollRef = useRef<HTMLDivElement>(null)

  const [tweets, setTweets] = useState<Tweet[]>([])
  const [oldestCursor, setOldestCursor] = useState<string | undefined>()
  const [hasOlder, setHasOlder] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [user, setUser] = useState('')
  const [error, setError] = useState('')

  const fetchPage = useCallback(async (userName: string, cursor?: string) => {
    const params = new URLSearchParams({ userName })
    if (cursor) params.set("cursor", cursor)
    const res = await fetch(`/api/db/tweets?${params}`)
    if (!res.ok) throw new Error("加载失败，请稍后重试")
    return res.json() as Promise<TweetsResponse>
  }, [])

  useEffect(() => {
    const userName = searchParams.get('user')?.trim()
    if (!userName) return
    setUser(userName)
    setIsLoading(true)
    setError('')
    fetchPage(userName)
      .then(({ tweets, hasMore, nextCursor }) => {
        setTweets(tweets)
        setHasOlder(hasMore)
        setOldestCursor(nextCursor)
      })
      .catch(e => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setIsLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadMore = async () => {
    if (!oldestCursor || isLoadingOlder) return
    setIsLoadingOlder(true)
    try {
      const { tweets: more, hasMore, nextCursor } = await fetchPage(user, oldestCursor)
      setTweets(prev => [...prev, ...more])
      setHasOlder(hasMore)
      setOldestCursor(nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setIsLoadingOlder(false)
    }
  }

  return (
    <div className="h-[var(--app-height)] flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <header className="sticky top-0 z-20 shrink-0 bg-white/80 border-b border-gray-200 shadow-sm backdrop-blur-sm">
        <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <button
            onClick={() => window.history.back()}
            className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 transition-colors shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex-1 min-w-0">
            <span className="text-base font-bold text-gray-900">@{user || '…'}</span>
            <span className="text-sm text-gray-400 ml-2">从早到晚</span>
          </div>
          {tweets.length > 0 && (
            <span className="text-xs text-gray-400 shrink-0">{tweets.length} 条</span>
          )}
        </div>
      </header>

      {/* Feed */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-none">
        <div className="max-w-3xl mx-auto">

          {isLoading && <Skeleton />}
          {error && <div className="text-center text-sm text-red-500 py-8">{error}</div>}

          <div className="divide-y divide-gray-100/80">
            {tweets.map(tweet => (
              <ReadTweetCard key={tweet.id} tweet={tweet} />
            ))}
          </div>

          {hasOlder && !isLoading && (
            <div className="flex justify-center py-6">
              <button
                onClick={loadMore}
                disabled={isLoadingOlder}
                className="flex items-center gap-2 px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg bg-white/80 backdrop-blur-sm hover:bg-gray-50 hover:border-gray-300 transition-all disabled:opacity-50"
              >
                {isLoadingOlder
                  ? <><span className="h-3.5 w-3.5 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin inline-block" />加载中…</>
                  : <><ChevronDown className="h-3.5 w-3.5" />加载更多</>}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ReadPage() {
  return (
    <Suspense fallback={<ReadPageFallback />}>
      <ReadPageContent />
    </Suspense>
  )
}
