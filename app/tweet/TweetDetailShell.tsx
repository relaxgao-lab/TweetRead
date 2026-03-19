"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { ChevronDown, RefreshCw, Sparkles } from "lucide-react"

import type { Tweet } from "@/lib/twitter"
import { formatRelativeTime, formatCount } from "@/lib/twitter"
import {
  accumulateCommentsForTweet,
  buildCommentAnalysisPrompt,
} from "@/lib/comment-analysis-client"
import { AiPanel, type AiMessage } from "@/components/ai-panel"
import { whisperSpeechService, type SpeechStatus } from "@/app/conversation/whisper-speech-service"
import { Button } from "@/components/ui/button"

type Props = {
  rootTweet: Tweet
  initialComments: Tweet[]
  initialCommentsHasMore: boolean
  initialCommentsCursor?: string
}

function smartCase(text: string): string {
  const alpha = text.replace(/[^a-zA-Z]/g, "")
  if (!alpha.length) return text
  const upperRatio = (text.match(/[A-Z]/g)?.length ?? 0) / alpha.length
  if (upperRatio < 0.7) return text
  return text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

function extractSpeakContent(content: string): string {
  const m = content.match(/\[\s*SPEAK\s*\]([\s\S]*?)\[\s*\/\s*SPEAK\s*\]/i)
  if (m) return m[1].trim()
  return content.replace(/\[\s*\/?\s*SPEAK\s*\]/gi, "").trim() || content
}

function detailSceneMeta(tweet: Tweet) {
  return {
    aiRole: "a professional tweet analyst and financial/tech news interpreter",
    userRole: "reader",
    context: `Tweet by @${tweet.author.userName} (${tweet.author.name}) — ${tweet.createdAt}:\n"${tweet.text}"\n\nEngagement: ${tweet.likeCount} likes, ${tweet.retweetCount} retweets, ${tweet.replyCount} replies, ${tweet.viewCount} views.`,
    scenario: tweet.text,
  }
}

export function TweetDetailShell({
  rootTweet,
  initialComments,
  initialCommentsHasMore,
  initialCommentsCursor,
}: Props) {
  const [isMobile, setIsMobile] = useState(false)

  // AI chat state（精简版）
  const [selectedTweet] = useState<Tweet | null>(rootTweet)
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [inputText, setInputText] = useState("")
  const [isChatLoading, setIsChatLoading] = useState(false)
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle")
  const [speechError, setSpeechError] = useState<string | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 评论列表 state
  const [comments, setComments] = useState<Tweet[]>(initialComments)
  const [commentsHasMore, setCommentsHasMore] = useState(initialCommentsHasMore)
  const [commentsCursor, setCommentsCursor] = useState<string | undefined>(initialCommentsCursor)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [commentAnalysisPrefetching, setCommentAnalysisPrefetching] = useState(false)

  // 响应式
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)")
    const update = () => setIsMobile(mql.matches)
    update()
    mql.addEventListener("change", update)
    return () => mql.removeEventListener("change", update)
  }, [])

  // AI：语音配置
  useEffect(() => {
    whisperSpeechService.updateConfig({
      onTranscript: (text) => {
        setInputText((prev) => prev + text)
        textareaRef.current?.focus()
      },
      onError: (err) => {
        setSpeechError(err)
        setSpeechStatus("idle")
      },
      onStatusChange: setSpeechStatus,
    })
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const sendMessage = useCallback(
    async (text: string, options?: { maxTokens?: number; displayContent?: string }) => {
      const tweet = selectedTweet
      if (!tweet || !text.trim() || isChatLoading) return

      const trimmed = text.trim()
      const userMsg: AiMessage = {
        role: "user",
        content: trimmed,
        ...(options?.displayContent ? { displayContent: options.displayContent } : {}),
      }
      const baseMessages = messages

      setMessages([...baseMessages, userMsg])
      setInputText("")
      setIsChatLoading(true)
      setSpeechError(null)

      let accumulated = ""
      let firstChunk = true
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [...baseMessages, { role: "user", content: trimmed }],
            sceneMeta: detailSceneMeta(tweet),
            ...(options?.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
          }),
        })
        if (!res.ok || !res.body) throw new Error("Chat API error")

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            const raw = line.slice(6).trim()
            if (raw === "[DONE]") continue
            try {
              const { delta } = JSON.parse(raw)
              if (delta) {
                accumulated += delta
                if (firstChunk) {
                  firstChunk = false
                  setIsChatLoading(false)
                  setMessages((prev) => [...prev, { role: "assistant", content: accumulated }])
                } else {
                  setMessages((prev) => {
                    const copy = [...prev]
                    copy[copy.length - 1] = { role: "assistant", content: accumulated }
                    return copy
                  })
                }
              }
            } catch {
              // ignore parse error
            }
          }
        }
      } catch {
        setSpeechError("对话请求失败，请稍后重试")
      } finally {
        setIsChatLoading(false)
      }
    },
    [isChatLoading, messages, selectedTweet],
  )

  const streamAssistantReply = useCallback(
    async (
      apiMessages: { role: "user" | "assistant"; content: string }[],
      tweet: Tweet,
      maxTokens?: number,
    ) => {
      setIsChatLoading(true)
      setSpeechError(null)
      let accumulated = ""
      let firstChunk = true
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: apiMessages,
            sceneMeta: detailSceneMeta(tweet),
            ...(maxTokens != null ? { maxTokens } : {}),
          }),
        })
        if (!res.ok || !res.body) throw new Error("Chat API error")

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue
            const raw = line.slice(6).trim()
            if (raw === "[DONE]") continue
            try {
              const { delta } = JSON.parse(raw)
              if (delta) {
                accumulated += delta
                if (firstChunk) {
                  firstChunk = false
                  setIsChatLoading(false)
                  setMessages((prev) => [...prev, { role: "assistant", content: accumulated }])
                } else {
                  setMessages((prev) => {
                    const copy = [...prev]
                    copy[copy.length - 1] = { role: "assistant", content: accumulated }
                    return copy
                  })
                }
              }
            } catch {
              // ignore parse error
            }
          }
        }
      } catch {
        setSpeechError("对话请求失败，请稍后重试")
      } finally {
        setIsChatLoading(false)
      }
    },
    [],
  )

  const handleCommentAnalysis = useCallback(async () => {
    if (!selectedTweet) return
    if (
      isChatLoading ||
      commentAnalysisPrefetching ||
      speechStatus === "recording" ||
      speechStatus === "processing"
    )
      return

    const tweet = rootTweet
    const needFetch = commentsHasMore
    const baseHistory = messages

    const shortUser: AiMessage = { role: "user", content: "评论分析", displayContent: "评论分析" }
    setMessages([...baseHistory, shortUser])
    if (needFetch) setCommentAnalysisPrefetching(true)

    const toApi = (list: AiMessage[]) =>
      list.map((m) => ({ role: m.role, content: m.content }))

    try {
      let finalList: Tweet[]
      let hitCap = false

      if (!needFetch) {
        finalList = comments
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
      } else {
        setCommentsError(null)
        setCommentsLoading(true)
        try {
          const result = await accumulateCommentsForTweet(rootTweet.id, {
            existing: comments,
            cursor: commentsCursor,
            hasMore: commentsHasMore,
            tweetMatches: true,
          })
          finalList = result.comments
          hitCap = result.hitCap
          setComments(result.comments)
          setCommentsHasMore(result.hasMore)
          setCommentsCursor(result.nextCursor)
        } finally {
          setCommentsLoading(false)
        }
      }

      const fullPrompt = buildCommentAnalysisPrompt(tweet, finalList, { hitCap })
      const fullUser: AiMessage = {
        role: "user",
        content: fullPrompt,
        displayContent: "评论分析",
      }
      setMessages([...baseHistory, fullUser])
      setCommentAnalysisPrefetching(false)

      const apiMessages = [...toApi(baseHistory), { role: "user" as const, content: fullPrompt }]
      await streamAssistantReply(apiMessages, tweet, 1800)
    } catch (e) {
      setCommentAnalysisPrefetching(false)
      setMessages(baseHistory)
      setSpeechError(e instanceof Error ? e.message : "加载评论失败")
    }
  }, [
    selectedTweet,
    isChatLoading,
    commentAnalysisPrefetching,
    speechStatus,
    comments,
    commentsHasMore,
    commentsCursor,
    rootTweet,
    messages,
    streamAssistantReply,
  ])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (commentAnalysisPrefetching) return
    void sendMessage(inputText)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (
        inputText.trim() &&
        !isChatLoading &&
        !commentAnalysisPrefetching &&
        speechStatus !== "recording" &&
        speechStatus !== "processing"
      ) {
        void sendMessage(inputText)
      }
    }
  }

  const handleVoiceToggle = async () => {
    if (speechStatus === "recording") {
      whisperSpeechService.stopListening()
      setSpeechStatus("idle")
      return
    }
    setSpeechError(null)
    setSpeechStatus("recording")
    try {
      await whisperSpeechService.startListening()
    } catch {
      setSpeechStatus("idle")
      setSpeechError("无法启动录音")
    }
  }

  const loadMoreComments = async () => {
    if (!commentsHasMore || !commentsCursor) return
    setCommentsError(null)
    setCommentsLoading(true)
    try {
      const params = new URLSearchParams({ id: rootTweet.id })
      params.set("cursor", commentsCursor)
      const res = await fetch(`/api/tweet-conversation?${params.toString()}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`Error ${res.status}`)
      const data = await res.json()
      const incoming: Tweet[] = data.comments ?? []
      setComments((prev) => [...prev, ...incoming])
      setCommentsHasMore(Boolean(data.hasMore))
      setCommentsCursor(data.nextCursor as string | undefined)
    } catch (e) {
      setCommentsError(e instanceof Error ? e.message : "加载评论失败")
    } finally {
      setCommentsLoading(false)
    }
  }

  return (
    <div
      className="flex flex-col overflow-hidden relative mobile-bg-scroll bg-fixed w-full max-w-[100vw] min-w-0 h-[var(--app-height)]"
      style={{
        background: "linear-gradient(135deg, #dce8f0 0%, #ede8e0 40%, #e4ece6 100%)",
      }}
    >
      <div className="absolute inset-0 bg-white/60 backdrop-blur-[1px] pointer-events-none z-0" />

      {/* Header */}
      <header className="sticky top-0 z-20 shrink-0 bg-white/80 border-b border-gray-200 shadow-sm backdrop-blur-sm pt-[env(safe-area-inset-top)]">
        <div className="px-4 py-2.5 flex items-center gap-3">
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-900">
            返回首页
          </Link>
          <h1 className="text-xl md:text-lg font-bold text-gray-900 tracking-tight shrink-0">TweetRead</h1>
        </div>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden">
        {/* 左侧：推文详情 + 评论 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden min-w-0">
          <div className="flex-1 overflow-y-auto hide-vertical-scrollbar min-h-0">
            <div className="max-w-2xl mx-auto py-4 px-4">
              {/* 原推文 */}
              <article className="bg-white/90 rounded-2xl border border-gray-200/80 p-4 shadow-sm mb-4">
                <div className="flex gap-3">
                  <div className="shrink-0">
                    {rootTweet.author.profilePicture ? (
                      <Image
                        src={rootTweet.author.profilePicture}
                        alt={rootTweet.author.name}
                        width={40}
                        height={40}
                        className="w-10 h-10 rounded-full object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-sm font-bold">
                        {rootTweet.author.name?.[0] ?? "?"}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      <span className="font-semibold text-sm text-gray-900 truncate">{rootTweet.author.name}</span>
                      <span className="text-sm md:text-xs text-gray-400 shrink-0">@{rootTweet.author.userName}</span>
                      <span className="text-sm md:text-xs text-gray-300 shrink-0">·</span>
                      <span className="text-sm md:text-xs text-gray-400 shrink-0">
                        {formatRelativeTime(rootTweet.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-base md:text-sm text-gray-800 leading-relaxed whitespace-pre-wrap break-words">
                      {smartCase(rootTweet.text)}
                    </p>
                    {rootTweet.textZh && (
                      <p className="mt-1 text-base md:text-sm text-gray-500 leading-relaxed whitespace-pre-wrap break-words">
                        {rootTweet.textZh}
                      </p>
                    )}
                  </div>
                </div>
              </article>

              {/* 评论列表 */}
              <div className="bg-white/80 rounded-2xl border border-gray-200/80 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 text-sm font-medium text-gray-700">评论</div>
                <div className="divide-y divide-gray-100">
                  {comments.map((c) => (
                    <div key={c.id} className="px-4 py-3 text-sm">
                      <div className="flex gap-3">
                        <div className="shrink-0">
                          {c.author.profilePicture ? (
                            <Image
                              src={c.author.profilePicture}
                              alt={c.author.name}
                              width={32}
                              height={32}
                              className="w-8 h-8 rounded-full object-cover"
                              unoptimized
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-xs font-bold">
                              {c.author.name?.[0] ?? "?"}
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-1.5 flex-wrap">
                            <span className="font-medium text-gray-900 truncate">{c.author.name}</span>
                            <span className="text-xs text-gray-400 shrink-0">@{c.author.userName}</span>
                            <span className="text-xs text-gray-300 shrink-0">·</span>
                            <span className="text-xs text-gray-400 shrink-0">
                              {formatRelativeTime(c.createdAt)}
                            </span>
                          </div>
                          <p className="mt-1 text-gray-800 whitespace-pre-wrap break-words">{smartCase(c.text)}</p>
                          {c.textZh && (
                            <p className="mt-1 text-gray-500 whitespace-pre-wrap break-words">{c.textZh}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}

                  {!commentsLoading && comments.length === 0 && !commentsError && (
                    <div className="px-4 py-8 text-center text-xs text-gray-400">暂无评论</div>
                  )}
                  {commentsError && (
                    <div className="px-4 py-3 text-xs text-red-600 flex items-center justify-between bg-red-50 border-t border-red-100">
                      <span>{commentsError}</span>
                      <button
                        type="button"
                        className="text-[11px] text-red-600 underline-offset-2 hover:underline"
                        onClick={loadMoreComments}
                      >
                        重试
                      </button>
                    </div>
                  )}
                </div>

                {commentsHasMore && !commentsError && (
                  <div className="border-t border-gray-100 px-4 py-2.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={commentsLoading}
                      className="w-full justify-center gap-2"
                      onClick={loadMoreComments}
                    >
                      {commentsLoading ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          加载中...
                        </>
                      ) : (
                        <>
                          <ChevronDown className="h-3.5 w-3.5" />
                          加载更多评论
                        </>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 右侧 / 底部：AI 面板 */}
        {!isMobile && (
          <AiPanel
            variant="desktop"
            selectedTweet={selectedTweet}
            messages={messages}
            inputText={inputText}
            quotedSelection={null}
            isChatLoading={isChatLoading}
            speechStatus={speechStatus}
            speechError={speechError}
            onClose={() => {}}
            onSendPreset={(text) => void sendMessage(text)}
            onCommentAnalysis={() => void handleCommentAnalysis()}
            commentsLoading={commentsLoading}
            commentAnalysisPrefetching={commentAnalysisPrefetching}
            onInputChange={(value) => setInputText(value)}
            onAssistantTextSelect={() => {}}
            onClearQuotedSelection={() => {}}
            onSubmit={handleSubmit}
            onKeyDown={handleKeyDown}
            onVoiceToggle={handleVoiceToggle}
            onDismissSpeechError={() => setSpeechError(null)}
            messagesEndRef={messagesEndRef}
            textareaRef={textareaRef}
            formatTweetText={smartCase}
            renderAssistantContent={extractSpeakContent}
            width={420}
            minWidth={280}
            isOpen
            noTransition={false}
          />
        )}
      </div>

      {/* 手机端：悬浮打开 AI 的按钮 + 全屏面板 */}
      {isMobile && (
        <div className="fixed right-4 bottom-[env(safe-area-inset-bottom,16px)] z-30">
          <Button
            className="rounded-full shadow-lg flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={() => {
              const panel = document.getElementById("tweet-detail-mobile-ai")
              panel?.classList.remove("hidden")
            }}
          >
            <Sparkles className="h-4 w-4" />
            <span className="text-xs">AI 助手</span>
          </Button>
        </div>
      )}

      {isMobile && (
        <div
          id="tweet-detail-mobile-ai"
          className="hidden fixed inset-0 z-40 bg-black/40 flex items-end"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              e.currentTarget.classList.add("hidden")
            }
          }}
        >
          <div className="w-full">
            <AiPanel
              variant="mobile"
              selectedTweet={selectedTweet}
              messages={messages}
              inputText={inputText}
              quotedSelection={null}
              isChatLoading={isChatLoading}
              speechStatus={speechStatus}
              speechError={speechError}
              onClose={() => {
                const panel = document.getElementById("tweet-detail-mobile-ai")
                panel?.classList.add("hidden")
              }}
              onExpand={() => {}}
              onSendPreset={(text) => void sendMessage(text)}
              onCommentAnalysis={() => void handleCommentAnalysis()}
              commentsLoading={commentsLoading}
              commentAnalysisPrefetching={commentAnalysisPrefetching}
              onInputChange={(value) => setInputText(value)}
              onAssistantTextSelect={() => {}}
              onClearQuotedSelection={() => {}}
              onSubmit={handleSubmit}
              onKeyDown={handleKeyDown}
              onVoiceToggle={handleVoiceToggle}
              onDismissSpeechError={() => setSpeechError(null)}
              messagesEndRef={messagesEndRef}
              textareaRef={textareaRef}
              formatTweetText={smartCase}
              renderAssistantContent={extractSpeakContent}
              sheetHeight={Math.round(window.innerHeight * 0.7)}
              isDragging={false}
              sheetState="half"
              onHandleTouchStart={() => {}}
              onHandleTouchMove={() => {}}
              onHandleTouchEnd={() => {}}
            />
          </div>
        </div>
      )}
    </div>
  )
}

