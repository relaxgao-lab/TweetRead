"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import type { ReactNode } from "react"

type SelectionActionMenuItem = {
  id: string
  label: string
}

type SelectionActionMenuProps = {
  anchorX: number
  anchorY: number
  primaryActions: SelectionActionMenuItem[]
  loadingActionId?: string | null
  onAction: (id: string) => void
}

export function SelectionActionMenu({
  anchorX,
  anchorY,
  primaryActions,
  loadingActionId,
  onAction,
}: SelectionActionMenuProps) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 375
  const estimatedWidth = Math.max(220, primaryActions.length * 88)
  const left = Math.max(8, Math.min(anchorX - estimatedWidth / 2, viewportWidth - estimatedWidth - 8))
  const top = anchorY + 10

  const menu: ReactNode = (
    <div
      data-selection-action-menu
      className="fixed z-[200] pointer-events-auto"
      style={{ left, top }}
    >
      <div className="relative">
        <div className="flex items-center gap-1 rounded-full border border-gray-200/90 bg-white/95 p-1 shadow-xl backdrop-blur-sm">
          {primaryActions.map((action) => {
            const isLoading = action.id === loadingActionId
            return (
              <button
                key={action.id}
                type="button"
                disabled={isLoading}
                className="px-3 py-1.5 rounded-full text-xs font-semibold text-gray-700 bg-white hover:bg-gray-100 active:scale-[0.98] touch-manipulation transition whitespace-nowrap disabled:cursor-wait disabled:opacity-80 disabled:hover:bg-white disabled:active:scale-100"
                onClick={() => onAction(action.id)}
              >
                {isLoading ? "加载中..." : action.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )

  if (!mounted || typeof document === "undefined") return menu
  return <>{createPortal(menu, document.body)}</>
}
