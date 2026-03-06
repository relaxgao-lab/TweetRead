import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  try {
    const { text, model = 'gpt-4o-mini-tts', voice = 'nova', response_format = 'wav', speed = 1.0 } = await req.json();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing OpenAI API key' }), { status: 500 });
    }

    const requestBody = { model, input: text, voice, response_format, speed };
    const openaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      return new Response(JSON.stringify({ error: err }), { status: openaiRes.status });
    }

    const audioBlob = await openaiRes.blob();
    return new Response(audioBlob, {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || 'OpenAI TTS error' }), { status: 500 });
  }
}
