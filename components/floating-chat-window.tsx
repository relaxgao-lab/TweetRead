"use client"

import React, { useEffect, useRef, useState, useCallback } from "react"
import { createPortal } from "react-dom"
import { X, Send } from "lucide-react"
import { AssistantMarkdown } from "@/components/ai-panel"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useChatStream } from "@/lib/use-chat-stream"

const WINDOW_WIDTH = 380
const DRAG_THRESHOLD = 4

interface FloatingChatWindowProps {
  initialPrompt: string
  displayContent: string
  sceneMeta: { aiRole: string; context: string }
  initialX: number
  initialY: number
  onClose: () => void
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

export function FloatingChatWindow({
  initialPrompt,
  displayContent,
  sceneMeta,
  initialX,
  initialY,
  onClose,
}: FloatingChatWindowProps) {
  const [mounted, setMounted] = useState(false)
  const [inputText, setInputText] = useState("")
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)

  const { messages, isLoading, sendMessage, abort } = useChatStream(sceneMeta)

  const dragStartRef = useRef<{ mouseX: number; mouseY: number; winX: number; winY: number } | null>(null)
  const hasDraggedRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)

  useEffect(() => setMounted(true), [])

  // Calculate initial position clamped to viewport
  useEffect(() => {
    if (typeof window === "undefined") return
    const x = Math.max(8, Math.min(initialX - WINDOW_WIDTH / 2, window.innerWidth - WINDOW_WIDTH - 8))
    const y = Math.max(8, Math.min(initialY + 20, window.innerHeight - 480 - 8))
    setPosition({ x, y })
  }, [initialX, initialY])

  // Auto-send initial prompt once mounted
  useEffect(() => {
    if (!mounted || initializedRef.current) return
    initializedRef.current = true
    sendMessage(initialPrompt, displayContent, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted])

  // Abort on unmount
  useEffect(() => () => abort(), [abort])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const handleSend = useCallback(() => {
    const trimmed = inputText.trim()
    if (!trimmed || isLoading) return
    setInputText("")
    sendMessage(trimmed, trimmed)
  }, [inputText, isLoading, sendMessage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() }
  }, [handleSend])

  // Drag
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
      const newX = Math.max(0, Math.min(dragStartRef.current.winX + dx, window.innerWidth - WINDOW_WIDTH))
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
  }, [isDragging])

  const el = (
    <div
      data-floating-chat
      className="fixed z-[400] flex flex-col bg-white rounded-2xl shadow-2xl border border-gray-200/80 overflow-hidden"
      style={{ left: position.x, top: position.y, width: WINDOW_WIDTH }}
    >
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
      <div className="flex-1 overflow-y-auto p-3 space-y-3" style={{ maxHeight: 320 }}>
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "user" ? (
              <div className="max-w-[85%] rounded-2xl bg-violet-50 border border-violet-100 px-3 py-2 text-sm text-gray-900">
                {msg.displayContent ?? msg.content}
              </div>
            ) : (
              <div className="rounded-2xl bg-gray-50 border border-gray-100 px-3 py-2 text-sm w-full select-text">
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
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-gray-100 p-2.5 bg-gray-50/80">
        <div className="flex items-end gap-2 rounded-lg border border-gray-300 bg-white px-2 pt-1.5 pb-1 focus-within:border-emerald-400 focus-within:ring-1 focus-within:ring-emerald-400/20 transition-all">
          <Textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="继续追问…"
            disabled={isLoading}
            rows={1}
            className="flex-1 min-h-[32px] max-h-[96px] text-sm resize-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent placeholder:text-gray-400 py-1 px-0"
          />
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

  if (!mounted || typeof document === "undefined") return null
  return <>{createPortal(el, document.body)}</>
}
