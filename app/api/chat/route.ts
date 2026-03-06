import OpenAI from "openai"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

interface Message {
  role: "user" | "assistant" | "system"
  content: string
}

export async function POST(request: Request) {
  try {
    const { messages, sceneMeta } = await request.json()

    if (!sceneMeta?.aiRole || !sceneMeta?.context) {
      return new Response(JSON.stringify({ error: "Missing sceneMeta" }), { status: 400 })
    }

    const systemPrompt = `You are ${sceneMeta.aiRole}. Your job is to help the user understand the following tweet content.

Tweet content:
${sceneMeta.context}

Guidelines:
1. Be concise and helpful. Answer directly.
2. When explaining background or context, use clear and simple language.
3. If asked to translate, translate accurately and naturally into Chinese.
4. If asked to summarize, highlight the key points.
5. Always stay focused on the tweet content provided.
6. Wrap your spoken reply in [SPEAK]...[/SPEAK] for TTS.
7. Respond in Chinese unless the user explicitly asks for English.`

    const fullMessages: Message[] = [
      { role: "system", content: systemPrompt },
      ...(Array.isArray(messages) ? messages.filter((m: Message) => m.role !== "system") : []),
    ]

    const stream = await openai.chat.completions.create({
      model: "gpt-4.1-mini-2025-04-14",
      messages: fullMessages,
      temperature: 0.6,
      max_tokens: 600,
      stream: true,
    })

    const encoder = new TextEncoder()
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content ?? ""
            if (delta) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`))
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        } finally {
          controller.close()
        }
      },
    })

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error"
    console.error("Chat API error:", msg)
    return new Response(JSON.stringify({ error: `Failed to get AI response: ${msg}` }), { status: 500 })
  }
}
