export type SelectionAnchor = {
  text: string
  anchorX: number
  anchorY: number
}

export type ReadSelectionAnchorOptions = {
  /** 若提供，要求选区的 commonAncestorContainer 在该容器内，否则返回 null */
  container?: HTMLElement | null
  /** trim 后文本最大长度，超过返回 null */
  maxLength?: number
}

/**
 * 从 window.getSelection() 读取选中文本和锚点坐标。
 * - anchorX：选区首个 rect 的水平中心
 * - anchorY：所有 client rect 中最靠下的 bottom（避免多行选区菜单跑到中间）
 * 任意一步异常或不满足条件时返回 null。
 */
export function readSelectionAnchor(
  options: ReadSelectionAnchorOptions = {},
): SelectionAnchor | null {
  if (typeof window === "undefined") return null

  const { container, maxLength } = options

  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null

  const text = sel.toString().trim()
  if (!text) return null
  if (typeof maxLength === "number" && text.length > maxLength) return null

  try {
    const range = sel.getRangeAt(0)
    if (container && !container.contains(range.commonAncestorContainer)) return null

    const rect = range.getBoundingClientRect()
    const rects = range.getClientRects()
    let anchorY = rect.bottom
    if (rects.length > 0) {
      let maxBottom = rects[0].bottom
      for (let i = 1; i < rects.length; i++) {
        if (rects[i].bottom > maxBottom) maxBottom = rects[i].bottom
      }
      anchorY = maxBottom
    }
    return {
      text,
      anchorX: rect.left + rect.width / 2,
      anchorY,
    }
  } catch {
    return null
  }
}
