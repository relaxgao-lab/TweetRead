import { AudioRecorder } from './audio-recorder-service'
import { isSpeechSynthesisSupported, initSpeechSynthesis } from './speech-utils'
import { TTS_PROVIDER } from '@/config'

export type SpeechStatus = 'idle' | 'recording' | 'processing' | 'speaking'

interface WhisperSpeechServiceConfig {
  onStatusChange?: (status: SpeechStatus) => void
  onTranscript?: (text: string) => void
  onError?: (error: string) => void
  onSpeechEnd?: () => void
  ttsProvider?: 'system' | 'openai'
}

export class WhisperSpeechService {
  private recorder: AudioRecorder
  private status: SpeechStatus = 'idle'
  private config: WhisperSpeechServiceConfig
  private currentOpenAIAudio: HTMLAudioElement | null = null
  private currentSystemUtterance: SpeechSynthesisUtterance | null = null

  constructor(config: WhisperSpeechServiceConfig = {}) {
    this.config = { ttsProvider: TTS_PROVIDER === 'openai' ? 'openai' : 'system', ...config }
    this.recorder = new AudioRecorder()
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      initSpeechSynthesis().catch(console.error)
    }
  }

  getStatus(): SpeechStatus { return this.status }

  updateConfig(config: Partial<WhisperSpeechServiceConfig>): void {
    this.config = { ...this.config, ...config }
  }

  resetConfig(): void {
    this.config = {
      ...this.config,
      onStatusChange: undefined,
      onTranscript: undefined,
      onError: undefined,
      onSpeechEnd: undefined,
    }
  }

  async startListening(): Promise<void> {
    if (this.status !== 'idle') return
    await this.stopSpeaking()
    try {
      await this.recorder.start({})
      this.setStatus('recording')
    } catch (error: any) {
      this.handleError(error.message || 'Failed to start recording')
    }
  }

  async stopListening(): Promise<void> {
    if (this.status !== 'recording') return
    try {
      const { audioBlob, duration } = await this.recorder.stop()
      await this.handleAudioDataAvailable(audioBlob, duration)
    } catch (error: any) {
      this.handleError(error.message || 'Failed to stop recording')
      this.setStatus('idle')
    }
  }

  private async transcribeAudio(audioBlob: Blob): Promise<string> {
    const formData = new FormData()
    formData.append('audio', audioBlob, 'audio.webm')
    formData.append('task', 'transcribe')

    const response = await fetch('/api/whisper', { method: 'POST', body: formData })
    if (!response.ok) {
      const err = await response.text()
      throw new Error(err || `Speech recognition failed: ${response.status}`)
    }
    const result = await response.json()
    return result.text || ''
  }

  async speak(text: string): Promise<void> {
    if (this.status === 'speaking') await this.stopSpeaking()
    this.cleanupCurrentAudio()
    // 状态将在音频真正开始播放后设置

    try {
      if (this.config.ttsProvider === 'system') {
        await this._speakSystem(text)
      } else {
        await this._speakOpenAI(text)
      }
    } catch (error: any) {
      this.handleError(error.message || 'Speech synthesis failed')
      this.setStatus('idle')
    }
  }

  private async _speakSystem(text: string): Promise<void> {
    if (!window.speechSynthesis) throw new Error('Speech synthesis not supported')
    window.speechSynthesis.cancel()
    await new Promise(r => setTimeout(r, 50))

    const utterance = new SpeechSynthesisUtterance(text)
    this.currentSystemUtterance = utterance
    let voices = window.speechSynthesis.getVoices()
    if (!voices.length) {
      await new Promise<void>(r => {
        const check = () => {
          voices = window.speechSynthesis.getVoices()
          if (voices.length) r()
        }
        window.speechSynthesis.onvoiceschanged = check
        check()
      })
    }
    const voice = voices.find(v => v.lang.startsWith('zh')) || voices.find(v => v.lang.startsWith('en')) || voices[0]
    if (voice) utterance.voice = voice
    utterance.rate = 1.0
    utterance.volume = 1.0

    await new Promise<void>((resolve, reject) => {
      let resolved = false
      const cleanup = () => {
        if (!resolved) {
          resolved = true
          this.currentSystemUtterance = null
          this.setStatus('idle')
        }
      }
      
      // 添加超时保护
      const timeout = setTimeout(() => {
        if (!resolved) {
          window.speechSynthesis.cancel()
          cleanup()
          reject(new Error('语音播放超时'))
        }
      }, 60000) // 60秒超时
      
      utterance.onstart = () => {
        // 语音真正开始播放时才设置状态
        this.setStatus('speaking')
      }
      utterance.onend = () => { 
        clearTimeout(timeout)
        cleanup()
        this.config.onSpeechEnd?.()
        resolve() 
      }
      utterance.onerror = (e) => { 
        clearTimeout(timeout)
        cleanup()
        const errorType = (e as any).error || 'unknown'
        const errorMsg = errorType === 'not-allowed' 
          ? '语音播放被阻止，请检查浏览器权限设置'
          : errorType === 'synthesis-failed'
          ? '语音合成失败'
          : '语音播放失败'
        reject(new Error(errorMsg))
      }
      
      window.speechSynthesis.speak(utterance)
    })
    this.currentSystemUtterance = null
    this.setStatus('idle')
  }

  private async _speakOpenAI(text: string): Promise<void> {
    let audio: HTMLAudioElement | null = null
    let audioUrl: string | null = null
    try {
      const res = await fetch('/api/openai-tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model: 'tts-1', voice: 'alloy', response_format: 'mp3' }),
      })
      if (!res.ok) {
        const errorText = await res.text()
        throw new Error(errorText || 'Failed to generate audio')
      }
      const blob = await res.blob()
      audioUrl = URL.createObjectURL(blob)
      audio = new Audio(audioUrl)
      this.currentOpenAIAudio = audio
      
      // 移动端优化：blob URL 不需要 crossOrigin，避免部分机型异常
      audio.preload = 'auto'

      // 等待音频加载完成（10 秒超时）
      // 原因：部分手机浏览器对 blob URL 不触发 canplay/canplaythrough，只触发 loadeddata 或 readyState 变化
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const settle = () => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)
          clearInterval(pollId)
          audio!.removeEventListener('canplay', onCanPlay)
          audio!.removeEventListener('canplaythrough', onCanPlayThrough)
          audio!.removeEventListener('loadeddata', onLoadedData)
          resolve()
        }

        const timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true
            clearInterval(pollId)
            audio!.removeEventListener('canplay', onCanPlay)
            audio!.removeEventListener('canplaythrough', onCanPlayThrough)
            audio!.removeEventListener('loadeddata', onLoadedData)
            console.error('Audio load timeout:', {
              networkState: audio!.networkState,
              readyState: audio!.readyState,
              buffered: audio!.buffered.length > 0 ? `${audio!.buffered.start(0)}-${audio!.buffered.end(0)}` : 'none'
            })
            reject(new Error('音频加载超时，请检查网络连接或稍后重试'))
          }
        }, 10000)

        // 轮询：部分移动端不触发 canplay，仅更新 readyState，用轮询兜底
        const pollId = setInterval(() => {
          if (settled) return
          // readyState >= 2 (HAVE_CURRENT_DATA) 即可尝试播放
          if (audio!.readyState >= 2) {
            console.log('Audio ready (poll), readyState:', audio!.readyState)
            settle()
          }
        }, 200)

        const onCanPlay = () => {
          console.log('Audio can play, readyState:', audio!.readyState)
          settle()
        }
        const onCanPlayThrough = () => {
          console.log('Audio can play through, readyState:', audio!.readyState)
          settle()
        }
        const onLoadedData = () => {
          console.log('Audio loadeddata, readyState:', audio!.readyState)
          if (audio!.readyState >= 2) settle()
        }

        audio!.addEventListener('canplay', onCanPlay)
        audio!.addEventListener('canplaythrough', onCanPlayThrough)
        audio!.addEventListener('loadeddata', onLoadedData)

        audio!.onerror = (e) => {
          if (!settled) {
            settled = true
            clearTimeout(timeoutId)
            clearInterval(pollId)
            audio!.removeEventListener('canplay', onCanPlay)
            audio!.removeEventListener('canplaythrough', onCanPlayThrough)
            audio!.removeEventListener('loadeddata', onLoadedData)
            console.error('Audio load error:', e, {
              error: audio!.error,
              code: audio!.error?.code,
              message: audio!.error?.message,
              networkState: audio!.networkState,
              readyState: audio!.readyState
            })
            const errorCode = audio!.error?.code
            const errorMsg = errorCode === 4
              ? '音频格式不支持或文件损坏'
              : errorCode === 3
                ? '音频解码失败'
                : errorCode === 2
                  ? '音频网络错误，请检查网络连接'
                  : errorCode === 1
                    ? '音频加载中断'
                    : `音频加载失败${audio!.error?.message ? ': ' + audio!.error.message : ''}`
            reject(new Error(errorMsg))
          }
        }

        if (audio!.readyState >= 2) {
          console.log('Audio already ready, readyState:', audio!.readyState)
          settle()
        }
      })

      // 尝试播放音频
      try {
        console.log('Attempting to play audio, readyState:', audio.readyState)
        const playPromise = audio.play()
        if (playPromise !== undefined) {
          await playPromise
          console.log('Audio play promise resolved')
          // 音频真正开始播放后才设置状态
          this.setStatus('speaking')
        } else {
          // 如果没有返回 Promise，也设置状态
          this.setStatus('speaking')
        }
      } catch (playError: any) {
        console.error('Audio play error:', {
          name: playError.name,
          message: playError.message,
          code: playError.code
        })
        // 如果播放被阻止（例如浏览器自动播放策略）
        if (playError.name === 'NotAllowedError' || playError.name === 'NotSupportedError') {
          if (audioUrl) URL.revokeObjectURL(audioUrl)
          this.currentOpenAIAudio = null
          throw new Error('音频播放被阻止，请点击页面任意位置后重试')
        }
        throw playError
      }

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          if (audioUrl) URL.revokeObjectURL(audioUrl)
          this.currentOpenAIAudio = null
        }
        
        audio!.onended = () => {
          if (this.status === 'speaking') { 
            this.setStatus('idle')
            this.config.onSpeechEnd?.() 
          }
          cleanup()
          resolve()
        }
        audio!.onerror = (e) => {
          cleanup()
          const errorMsg = audio!.error?.message || '音频播放失败'
          reject(new Error(errorMsg))
        }
        // 添加超时保护，避免无限等待
        setTimeout(() => {
          if (audio && this.status === 'speaking') {
            cleanup()
            reject(new Error('音频播放超时'))
          }
        }, 60000) // 60秒超时
      })
    } catch (error: any) {
      this.setStatus('idle')
      if (audioUrl) URL.revokeObjectURL(audioUrl)
      if (audio) {
        audio.pause()
        audio.src = ''
      }
      this.currentOpenAIAudio = null
      throw error
    }
  }

  async stopSpeaking(): Promise<void> {
    if (window.speechSynthesis) window.speechSynthesis.cancel()
    this.currentSystemUtterance = null
    if (this.currentOpenAIAudio) {
      this.currentOpenAIAudio.pause()
      this.currentOpenAIAudio.src = ''
      this.currentOpenAIAudio = null
    }
    if (this.status === 'speaking') this.setStatus('idle')
  }

  private setStatus(s: SpeechStatus): void {
    if (this.status === s) return
    console.log(`[WhisperSpeechService] Status change: ${this.status} -> ${s}`)
    this.status = s
    this.config.onStatusChange?.(s)
  }

  private handleError(msg: string): void {
    this.config.onError?.(msg)
    this.setStatus('idle')
  }

  private cleanupCurrentAudio(): void {
    if (window.speechSynthesis) window.speechSynthesis.cancel()
    this.currentSystemUtterance = null
    if (this.currentOpenAIAudio) {
      this.currentOpenAIAudio.pause()
      this.currentOpenAIAudio = null
    }
  }

  private async handleAudioDataAvailable(audioBlob: Blob, duration: number): Promise<void> {
    try {
      this.setStatus('processing')
      if (duration < 0.5) {
        this.setStatus('idle')
        this.config.onTranscript?.('')
        return
      }
      const transcript = await this.transcribeAudio(audioBlob)
      this.config.onTranscript?.(transcript || '')
    } catch (error: any) {
      this.handleError(error.message || 'Failed to process audio')
    } finally {
      if (this.status === 'processing') this.setStatus('idle')
    }
  }
}

export const whisperSpeechService = new WhisperSpeechService()
