export interface AudioRecorderResult {
  audioBlob: Blob
  audioUrl: string
  duration: number
}

export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null
  private audioChunks: Blob[] = []
  private stream: MediaStream | null = null
  private isRecording: boolean = false
  private volumeCheckInterval: NodeJS.Timeout | null = null
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private microphone: MediaStreamAudioSourceNode | null = null
  private readonly VOLUME_CHECK_INTERVAL = 50
  private startTime = 0
  private onVolumeChange: ((volume: number) => void) | undefined = undefined
  private readonly MIN_RECORDING_DURATION = 1000

  constructor() {
    if (typeof window !== 'undefined') {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
    }
  }

  async start(options: { onVolumeChange?: (volume: number) => void } = {}) {
    if (this.isRecording) throw new Error("Already recording")
    this.onVolumeChange = options.onVolumeChange
    this.audioChunks = []
    this.startTime = Date.now()

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      this.analyser = this.audioContext!.createAnalyser()
      this.analyser.fftSize = 2048
      this.microphone = this.audioContext!.createMediaStreamSource(this.stream)
      this.microphone.connect(this.analyser)
      this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus' })
      this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.audioChunks.push(e.data) }
      this.mediaRecorder.start(100)
      this.startVolumeCheck()
      this.isRecording = true
    } catch (error) {
      this.cleanup()
      throw error
    }
  }

  private startVolumeCheck() {
    this.volumeCheckInterval = setInterval(() => {
      if (!this.analyser || !this.isRecording) return
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount)
      this.analyser.getByteFrequencyData(dataArray)
      const volume = dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 255
      this.onVolumeChange?.(volume)
    }, this.VOLUME_CHECK_INTERVAL)
  }

  async stop(): Promise<AudioRecorderResult> {
    if (!this.isRecording || !this.mediaRecorder) throw new Error("Not recording")
    const currentDuration = Date.now() - this.startTime
    if (currentDuration < this.MIN_RECORDING_DURATION) {
      await new Promise(r => setTimeout(r, this.MIN_RECORDING_DURATION - currentDuration))
    }

    return new Promise((resolve) => {
      const startTime = this.startTime
      this.mediaRecorder!.onstop = () => {
        const duration = (Date.now() - startTime) / 1000
        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' })
        const audioUrl = URL.createObjectURL(audioBlob)
        this.cleanup()
        resolve({ audioBlob, audioUrl, duration })
      }
      this.mediaRecorder!.stop()
    })
  }

  public isRecordingNow(): boolean {
    return this.isRecording
  }

  private cleanup() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop()
    if (this.stream) this.stream.getTracks().forEach(track => track.stop())
    if (this.analyser) this.analyser.disconnect()
    if (this.microphone) this.microphone.disconnect()
    if (this.volumeCheckInterval) { clearInterval(this.volumeCheckInterval); this.volumeCheckInterval = null }
    this.mediaRecorder = null
    this.stream = null
    this.analyser = null
    this.microphone = null
    this.isRecording = false
  }
}
