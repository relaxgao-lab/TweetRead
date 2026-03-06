export function isSpeechSynthesisSupported(): boolean {
  if (typeof window === "undefined") return false
  try {
    return !!window.speechSynthesis && !!new SpeechSynthesisUtterance("test")
  } catch { return false }
}

export const initSpeechSynthesis = (): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!isSpeechSynthesisSupported()) { reject(new Error("Speech synthesis not supported")); return }
    const checkVoices = () => {
      const voices = window.speechSynthesis.getVoices()
      if (voices.length > 0) { resolve(); return true }
      return false
    }
    if (checkVoices()) return
    let loaded = false
    const handler = () => {
      if (checkVoices() && !loaded) {
        loaded = true
        window.speechSynthesis.removeEventListener("voiceschanged", handler)
        resolve()
      }
    }
    window.speechSynthesis.addEventListener("voiceschanged", handler)
    setTimeout(() => {
      if (!loaded) {
        window.speechSynthesis.removeEventListener("voiceschanged", handler)
        checkVoices() ? resolve() : reject(new Error("No voices available"))
      }
    }, 3000)
  })
