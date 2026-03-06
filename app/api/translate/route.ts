import OpenAI from "openai"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(request: Request) {
  const { items } = await request.json() as { items: { id: string; text: string }[] }
  if (!items?.length) {
    return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      try {
        await Promise.all(items.map(async (item, idx) => {
          const completion = await openai.chat.completions.create({
            model: "gpt-4.1-mini-2025-04-14",
            messages: [
              {
                role: "user",
                content: `Translate the following tweet to Chinese. Return only the translation, no explanation:\n\n${item.text}`,
              },
            ],
            temperature: 0.3,
            max_tokens: 300,
            stream: false,
          })
          const textZh = completion.choices[0].message.content?.trim() ?? ""
          if (textZh) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ id: item.id, index: idx, textZh })}\n\n`
            ))
          }
        }))
      } catch (err) {
        console.error("translate SSE error:", err)
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  })
}
