import { NextResponse } from 'next/server';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

if (!DEEPSEEK_API_KEY) {
  throw new Error('DEEPSEEK_API_KEY is not set in environment variables');
}

// Set response timeout to 30 seconds
export const maxDuration = 30;

// Configure the runtime to use edge for better streaming support
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

// Helper function to ensure proper Markdown formatting
function ensureProperMarkdown(text: string): string {
  // Basic Markdown fixes for common issues
  let result = text;
  
  // Ensure headers have space after #
  result = result.replace(/^(#+)(?!\s)/gm, '$1 ');
  
  // Ensure list items have proper spacing
  result = result.replace(/^(\s*[-*+])(?!\s)/gm, '$1 ');
  result = result.replace(/^(\s*\d+\.)(?!\s)/gm, '$1 ');
  
  return result;
}

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();

    // Add formatting guidelines to the system message
    const enhancedMessages = Array.isArray(messages) ? [...messages] : [];
    
    // If last message is from user, add formatting instructions
    if (enhancedMessages.length > 0 && enhancedMessages[enhancedMessages.length - 1].role === 'user') {
      const lastMessage = enhancedMessages[enhancedMessages.length - 1];
      enhancedMessages[enhancedMessages.length - 1] = {
        ...lastMessage,
        content: `${lastMessage.content}\n\nIMPORTANT: Format your response in proper Markdown. Ensure all headers have spaces after # symbols, all lists have proper indentation and spacing, and tables are properly formatted.`
      };
    }

    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: enhancedMessages,
        stream: true,
        max_tokens: 4000,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to get response from DeepSeek');
    }

    if (!response.body) {
      throw new Error('No response body available');
    }

    const reader = response.body.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) {
              controller.close();
              break;
            }

            const text = decoder.decode(value);
            const lines = text.split('\n');

            for (const line of lines) {
              if (line.trim() === '') continue;
              if (line.trim() === 'data: [DONE]') continue;

              let data = line;
              if (line.startsWith('data: ')) {
                data = line.slice(6);
              }

              try {
                const parsed = JSON.parse(data);
                
                // If there's content in the delta, ensure it's properly formatted
                if (parsed.choices?.[0]?.delta?.content) {
                  parsed.choices[0].delta.content = ensureProperMarkdown(parsed.choices[0].delta.content);
                }
                
                controller.enqueue(encoder.encode(JSON.stringify(parsed) + '\n'));
              } catch (e) {
                console.error('Error parsing JSON:', e);
              }
            }
          }
        } catch (e) {
          controller.error(e);
        }
      },

      cancel() {
        reader.cancel();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to process request' },
      { status: 500 }
    );
  }
} 