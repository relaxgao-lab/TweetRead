"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { createPortal } from "react-dom"
import { X, MessageSquarePlus, Loader2 } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"

interface LookupResultPopupProps {
  text: string
  actionId: "lookup" | "pattern"
  anchorX: number
  anchorY: number
  prompt: string
  sceneMeta: { aiRole: string; context: string }
  onClose: () => void
  onFollowUp: (result: string) => void
}

export function LookupResultPopup({
  text,
  actionId,
  anchorX,
  anchorY,
  prompt,
  sceneMeta,
  onClose,
  onFollowUp,
}: LookupResultPopupProps) {
  const [mounted, setMounted] = useState(false)
  const [result, setResult] = useState("")
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    const controller = new AbortController()
    let accumulated = ""
    let firstChunk = true

    const fetchResult = async () => {
      setIsLoading(true)
      setResult("")
      setError(null)
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            messages: [{ role: "user", content: prompt }],
            sceneMeta,
            maxTokens: 800,
          }),
        })
        if (!res.ok) throw new Error(`API ${res.status}`)
        if (!res.body) throw new Error("No body")

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
                  setIsLoading(false)
                }
                setResult(accumulated)
              }
            } catch {}
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return
        setError(err instanceof Error ? err.message : "请求失败")
        setIsLoading(false)
      }
    }

    fetchResult()
    return () => controller.abort()
  }, [prompt, sceneMeta])

  const handleClose = useCallback(() => onClose(), [onClose])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Element
      if (target.closest("[data-selection-action-menu]")) return
      if (target.closest("[data-lookup-popup]")) return
      handleClose()
    }
    const timerId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside)
    }, 0)
    return () => {
      clearTimeout(timerId)
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [handleClose])

  const POPUP_WIDTH = 360
  const POPUP_MAX_CONTENT_HEIGHT = 300

  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 375
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 812

  const left = Math.max(8, Math.min(anchorX - POPUP_WIDTH / 2, viewportWidth - POPUP_WIDTH - 8))
  const spaceBelow = viewportHeight - anchorY - 16
  const top =
    spaceBelow >= POPUP_MAX_CONTENT_HEIGHT + 110
      ? anchorY + 16
      : Math.max(8, anchorY - POPUP_MAX_CONTENT_HEIGHT - 100)

  const title = actionId === "lookup" ? `查词：${text}` : `句型讲解：${text}`

  const popup = (
    <div
      ref={popupRef}
      data-lookup-popup
      className="fixed z-[300] bg-white rounded-2xl shadow-2xl border border-gray-200/80 overflow-hidden flex flex-col"
      style={{ left, top, width: POPUP_WIDTH }}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-100 bg-gray-50/80 shrink-0">
        <h3 className="text-sm font-semibold text-gray-800 truncate">{title}</h3>
        <button
          type="button"
          onClick={handleClose}
          className="shrink-0 p-1 rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div
        className="overflow-y-auto px-4 py-3 text-sm text-gray-800 [&_.prose]:text-sm [&_.prose_p]:my-1 [&_.prose_ul]:my-1 [&_.prose_li]:my-0 [&_.prose_h1]:text-base [&_.prose_h2]:text-sm [&_.prose_h3]:text-sm"
        style={{ maxHeight: POPUP_MAX_CONTENT_HEIGHT }}
      >
        {isLoading && !result && (
          <div className="flex items-center justify-center h-16">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        )}
        {error && <p className="text-red-500">{error}</p>}
        {result && (
          <div className="prose prose-sm max-w-none prose-gray">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{result}</ReactMarkdown>
          </div>
        )}
      </div>

      {!isLoading && result && (
        <div className="shrink-0 border-t border-gray-100 px-3 py-2.5">
          <button
            type="button"
            onClick={() => {
              onFollowUp(result)
              handleClose()
            }}
            className="w-full flex items-center justify-center gap-2 text-sm font-medium py-2 px-3 rounded-xl text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition-colors"
          >
            <MessageSquarePlus className="h-4 w-4" />
            在 AI 助手中追问
          </button>
        </div>
      )}
    </div>
  )

  if (!mounted || typeof document === "undefined") return null
  return <>{createPortal(popup, document.body)}</>
}
