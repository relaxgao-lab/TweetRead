import { NextResponse } from "next/server"
import OpenAI from "openai"

const hasApiKey = !!process.env.OPENAI_API_KEY
const isDevelopment = process.env.NODE_ENV === "development"

let openaiClient: OpenAI | null = null
if (hasApiKey) {
  openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    ...(isDevelopment ? { dangerouslyAllowBrowser: true } : {}),
  })
}

export const runtime = "nodejs"

export async function POST(req: Request) {
  if (!hasApiKey || !openaiClient) {
    return NextResponse.json(
      { error: "OpenAI API key is not configured. Please set OPENAI_API_KEY." },
      { status: 500 }
    )
  }

  try {
    const formData = await req.formData()
    const audioFile = formData.get("audio") as File | null
    const task = formData.get("task") as string | null

    if (!audioFile || audioFile.size === 0) {
      return NextResponse.json({ error: "No audio file provided" }, { status: 400 })
    }

    const arrayBuffer = await audioFile.arrayBuffer()
    const blob = new Blob([arrayBuffer], { type: audioFile.type })
    const namedFile = new File([blob], "audio.webm", { type: audioFile.type })

    if (task === 'translate') {
      const translation = await openaiClient.audio.translations.create({
        file: namedFile,
        model: "whisper-1",
      })
      return NextResponse.json({ text: translation.text })
    } else {
      const transcription = await openaiClient.audio.transcriptions.create({
        file: namedFile,
        model: "whisper-1",
        language: undefined,
      })
      return NextResponse.json({ text: transcription.text })
    }
  } catch (error: any) {
    console.error("Whisper API error:", error)
    return NextResponse.json(
      { error: error.message || "Whisper API failed" },
      { status: 500 }
    )
  }
}
