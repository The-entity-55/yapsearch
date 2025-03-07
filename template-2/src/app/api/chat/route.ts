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
  // Replace any malformed markdown with properly formatted markdown
  let result = text;
  
  // Fix malformed headings (###text, ##text, #text)
  result = result.replace(/^(#{1,6})([^#\s])/gm, '$1 $2');
  
  // Fix incorrect spacing in headers that have multiple #
  result = result.replace(/^(#{1,6})\s+([^#])/gm, '$1 $2');
  
  // Remove excessive heading markers (####...) and normalize
  result = result.replace(/^#{7,}/gm, '###### ');
  
  // Fix list items without proper spacing (- text or * text)
  result = result.replace(/^(\s*)([*\-+])([^\s])/gm, '$1$2 $3');
  
  // Fix numbered lists without proper spacing (1.text)
  result = result.replace(/^(\s*\d+\.)([^\s])/gm, '$1 $2');

  // Remove excessive asterisks and markdown artifacts
  result = result.replace(/\*{3,}/g, '**');
  
  // Fix jumbled source markers and citations
  result = result.replace(/Source\d+[:#\-*]+/g, '\n**Source:** ');
  
  // Fix malformed table markers
  result = result.replace(/\|\s*-+\s*\|/g, '| --- |');
  
  // Fix Alt markers appearing in the text
  result = result.replace(/Alt['']?\s+(?=[a-z])/gi, '');
  
  // Fix dangling or mismatched backticks
  result = result.replace(/([^`])`([^`])/g, '$1 $2');
  
  // Ensure double linebreaks between sections
  result = result.replace(/(\n#{1,6}[^\n]+)\n(?=[^\n])/g, '$1\n\n');
  
  // Ensure proper spacing after list items
  result = result.replace(/^(\s*[*\-+]\s+[^\n]+)(\n)(?=[^*\-+\s\n])/gm, '$1\n\n');
  
  // Fix numbered lists that become unnumbered mid-list
  result = result.replace(/^(\s*)\d+\.\s*(.+)(\n+)(\s*)[*\-+]\s+/gm, '$1$2$3$41. ');
  
  return result;
}

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();
    
    // Create a much more explicit instruction set to force proper formatting
    const systemInstructions = `You are an AI assistant that responds with perfectly formatted Markdown.
    
Rules for formatting your response:
1. Always start headings with a # symbol followed by a space: "# Heading 1" not "#Heading1"
2. Use proper hierarchy: # Main Heading, ## Sub-heading, ### Smaller heading
3. Ensure all list items have a space after the bullet: "- Item" not "-Item"
4. Put blank lines between paragraphs and sections
5. Format sources with proper citations and references
6. Do not use excessive formatting symbols like *** or ###
7. Do not include strange markers like "Source1" or "Alt" in the output
8. Tables should be properly formatted with | and - symbols
9. When listing sources, use a consistent format: "## Sources" followed by a numbered list

Example of proper formatting:
# Main Title

## Section 1
This is a paragraph with properly formatted text.

- This is a list item
- This is another list item
  - This is a nested list item

## Section 2
More properly formatted content here.

## Sources
1. [First Source](https://example.com) - Description
2. [Second Source](https://example.com) - Description`;

    // Build enhanced messages
    const enhancedMessages = [
      {
        role: 'system',
        content: systemInstructions
      }
    ];
    
    // Add original messages but include formatting instructions in the first user message
    if (Array.isArray(messages) && messages.length > 0) {
      for (let i = 0; i < messages.length; i++) {
        // For user messages, append formatting instructions
        if (messages[i].role === 'user') {
          enhancedMessages.push({
            role: 'user',
            content: `${messages[i].content}\n\nIMPORTANT: Format your entire response using proper, clean Markdown. Do not include any strange formatting symbols or markers.`
          });
        } else {
          enhancedMessages.push(messages[i]);
        }
      }
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
                
                // Apply aggressive formatting fixes to each content chunk
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