"use client"

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react"
import Image from "next/image"
import { useParams, useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  ArrowLeft, Send, Mic, StopCircle, Volume2, VolumeX,
  Sparkles, ExternalLink, Heart, Repeat2, MessageCircle, Eye,
  ChevronDown, ChevronUp,
} from "lucide-react"
import type { Tweet } from "@/lib/twitter"
import { formatRelativeTime, formatCount } from "@/lib/twitter"
import { whisperSpeechService, type SpeechStatus } from "@/app/conversation/whisper-speech-service"
import { ACCOUNTS } from "@/config/accounts"

// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_CHAT_WIDTH = 280
const MAX_CHAT_WIDTH_PERCENT = 70
const DEFAULT_CHAT_WIDTH = 420

// ─── Types ────────────────────────────────────────────────────────────────────
interface Message {
  role: "user" | "assistant"
  content: string
}

type SheetState = "hidden" | "half" | "full"

// ─── Preset prompts ───────────────────────────────────────────────────────────
const PRESET_PROMPTS = [
  { label: "翻译",     text: "请将这条推文翻译成中文，并保持原意。" },
  { label: "解释背景", text: "请解释这条推文的背景，帮我理解它的含义和重要性。" },
  { label: "总结要点", text: "请用简洁的中文总结这条推文的核心要点。" },
  { label: "市场影响", text: "请分析这条信息对市场或相关领域可能的影响。" },
]

const pastelColors = [
  { bg: "bg-slate-100",  border: "border-slate-200",  text: "text-slate-700",  hover: "hover:bg-slate-200/70"  },
  { bg: "bg-violet-100", border: "border-violet-200", text: "text-violet-700", hover: "hover:bg-violet-200/70" },
  { bg: "bg-pink-100",   border: "border-pink-200",   text: "text-pink-700",   hover: "hover:bg-pink-200/70"   },
  { bg: "bg-amber-100",  border: "border-amber-200",  text: "text-amber-800",  hover: "hover:bg-amber-200/70"  },
]

const voiceToggleColor = {
  bg: "bg-emerald-100", border: "border-emerald-200",
  text: "text-emerald-700", hover: "hover:bg-emerald-200/70",
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function buildSceneMeta(tweet: Tweet) {
  const account = ACCOUNTS.find((a) => a.userName === tweet.author.userName)
  const authorContext = account?.aiContext ?? `This tweet is from @${tweet.author.userName} (${tweet.author.name}).`
  const context = `${authorContext}

Tweet by @${tweet.author.userName} (${tweet.author.name}) — ${tweet.createdAt}:
"${tweet.text}"

Engagement: ${tweet.likeCount} likes, ${tweet.retweetCount} retweets, ${tweet.replyCount} replies, ${tweet.viewCount} views.`
  return {
    aiRole: "a professional tweet analyst and financial/tech news interpreter",
    userRole: "reader",
    context,
    scenario: tweet.text,
  }
}

function extractSpeakContent(content: string): string {
  const match = content.match(/\[\s*SPEAK\s*\]([\s\S]*?)\[\s*\/\s*SPEAK\s*\]/i)
  if (match) return match[1].trim()
  return content.replace(/\[\s*\/?\s*SPEAK\s*\]/gi, "").trim() || content
}

// ─── Skeleton loading component ───────────────────────────────────────────────
function TweetSkeleton() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="shrink-0 bg-white border-b border-gray-200 px-4 py-2.5 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-gray-200 animate-pulse shrink-0" />
        <div className="w-20 h-4 bg-gray-200 animate-pulse rounded-md" />
      </header>
      <div className="flex-1 p-4 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-full bg-gray-200 animate-pulse shrink-0" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="w-32 h-4 bg-gray-200 animate-pulse rounded-md" />
            <div className="w-24 h-3 bg-gray-200 animate-pulse rounded-md" />
            <div className="w-16 h-3 bg-gray-200 animate-pulse rounded-md" />
          </div>
        </div>
        <div className="space-y-2.5">
          <div className="w-full h-4 bg-gray-200 animate-pulse rounded-md" />
          <div className="w-full h-4 bg-gray-200 animate-pulse rounded-md" />
          <div className="w-4/5 h-4 bg-gray-200 animate-pulse rounded-md" />
          <div className="w-3/5 h-4 bg-gray-200 animate-pulse rounded-md" />
        </div>
        <div className="h-48 bg-gray-100 animate-pulse rounded-xl" />
        <div className="flex gap-5 py-2 border-t border-gray-100">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="w-12 h-4 bg-gray-200 animate-pulse rounded-md" />
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Main page component ──────────────────────────────────────────────────────
export default function TweetPage() {
  const router = useRouter()
  const params = useParams()
  const tweetId = params.id as string

  // Tweet data
  const [tweet, setTweet] = useState<Tweet | null>(null)
  const [tweetLoading, setTweetLoading] = useState(true)
  const [tweetError, setTweetError] = useState<string | null>(null)

  // Chat state
  const [messages, setMessages] = useState<Message[]>([])
  const [inputText, setInputText] = useState("")
  const [isChatLoading, setIsChatLoading] = useState(false)
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle")
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [isSpeechEnabled, setIsSpeechEnabled] = useState(false)
  const isSpeechEnabledRef = useRef(false)
  isSpeechEnabledRef.current = isSpeechEnabled

  // Desktop: resizable AI panel
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartX = useRef(0)
  const resizeStartWidth = useRef(0)
  const lastChatWidthRef = useRef(DEFAULT_CHAT_WIDTH)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [allowChatTransition, setAllowChatTransition] = useState(false)
  const [mounted, setMounted] = useState(false)
  const justRestoredOpenRef = useRef(false)

  // Responsive
  const [isMobile, setIsMobile] = useState(false)

  // Mobile bottom sheet
  const [sheetState, setSheetState] = useState<SheetState>("half")
  const [currentDragHeight, setCurrentDragHeight] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [sheetHeights, setSheetHeights] = useState({
    hidden: 0,
    half: 480,
    full: 700,
  })
  const sheetTouchStartY = useRef(0)
  const sheetTouchStartH = useRef(0)

  // Page transition
  const [pageEntered, setPageEntered] = useState(false)
  const [isExiting, setIsExiting] = useState(false)

  // Swipe-back gesture
  const swipeStartX = useRef(0)
  const swipeStartY = useRef(0)
  const isSwipeGesture = useRef(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const transcriptCallback = useRef<((text: string) => void) | null>(null)

  // Derived
  const effectiveChatOpen = isMobile ? sheetState !== "hidden" : isChatOpen
  const sheetHeight = currentDragHeight ?? sheetHeights[sheetState]
  const noDesktopTransition = !allowChatTransition || isResizing || justRestoredOpenRef.current

  // ── Init ──────────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (typeof window === "undefined") return

    const updateSheetHeights = () => {
      setSheetHeights({
        hidden: 0,
        half: Math.round(window.innerHeight * 0.62),
        full: window.innerHeight - 44,
      })
    }
    updateSheetHeights()
    window.addEventListener("resize", updateSheetHeights)

    try {
      const savedW = localStorage.getItem("tweet-chat-width")
      if (savedW) {
        const n = parseInt(savedW, 10)
        if (!isNaN(n) && n >= MIN_CHAT_WIDTH) {
          const clamped = Math.min(n, window.innerWidth * (MAX_CHAT_WIDTH_PERCENT / 100))
          setChatWidth(clamped)
          lastChatWidthRef.current = clamped
        }
      }
    } catch {}

    const isM = window.matchMedia("(max-width: 767px)").matches
    setIsMobile(isM)

    if (!isM) {
      try {
        const saved = localStorage.getItem("tweet-chat-open")
        if (saved !== "false") {
          setAllowChatTransition(false)
          justRestoredOpenRef.current = true
          setIsChatOpen(true)
          return () => window.removeEventListener("resize", updateSheetHeights)
        }
      } catch {}
    }

    let raf1: number, raf2: number
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setAllowChatTransition(true))
    })
    return () => {
      window.removeEventListener("resize", updateSheetHeights)
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [])

  useEffect(() => {
    setMounted(true)
    // Page entry animation
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setPageEntered(true))
    })
  }, [])

  useEffect(() => {
    if (!effectiveChatOpen || !justRestoredOpenRef.current) return
    let raf1: number, raf2: number
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        justRestoredOpenRef.current = false
        setAllowChatTransition(true)
      })
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [effectiveChatOpen])

  useEffect(() => {
    if (!mounted || typeof window === "undefined") return
    localStorage.setItem("tweet-chat-open", isChatOpen.toString())
  }, [mounted, isChatOpen])

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)")
    const update = () => setIsMobile(mql.matches)
    update()
    mql.addEventListener("change", update)
    return () => mql.removeEventListener("change", update)
  }, [])

  // ── Desktop resize drag ────────────────────────────────────────────────────
  const handleResizeStart = (e: React.MouseEvent) => {
    setIsResizing(true)
    resizeStartX.current = e.clientX
    resizeStartWidth.current = chatWidth
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return
      const deltaX = resizeStartX.current - e.clientX
      const maxW = window.innerWidth * (MAX_CHAT_WIDTH_PERCENT / 100)
      const newW = Math.max(MIN_CHAT_WIDTH, Math.min(resizeStartWidth.current + deltaX, maxW))
      setChatWidth(newW)
      lastChatWidthRef.current = newW
    }
    const handleMouseUp = () => {
      if (!isResizing) return
      setIsResizing(false)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      localStorage.setItem("tweet-chat-width", lastChatWidthRef.current.toString())
    }
    if (isResizing) {
      window.addEventListener("mousemove", handleMouseMove)
      window.addEventListener("mouseup", handleMouseUp)
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [isResizing])

  // ── Mobile bottom sheet drag ───────────────────────────────────────────────
  const handleSheetDragStart = useCallback((e: React.TouchEvent) => {
    setIsDragging(true)
    sheetTouchStartY.current = e.touches[0].clientY
    sheetTouchStartH.current = currentDragHeight ?? sheetHeights[sheetState]
  }, [currentDragHeight, sheetHeights, sheetState])

  const handleSheetDragMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging) return
    const deltaY = sheetTouchStartY.current - e.touches[0].clientY
    const newH = Math.max(
      0,
      Math.min(sheetHeights.full, sheetTouchStartH.current + deltaY),
    )
    setCurrentDragHeight(newH)
  }, [isDragging, sheetHeights])

  const handleSheetDragEnd = useCallback(() => {
    setIsDragging(false)
    const h = currentDragHeight ?? sheetHeights[sheetState]
    setCurrentDragHeight(null)
    const distances: Record<SheetState, number> = {
      hidden: Math.abs(h - 0),
      half: Math.abs(h - sheetHeights.half),
      full: Math.abs(h - sheetHeights.full),
    }
    const nearest = (
      Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0]
    ) as SheetState
    setSheetState(nearest)
  }, [currentDragHeight, sheetHeights, sheetState])

  // ── Swipe-back gesture ─────────────────────────────────────────────────────
  const handleSwipeTouchStart = useCallback((e: React.TouchEvent) => {
    swipeStartX.current = e.touches[0].clientX
    swipeStartY.current = e.touches[0].clientY
    isSwipeGesture.current = e.touches[0].clientX < 30
  }, [])

  const handleSwipeTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!isSwipeGesture.current || !isMobile) { isSwipeGesture.current = false; return }
    const deltaX = e.changedTouches[0].clientX - swipeStartX.current
    const deltaY = Math.abs(e.changedTouches[0].clientY - swipeStartY.current)
    if (deltaX > 80 && deltaY < 50) handleBack()
    isSwipeGesture.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile])

  // ── Navigation ─────────────────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    setIsExiting(true)
    setTimeout(() => router.back(), 280)
  }, [router])

  // ── Tweet load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!tweetId) return
    setTweetLoading(true)
    fetch(`/api/tweets/${tweetId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.tweet) setTweet(data.tweet)
        else setTweetError(data.error ?? "推文加载失败")
      })
      .catch(() => setTweetError("网络错误，请重试"))
      .finally(() => setTweetLoading(false))
  }, [tweetId])

  // ── Auto-scroll messages ───────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // ── Voice setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    transcriptCallback.current = (text: string) => {
      setInputText((prev) => prev + text)
      textareaRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    whisperSpeechService.updateConfig({
      onTranscript: (text) => transcriptCallback.current?.(text),
      onError: (err) => { setSpeechError(err); setSpeechStatus("idle") },
      onStatusChange: setSpeechStatus,
    })
  }, [])

  // ── Send message (streaming) ───────────────────────────────────────────────
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isChatLoading || !tweet) return

    const userMsg: Message = { role: "user", content: text }
    setMessages((prev) => [...prev, userMsg])
    setInputText("")
    setIsChatLoading(true)
    setSpeechError(null)

    // On mobile: promote sheet to half if currently peeking
    if (isMobile && sheetState === "hidden") setSheetState("half")

    let accumulated = ""
    let firstChunk = true

    try {
      const sceneMeta = buildSceneMeta(tweet)
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, userMsg], sceneMeta }),
      })
      if (!res.ok) throw new Error(`Chat API ${res.status}`)
      if (!res.body) throw new Error("No response body")

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
                // Add assistant message with first content in one update
                setMessages((prev) => [...prev, { role: "assistant", content: accumulated }])
              } else {
                setMessages((prev) => {
                  const copy = [...prev]
                  copy[copy.length - 1] = { role: "assistant", content: accumulated }
                  return copy
                })
              }
            }
          } catch {}
        }
      }

      if (isSpeechEnabledRef.current && accumulated) {
        const speakText = extractSpeakContent(accumulated)
        if (speakText) {
          try { await whisperSpeechService.speak(speakText) }
          catch { setSpeechError("语音播放失败") }
        }
      }
    } catch {
      setSpeechError("对话请求失败，请稍后重试")
    } finally {
      setIsChatLoading(false)
    }
  }, [isChatLoading, tweet, messages, isMobile, sheetState])

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); sendMessage(inputText) }

  const handleVoiceToggle = async () => {
    if (speechStatus === "recording") {
      whisperSpeechService.stopListening()
      setSpeechStatus("idle")
      return
    }
    setSpeechError(null)
    setSpeechStatus("recording")
    try { await whisperSpeechService.startListening() }
    catch { setSpeechStatus("idle"); setSpeechError("无法启动录音") }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (inputText.trim() && !isChatLoading && speechStatus !== "recording" && speechStatus !== "processing") {
        sendMessage(inputText)
      }
    }
  }

  // ── Shared chat body (messages + prompts + input) ─────────────────────────
  const chatBody = (
    <>
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 hide-vertical-scrollbar">
        {/* 推文上下文卡片 */}
        <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 mb-1">
          <div className="flex items-center gap-2 mb-1.5">
            {tweet.author.profilePicture ? (
              <img src={tweet.author.profilePicture} alt={tweet.author.name}
                className="w-6 h-6 rounded-full object-cover shrink-0" />
            ) : (
              <div className="w-6 h-6 rounded-full bg-gray-200 shrink-0 flex items-center justify-center text-xs text-gray-500">
                {tweet.author.name?.[0]}
              </div>
            )}
            <span className="text-xs font-semibold text-gray-800 truncate">{tweet.author.name}</span>
            <span className="text-xs text-gray-400 truncate">@{tweet.author.userName}</span>
          </div>
          <p className="text-xs text-gray-700 leading-relaxed">{tweet.text}</p>
        </div>
        {messages.length === 0 && (
          <div className="text-center text-sm text-gray-500 mt-8 space-y-2">
            <p className="font-medium">有什么问题想了解吗？</p>
            <p className="text-xs text-gray-400">点击下方快捷按钮，或直接输入问题</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
            {msg.role === "user" && (
              <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium bg-violet-500 text-white">
                我
              </div>
            )}
            <div className={`flex-1 min-w-0 text-sm leading-relaxed ${msg.role === "user" ? "text-right" : "text-gray-800"}`}>
              {msg.role === "user" ? (
                <div className="inline-block max-w-[85%] rounded-2xl bg-violet-50 border border-violet-100 px-4 py-2 text-gray-900 text-left">
                  {msg.content}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="rounded-2xl bg-gray-50 border border-gray-100 px-4 py-2 whitespace-pre-wrap">
                    {msg.content
                      ? extractSpeakContent(msg.content)
                      : (
                        <span className="inline-flex gap-0.5 text-gray-400">
                          <span className="animate-dot-flash-1">·</span>
                          <span className="animate-dot-flash-2">·</span>
                          <span className="animate-dot-flash-3">·</span>
                        </span>
                      )}
                  </div>
                  {i === messages.length - 1 && speechStatus === "speaking" && (
                    <div className="flex items-center gap-2 text-xs text-emerald-600 pt-1">
                      <span className="flex items-end gap-0.5 h-4">
                        <span className="w-1 bg-emerald-500 rounded-full origin-bottom animate-sound-wave animate-sound-wave-1 h-3 inline-block" />
                        <span className="w-1 bg-emerald-500 rounded-full origin-bottom animate-sound-wave animate-sound-wave-2 h-4 inline-block" />
                        <span className="w-1 bg-emerald-500 rounded-full origin-bottom animate-sound-wave animate-sound-wave-3 h-3 inline-block" />
                        <span className="w-1 bg-emerald-500 rounded-full origin-bottom animate-sound-wave animate-sound-wave-4 h-4 inline-block" />
                      </span>
                      <Volume2 className="h-3.5 w-3.5 shrink-0" />
                      正在播放
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {isChatLoading && (
          <div className="flex gap-3">
            <div className="flex-1 min-w-0">
              <div className="inline-block rounded-2xl bg-gray-50 border border-gray-100 px-4 py-2 text-sm text-gray-500">
                <span className="inline-flex gap-0.5">
                  <span className="animate-dot-flash-1">·</span>
                  <span className="animate-dot-flash-2">·</span>
                  <span className="animate-dot-flash-3">·</span>
                </span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Preset prompts */}
      <div className="shrink-0 px-4 py-2 border-t border-gray-100 bg-gray-50/80">
        <div className="flex flex-wrap gap-x-3 gap-y-2 pt-1">
          {PRESET_PROMPTS.map((p, i) => {
            const c = pastelColors[i % pastelColors.length]
            return (
              <Button
                key={p.label}
                type="button"
                variant="outline"
                size="sm"
                disabled={isChatLoading || speechStatus === "recording" || speechStatus === "processing"}
                onClick={() => sendMessage(p.text)}
                className={`text-xs h-9 px-4 rounded-xl border ${c.bg} ${c.border} ${c.text} ${c.hover} disabled:opacity-50 transition-all`}
              >
                {p.label}
              </Button>
            )
          })}
        </div>
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-gray-200 p-4 bg-gray-50">
        <form onSubmit={handleSubmit}>
          <div className="flex flex-col rounded-lg border border-gray-300 bg-white shadow-sm focus-within:border-emerald-400 focus-within:ring-1 focus-within:ring-emerald-400/20 transition-all">
            <Textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入或语音...（Shift+Enter 换行）"
              disabled={isChatLoading || speechStatus === "processing"}
              className="block w-full min-h-[44px] max-h-[120px] text-sm resize-none pt-2.5 px-3 border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent placeholder:text-gray-400"
              rows={1}
            />
            <div className="flex items-center justify-end gap-1.5 p-1.5 shrink-0">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={handleVoiceToggle}
                disabled={isChatLoading || speechStatus === "processing"}
                className="h-8 w-8 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50 transition-colors"
                title={speechStatus === "recording" ? "停止录音" : "语音输入"}
              >
                {speechStatus === "recording"
                  ? <StopCircle className="h-4 w-4 text-red-500" />
                  : <Mic className="h-4 w-4" />
                }
              </Button>
              <Button
                type="submit"
                size="icon"
                disabled={!inputText.trim() || isChatLoading}
                className="h-8 w-8 bg-emerald-600 hover:bg-emerald-700 rounded-md disabled:opacity-50 transition-colors shadow-sm"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </form>
      </div>
    </>
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  if (tweetLoading) return <TweetSkeleton />
  if (tweetError || !tweet) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4">
        <p className="text-gray-500 text-sm">{tweetError ?? "推文不存在"}</p>
        <Button variant="ghost" onClick={handleBack}>← 返回</Button>
      </div>
    )
  }

  return (
    <div
      className="h-screen flex flex-col bg-gray-50 overflow-hidden"
      style={{
        transform: isExiting
          ? "translateX(100%)"
          : pageEntered ? "translateX(0)" : "translateX(28px)",
        opacity: isExiting ? 0 : pageEntered ? 1 : 0,
        transition: isExiting
          ? "transform 0.28s cubic-bezier(0.4,0,1,1), opacity 0.25s ease"
          : "transform 0.32s cubic-bezier(0.25,0.46,0.45,0.94), opacity 0.28s ease",
      }}
    >
      {/* ── Header ── */}
      <header className="shrink-0 bg-white border-b border-gray-200 px-4 py-2.5 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleBack}
          className="shrink-0 -ml-1 touch-manipulation"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="flex-1 text-sm font-semibold text-gray-800 truncate">推文详情</h1>
      </header>

      {/* ── Error bar ── */}
      {speechError && (
        <div className="shrink-0 bg-red-50 border-b border-red-200 text-red-600 text-xs px-4 py-1.5 flex justify-between items-center">
          <span>{speechError}</span>
          <button onClick={() => setSpeechError(null)} className="ml-2 touch-manipulation">✕</button>
        </div>
      )}

      {/* ── Main area ── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Tweet content (always visible) ── */}
        <div
          className="shrink-0 min-w-0 flex flex-col overflow-hidden bg-white"
          style={{
            width: isMobile
              ? "100%"
              : effectiveChatOpen ? `calc(100% - ${chatWidth}px - 6px)` : "100%",
            borderRight: isMobile ? "none" : "1px solid #e5e7eb",
            transition: noDesktopTransition ? "none" : "width 0.55s cubic-bezier(0.25, 0.1, 0.25, 1)",
          }}
        >
          <div
            className="flex-1 overflow-y-auto p-4 space-y-4 hide-vertical-scrollbar"
            style={{ paddingBottom: isMobile ? "env(safe-area-inset-bottom, 16px)" : "1rem" }}
            onTouchStart={handleSwipeTouchStart}
            onTouchEnd={handleSwipeTouchEnd}
          >
            {/* Author */}
            <div className="flex items-start gap-3">
              {tweet.author.profilePicture ? (
                <Image
                  src={tweet.author.profilePicture}
                  alt={tweet.author.name}
                  width={48}
                  height={48}
                  className="w-12 h-12 rounded-full object-cover shrink-0"
                  unoptimized
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-gray-200 shrink-0 flex items-center justify-center text-gray-500 font-bold">
                  {tweet.author.name?.[0]}
                </div>
              )}
              <div>
                <p className="font-bold text-gray-900 text-sm flex items-center gap-1">
                  {tweet.author.name}
                  {tweet.author.isBlueVerified && <span className="text-blue-500 text-xs">✓</span>}
                </p>
                <p className="text-gray-500 text-xs">@{tweet.author.userName}</p>
                <p className="text-gray-400 text-xs mt-0.5">{formatRelativeTime(tweet.createdAt)}</p>
              </div>
            </div>

            {/* Body */}
            <p className="text-gray-900 text-base leading-relaxed whitespace-pre-wrap break-words">
              {tweet.text}
            </p>

            {/* Media */}
            {tweet.media.length > 0 && (
              <div className="space-y-2">
                {tweet.media.map((m, i) => m.type === "photo" && m.url && (
                  <img
                    key={i}
                    src={m.url}
                    alt=""
                    className="w-full rounded-xl border border-gray-200 object-cover"
                    loading="lazy"
                  />
                ))}
              </div>
            )}

            {/* Quoted tweet */}
            {tweet.quotedTweet && (
              <div className="border border-gray-200 rounded-xl p-3 bg-gray-50">
                <p className="text-xs font-semibold text-gray-600 mb-1">@{tweet.quotedTweet.author.userName}</p>
                <p className="text-sm text-gray-700 line-clamp-4">{tweet.quotedTweet.text}</p>
              </div>
            )}

            {/* Engagement */}
            <div className="flex items-center gap-5 text-sm text-gray-500 py-2 border-t border-gray-100">
              <span className="flex items-center gap-1.5"><Heart className="h-4 w-4" />{formatCount(tweet.likeCount)}</span>
              <span className="flex items-center gap-1.5"><Repeat2 className="h-4 w-4" />{formatCount(tweet.retweetCount)}</span>
              <span className="flex items-center gap-1.5"><MessageCircle className="h-4 w-4" />{formatCount(tweet.replyCount)}</span>
              {tweet.viewCount > 0 && (
                <span className="flex items-center gap-1.5"><Eye className="h-4 w-4" />{formatCount(tweet.viewCount)}</span>
              )}
            </div>

            {/* Link */}
            <a
              href={tweet.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-blue-500 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              在 X 上查看原文
            </a>
          </div>
        </div>

        {/* ── Desktop: resize handle + AI panel ── */}
        {!isMobile && (
          <>
            <div
              role="separator"
              aria-label="调整 AI 窗口宽度"
              onMouseDown={handleResizeStart}
              className={`hidden md:flex shrink-0 flex-col items-center justify-center bg-gray-200 hover:bg-emerald-400 active:bg-emerald-500 cursor-col-resize select-none overflow-hidden ${
                isResizing ? "bg-emerald-500" : ""
              } ${effectiveChatOpen ? "w-1.5" : "w-0 pointer-events-none"}`}
              style={{ transition: noDesktopTransition ? "none" : "width 0.55s cubic-bezier(0.25, 0.1, 0.25, 1)" }}
            >
              <div className="w-0.5 h-8 rounded-full bg-gray-400 pointer-events-none shrink-0" />
            </div>

            <div
              className={`flex flex-col shrink-0 overflow-hidden ${!effectiveChatOpen ? "pointer-events-none" : ""}`}
              style={{
                width: effectiveChatOpen ? chatWidth : 0,
                minWidth: effectiveChatOpen ? MIN_CHAT_WIDTH : 0,
                transition: noDesktopTransition ? "none" : "width 0.55s cubic-bezier(0.25, 0.1, 0.25, 1)",
              }}
            >
              <div
                className="flex flex-col flex-1 min-w-0 h-full bg-white border-l border-gray-200"
                style={{
                  width: mounted ? chatWidth : DEFAULT_CHAT_WIDTH,
                  minWidth: mounted ? MIN_CHAT_WIDTH : DEFAULT_CHAT_WIDTH,
                  transform: effectiveChatOpen ? "translateX(0)" : "translateX(100%)",
                  transition: noDesktopTransition ? "none" : "transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1)",
                }}
              >
                {/* Desktop AI panel header */}
                <div className="shrink-0 px-4 py-2 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-gray-700">AI 解读助手</h3>
                    <p className="text-xs text-gray-500 mt-0.5">基于推文内容提问</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (isSpeechEnabled) { whisperSpeechService.stopSpeaking(); setSpeechError(null) }
                        setIsSpeechEnabled(!isSpeechEnabled)
                      }}
                      className={`shrink-0 h-8 px-2 border ${voiceToggleColor.bg} ${voiceToggleColor.border} ${voiceToggleColor.text} ${voiceToggleColor.hover}`}
                      title={isSpeechEnabled ? "关闭语音朗读" : "开启语音朗读"}
                    >
                      {isSpeechEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                      <span className="ml-1 text-xs">{isSpeechEnabled ? "语音开" : "语音关"}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsChatOpen(false)}
                      className="h-8 w-8 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md"
                      title="关闭"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {chatBody}
              </div>
            </div>

            {/* Desktop FAB when panel closed */}
            {!effectiveChatOpen && (
              <div className="fixed right-0 z-[100] flex justify-end pointer-events-none top-1/2 -translate-y-1/2">
                <Button
                  onClick={() => setIsChatOpen(true)}
                  className="pointer-events-auto h-20 pl-5 pr-4 w-auto rounded-l-2xl rounded-r-none bg-gray-200/95 hover:bg-gray-300/95 text-gray-700 shadow-md border border-l border-gray-300/50 flex items-center gap-2 transition-all hover:shadow-lg active:scale-[0.98]"
                  title="打开 AI 助手"
                >
                  <Sparkles className="h-9 w-9 text-emerald-600" />
                </Button>
              </div>
            )}
          </>
        )}

        {/* ── Mobile: bottom sheet ── */}
        {isMobile && (
          <div
            className="fixed bottom-0 left-0 right-0 z-50 bg-white rounded-t-2xl overflow-hidden flex flex-col"
            style={{
              height: sheetHeight,
              boxShadow: "0 -4px 32px rgba(0,0,0,0.14), 0 -1px 6px rgba(0,0,0,0.06)",
              transition: isDragging ? "none" : "height 0.32s cubic-bezier(0.32,0.72,0,1)",
            }}
          >
            {/* Drag handle */}
            <div
              className="shrink-0 pt-2.5 pb-1 flex justify-center touch-none select-none cursor-grab active:cursor-grabbing"
              onTouchStart={handleSheetDragStart}
              onTouchMove={handleSheetDragMove}
              onTouchEnd={handleSheetDragEnd}
            >
              <div className="w-9 h-1 bg-gray-300 rounded-full" />
            </div>

            {/* AI chat sheet */}
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                {/* AI panel header */}
                <div className="shrink-0 px-4 py-2 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Sparkles className="h-4 w-4 text-emerald-600 shrink-0" />
                    <h3 className="text-sm font-semibold text-gray-700">AI 解读助手</h3>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (isSpeechEnabled) { whisperSpeechService.stopSpeaking(); setSpeechError(null) }
                        setIsSpeechEnabled(!isSpeechEnabled)
                      }}
                      className={`h-8 px-2 border ${voiceToggleColor.bg} ${voiceToggleColor.border} ${voiceToggleColor.text} ${voiceToggleColor.hover}`}
                      title={isSpeechEnabled ? "关闭语音" : "开启语音"}
                    >
                      {isSpeechEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                    </Button>
                    {sheetState === "full" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setSheetState("half")}
                        className="h-10 w-10 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md touch-manipulation"
                        title="缩小"
                      >
                        <ChevronDown className="h-5 w-5" />
                      </Button>
                    )}
                    {sheetState === "half" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setSheetState("hidden")}
                        className="h-10 w-10 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md touch-manipulation"
                        title="收起"
                      >
                        <ChevronDown className="h-5 w-5" />
                      </Button>
                    )}
                  </div>
                </div>

                {/* Shared chat body */}
                <div
                  className="flex flex-col flex-1 min-h-0 overflow-hidden"
                  style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
                >
                  {chatBody}
                </div>
              </div>
          </div>
        )}
      </div>
    </div>
  )
}
