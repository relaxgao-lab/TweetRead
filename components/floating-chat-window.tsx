"use client"

import React, { useEffect, useRef, useState, useCallback } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, Loader2, Mic, Send, StopCircle, X } from "lucide-react"
import { AssistantMarkdown, SynonymClickContext } from "@/components/ai-panel"
import { buildLookupPrompt } from "@/lib/prompts"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useAutoScroll } from "@/lib/hooks"
import { useChatStream } from "@/lib/use-chat-stream"
import { readSelectionAnchor } from "@/lib/selection"
import { WhisperSpeechService } from "@/app/conversation/whisper-speech-service"
import type { SpeechStatus } from "@/app/conversation/whisper-speech-service"

const INITIAL_WIDTH = 380
const INITIAL_HEIGHT = 480
const MIN_WIDTH = 260
const MIN_HEIGHT = 240
const DRAG_THRESHOLD = 4

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"

interface FloatingChatWindowProps {
  initialPrompt: string
  displayContent: string
  sceneMeta: { aiRole: string; context: string }
  initialX: number
  initialY: number
  onClose: () => void
  /** 该窗口内对话的 max_tokens 上限（未传则走服务端默认值） */
  maxTokens?: number
}

function LoadingDots() {
  return (
    <span className="inline-flex gap-0.5 text-gray-400">
      <span className="animate-dot-flash-1">·</span>
      <span className="animate-dot-flash-2">·</span>
      <span className="animate-dot-flash-3">·</span>
    </span>
  )
}

const RESIZE_CURSORS: Record<ResizeDir, string> = {
  n: "ns-resize", s: "ns-resize",
  e: "ew-resize", w: "ew-resize",
  ne: "nesw-resize", sw: "nesw-resize",
  nw: "nwse-resize", se: "nwse-resize",
}

export function FloatingChatWindow({
  initialPrompt,
  displayContent,
  sceneMeta,
  initialX,
  initialY,
  onClose,
  maxTokens,
}: FloatingChatWindowProps) {
  const [mounted, setMounted] = useState(false)
  const [inputText, setInputText] = useState("")
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: INITIAL_WIDTH, height: INITIAL_HEIGHT })
  const [isDragging, setIsDragging] = useState(false)
  const [resizeDir, setResizeDir] = useState<ResizeDir | null>(null)

  // Quote state
  const [quotedSelection, setQuotedSelection] = useState<{ text: string } | null>(null)
  const [pendingQuote, setPendingQuote] = useState<{ text: string; x: number; y: number } | null>(null)

  // Voice state
  const [speechService] = useState(() => new WhisperSpeechService())
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle")
  const [speechError, setSpeechError] = useState<string | null>(null)

  const { messages, isLoading, chatError, sendMessage, abort } = useChatStream(sceneMeta, maxTokens)

  const dragStartRef = useRef<{ mouseX: number; mouseY: number; winX: number; winY: number } | null>(null)
  const hasDraggedRef = useRef(false)
  const resizeStartRef = useRef<{
    mouseX: number; mouseY: number
    winX: number; winY: number
    width: number; height: number
    dir: ResizeDir
  } | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const userMessageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const initializedRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isComposingRef = useRef(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const x = Math.max(8, Math.min(initialX - INITIAL_WIDTH / 2, window.innerWidth - INITIAL_WIDTH - 8))
    const y = Math.max(8, Math.min(initialY + 20, window.innerHeight - INITIAL_HEIGHT - 8))
    setPosition({ x, y })
  }, [initialX, initialY])

  useEffect(() => {
    if (!mounted || initializedRef.current) return
    initializedRef.current = true
    sendMessage(initialPrompt, displayContent, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted])

  useEffect(() => () => abort(), [abort])

  const getUserMessageNode = useCallback(
    (messageIndex: number) => userMessageRefs.current[messageIndex] ?? null,
    [],
  )

  const { userScrolledUp, latestTurnMode, hasNewMessage, spacerRef, scrollToBottom } = useAutoScroll(
    messagesContainerRef,
    messagesEndRef,
    messages,
    { getUserMessageNode },
  )
  const showScrollButton = (userScrolledUp || latestTurnMode) && hasNewMessage

  // ── Voice service setup ───────────────────────────────────────────────────
  useEffect(() => {
    speechService.updateConfig({
      onStatusChange: setSpeechStatus,
      onTranscript: (text) => setInputText((prev) => prev ? `${prev} ${text}` : text),
      onError: (err) => setSpeechError(err),
    })
    return () => {
      speechService.resetConfig()
      if (speechService.getStatus() === "recording") {
        void speechService.stopListening()
      }
    }
  }, [speechService])

  const handleVoiceToggle = useCallback(() => {
    setSpeechError(null)
    if (speechStatus === "recording") {
      void speechService.stopListening()
    } else if (speechStatus === "idle") {
      void speechService.startListening()
    }
  }, [speechService, speechStatus])

  // ── Quote: detect selection on assistant messages ─────────────────────────
  const handleAssistantMouseUp = useCallback((e: React.MouseEvent) => {
    const sel = readSelectionAnchor({ container: e.currentTarget as HTMLElement })
    if (sel && sel.text.trim().length > 0) {
      setPendingQuote({ text: sel.text.trim(), x: sel.anchorX, y: sel.anchorY })
    }
  }, [])

  // Dismiss pending quote on outside mousedown
  useEffect(() => {
    if (!pendingQuote) return
    const dismiss = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest("[data-quote-btn]")) setPendingQuote(null)
    }
    document.addEventListener("mousedown", dismiss)
    return () => document.removeEventListener("mousedown", dismiss)
  }, [pendingQuote])

  // ── Synonym chip click ────────────────────────────────────────────────────
  const handleSynonymClick = useCallback((word: string) => {
    sendMessage(buildLookupPrompt(word), `查词：「${word}」`)
  }, [sendMessage])

  // ── Send ──────────────────────────────────────────────────────────────────
  const handleSend = useCallback(() => {
    const trimmed = inputText.trim()
    if (!trimmed || isLoading) return
    const quoted = quotedSelection ?? undefined
    setInputText("")
    setQuotedSelection(null)
    sendMessage(trimmed, trimmed, undefined, quoted)
  }, [inputText, isLoading, quotedSelection, sendMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !isComposingRef.current) { e.preventDefault(); handleSend() }
  }, [handleSend])

  // ── Drag ──────────────────────────────────────────────────────────────────
  const handleDragStart = useCallback((clientX: number, clientY: number) => {
    hasDraggedRef.current = false
    dragStartRef.current = { mouseX: clientX, mouseY: clientY, winX: position.x, winY: position.y }
    setIsDragging(true)
  }, [position])

  useEffect(() => {
    if (!isDragging) return
    const onMove = (clientX: number, clientY: number) => {
      if (!dragStartRef.current) return
      const dx = clientX - dragStartRef.current.mouseX
      const dy = clientY - dragStartRef.current.mouseY
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) hasDraggedRef.current = true
      if (!hasDraggedRef.current) return
      const newX = Math.max(0, Math.min(dragStartRef.current.winX + dx, window.innerWidth - size.width))
      const newY = Math.max(0, Math.min(dragStartRef.current.winY + dy, window.innerHeight - 60))
      setPosition({ x: newX, y: newY })
    }
    const onMouseMove = (e: MouseEvent) => onMove(e.clientX, e.clientY)
    const onTouchMove = (e: TouchEvent) => { if (e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY) }
    const stop = () => { setIsDragging(false); dragStartRef.current = null }
    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", stop)
    document.addEventListener("touchmove", onTouchMove, { passive: true })
    document.addEventListener("touchend", stop)
    return () => {
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", stop)
      document.removeEventListener("touchmove", onTouchMove)
      document.removeEventListener("touchend", stop)
    }
  }, [isDragging, size.width])

  // ── Resize ────────────────────────────────────────────────────────────────
  const handleResizeStart = useCallback((e: React.MouseEvent, dir: ResizeDir) => {
    e.preventDefault()
    e.stopPropagation()
    resizeStartRef.current = {
      mouseX: e.clientX, mouseY: e.clientY,
      winX: position.x, winY: position.y,
      width: size.width, height: size.height,
      dir,
    }
    setResizeDir(dir)
  }, [position, size])

  useEffect(() => {
    if (!resizeDir) return
    const onMove = (clientX: number, clientY: number) => {
      const s = resizeStartRef.current
      if (!s) return
      const dx = clientX - s.mouseX
      const dy = clientY - s.mouseY

      let newW = s.width, newH = s.height, newX = s.winX, newY = s.winY

      if (s.dir.includes("e")) newW = Math.max(MIN_WIDTH, s.width + dx)
      if (s.dir.includes("w")) { newW = Math.max(MIN_WIDTH, s.width - dx); newX = s.winX + s.width - newW }
      if (s.dir.includes("s")) newH = Math.max(MIN_HEIGHT, s.height + dy)
      if (s.dir.includes("n")) { newH = Math.max(MIN_HEIGHT, s.height - dy); newY = s.winY + s.height - newH }

      setSize({ width: newW, height: newH })
      setPosition({ x: newX, y: newY })
    }
    const onMouseMove = (e: MouseEvent) => onMove(e.clientX, e.clientY)
    const stop = () => { setResizeDir(null); resizeStartRef.current = null }
    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", stop)
    return () => {
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", stop)
    }
  }, [resizeDir])

  // ── Resize handle helper ─────────────────────────────────────────────────
  const rh = (dir: ResizeDir, className: string) => (
    <div
      className={`absolute z-10 ${className}`}
      style={{ cursor: RESIZE_CURSORS[dir] }}
      onMouseDown={(e) => handleResizeStart(e, dir)}
    />
  )

  const el = (
    <div
      data-floating-chat
      className="fixed z-[400] flex flex-col bg-white rounded-2xl shadow-2xl border border-gray-200/80 overflow-hidden"
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
    >
      {/* Resize handles — edges */}
      {rh("n",  "top-0 left-2 right-2 h-1")}
      {rh("s",  "bottom-0 left-2 right-2 h-1")}
      {rh("e",  "right-0 top-2 bottom-2 w-1")}
      {rh("w",  "left-0 top-2 bottom-2 w-1")}
      {/* Resize handles — corners */}
      {rh("ne", "top-0 right-0 w-3 h-3")}
      {rh("nw", "top-0 left-0 w-3 h-3")}
      {rh("se", "bottom-0 right-0 w-3 h-3")}
      {rh("sw", "bottom-0 left-0 w-3 h-3")}

      {/* Title bar — drag handle */}
      <div
        className="flex items-center justify-between gap-2 px-4 py-2.5 bg-gray-50 border-b border-gray-100 shrink-0 select-none cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => { e.preventDefault(); handleDragStart(e.clientX, e.clientY) }}
        onTouchStart={(e) => { if (e.touches[0]) handleDragStart(e.touches[0].clientX, e.touches[0].clientY) }}
      >
        <h3 className="text-sm font-semibold text-gray-800 truncate">{displayContent}</h3>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
          className="shrink-0 p-1 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Messages */}
      <SynonymClickContext.Provider value={handleSynonymClick}>
      <div className="relative flex-1 min-h-0">
        {showScrollButton && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-gray-200 shadow-md text-xs text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            新消息 / 回到底部
          </button>
        )}
        <div
          ref={messagesContainerRef}
          className="h-full overflow-y-auto p-3 space-y-3 min-h-0"
        >
          {messages.map((msg, i) => (
            <div
              key={i}
              ref={(node) => {
                if (msg.role === "user") userMessageRefs.current[i] = node
              }}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              {msg.role === "user" ? (
                <div className="inline-block max-w-[85%] rounded-2xl bg-violet-50 border border-violet-100 overflow-hidden text-left">
                  {msg.quoted && (
                    <div className="border-b border-violet-100 bg-violet-50/70 px-3 py-2">
                      <p className="text-xs leading-relaxed text-violet-700 line-clamp-2 whitespace-pre-wrap break-words">
                        {msg.quoted.text}
                      </p>
                    </div>
                  )}
                  <div className="px-3 py-2 text-sm text-gray-900">
                    {msg.displayContent ?? msg.content}
                  </div>
                </div>
              ) : (
                <div
                  className="rounded-2xl bg-gray-50 border border-gray-100 px-3 py-2 text-sm w-full select-text"
                  onMouseUp={handleAssistantMouseUp}
                >
                  {msg.content ? <AssistantMarkdown text={msg.content} /> : <LoadingDots />}
                </div>
              )}
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-gray-50 border border-gray-100 px-3 py-2 text-sm">
                <LoadingDots />
              </div>
            </div>
          )}
          {chatError && (
            <div className="flex justify-start">
              <div
                className="rounded-2xl bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
              >
                {chatError}
              </div>
            </div>
          )}
          <div ref={spacerRef} aria-hidden style={{ height: 0, marginTop: 0 }} />
          <div ref={messagesEndRef} />
        </div>
      </div>
      </SynonymClickContext.Provider>

      {/* Input */}
      <div className="shrink-0 border-t border-gray-100 p-2.5 bg-gray-50/80">
        {speechError && (
          <div className="mb-2 text-xs text-red-600 flex items-center justify-between gap-2">
            <span>{speechError}</span>
            <button type="button" onClick={() => setSpeechError(null)} className="text-red-600 hover:text-red-800">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {quotedSelection && (
          <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50/80 px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs leading-relaxed text-emerald-800 line-clamp-2 whitespace-pre-wrap break-words">
                {quotedSelection.text}
              </p>
              <button
                type="button"
                onClick={() => setQuotedSelection(null)}
                className="shrink-0 text-emerald-600 hover:text-emerald-800"
                title="移除引用"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-gray-300 bg-white px-2 pt-1.5 pb-1 focus-within:border-emerald-400 focus-within:ring-1 focus-within:ring-emerald-400/20 transition-all">
          <Textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => { isComposingRef.current = true }}
            onCompositionEnd={() => { isComposingRef.current = false }}
            placeholder="继续追问…"
            disabled={isLoading || speechStatus === "processing" || speechStatus === "preparing"}
            rows={1}
            className="flex-1 min-h-[32px] max-h-[96px] text-sm resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent placeholder:text-gray-400 py-1 px-0"
          />
          <Button
            type="button"
            size="icon"
            onClick={handleVoiceToggle}
            disabled={isLoading || speechStatus === "processing" || speechStatus === "preparing"}
            className="h-7 w-7 mb-0.5 shrink-0 bg-transparent hover:bg-gray-100 text-gray-500 hover:text-gray-700 rounded-md disabled:opacity-50 shadow-none border-0"
            title={speechStatus === "recording" ? "停止录音" : speechStatus === "preparing" ? "准备中…" : "语音输入"}
          >
            {speechStatus === "recording"
              ? <StopCircle className="h-4 w-4 text-red-500" />
              : speechStatus === "preparing"
              ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
              : <Mic className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            size="icon"
            onClick={handleSend}
            disabled={!inputText.trim() || isLoading}
            className="h-7 w-7 mb-0.5 shrink-0 bg-emerald-600 hover:bg-emerald-700 rounded-md disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )

  // Quote button portal
  const quoteBtn = pendingQuote && mounted && typeof document !== "undefined"
    ? createPortal(
        <button
          data-quote-btn
          type="button"
          onMouseDown={(e) => {
            e.preventDefault()
            setQuotedSelection({ text: pendingQuote.text })
            setPendingQuote(null)
            textareaRef.current?.focus()
          }}
          className="fixed z-[500] px-2.5 py-1 text-xs font-medium bg-gray-900 text-white rounded-md shadow-lg hover:bg-gray-700 transition-colors select-none"
          style={{ left: pendingQuote.x, top: pendingQuote.y - 36 }}
        >
          引用
        </button>,
        document.body
      )
    : null

  if (!mounted || typeof document === "undefined") return null
  return (
    <>
      {createPortal(el, document.body)}
      {quoteBtn}
    </>
  )
}
