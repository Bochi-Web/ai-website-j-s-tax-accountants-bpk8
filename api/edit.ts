import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateAuth } from './_auth.js';

/**
 * POST /api/edit
 * Receives a section edit request, fetches the component source from GitHub,
 * sends it to Claude API with the user's instructions, and returns the
 * modified code with an explanation.
 */

// ── Section-to-file mapping for Bigspring Light Astro template ──

const componentSections: Record<string, string> = {
  // Global components
  'navigation': 'src/layouts/partials/Header.astro',
  'footer': 'src/layouts/partials/Footer.astro',
  // Shared components
  'cta': 'src/layouts/components/Cta.astro',
  // Homepage inline sections (all in index.astro)
  'banner': 'src/pages/index.astro',
  'features': 'src/pages/index.astro',
  'services': 'src/pages/index.astro',
  'workflow': 'src/pages/index.astro',
  // Homepage content data (YAML frontmatter)
  'homepage-content': 'src/content/homepage/-index.md',
};

const pageSections = new Set([
  'contact-form',
  'faq-content',
  'pricing-content',
]);

const pageFileMap: Record<string, string> = {
  '/contact/': 'src/pages/contact.astro',
  '/contact': 'src/pages/contact.astro',
  '/faq/': 'src/pages/faq.astro',
  '/faq': 'src/pages/faq.astro',
  '/pricing/': 'src/pages/pricing.astro',
  '/pricing': 'src/pages/pricing.astro',
};

function resolveFilePath(section: string, currentPage: string): string | null {
  if (componentSections[section]) return componentSections[section];
  if (pageSections.has(section)) {
    const normalized = currentPage.endsWith('/') ? currentPage : currentPage + '/';
    return pageFileMap[normalized] || pageFileMap[currentPage] || null;
  }
  return null;
}

// ── Environment variables ──

function getEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

// ── GitHub file fetch ──

async function fetchFileFromGitHub(filePath: string): Promise<string> {
  const owner = getEnv('GITHUB_OWNER');
  const repo = getEnv('GITHUB_REPO');
  const token = getEnv('GITHUB_TOKEN');

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3.raw',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} fetching ${filePath}`);
  }

  return response.text();
}

// ── Claude API call ──

const SYSTEM_PROMPT = `You are an expert Astro and Tailwind CSS developer working as a website editor. You will receive the source code of an Astro component or page and a user's request to modify it.

Rules:
- Return the COMPLETE modified file, not just the changes
- Maintain any existing data-section attributes — never remove them
- If data-global="true" exists, maintain it
- Keep the same Tailwind CSS approach
- Do not add external dependencies or npm packages
- Do not add client-side JavaScript unless specifically requested
- Keep the code clean, well-formatted, and production-ready
- For .md files with YAML frontmatter, edit the YAML values while preserving the structure
- If the file contains multiple sections (e.g. index.astro), only modify the section the user specified

Respond in this JSON format:
{
  "explanation": "Brief description of what you changed and why",
  "code": "The complete modified file content"
}

Only respond with valid JSON. No markdown, no code fences.`;

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RequestBody {
  section: string;
  message: string;
  action: 'edit' | 'replace' | 'new-page';
  referenceUrl?: string | null;
  referenceImage?: string | null;
  isGlobal: boolean;
  currentPage: string;
  conversationHistory: ConversationMessage[];
}

async function callClaude(
  userMessage: string,
  conversationHistory: ConversationMessage[],
  referenceImage?: string | null
): Promise<{ explanation: string; code: string }> {
  const apiKey = getEnv('OPENROUTER_API_KEY');

  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  for (const msg of conversationHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  const contentBlocks: any[] = [];

  if (referenceImage) {
    contentBlocks.push({
      type: 'image_url',
      image_url: { url: referenceImage },
    });
  }

  contentBlocks.push({ type: 'text', text: userMessage });

  messages.push({ role: 'user', content: contentBlocks });

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://bochi-web.com',
      'X-Title': 'Bochi Web Editor',
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4',
      max_tokens: 4096,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} — ${errorText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error('Empty response from OpenRouter API');
  }

  const parsed = JSON.parse(text);
  return { explanation: parsed.explanation, code: parsed.code };
}

// ── Request handler ──

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const user = await validateAuth(req, res);
  if (!user) return;

  try {
    const body = req.body as RequestBody;
    const {
      section,
      message,
      action,
      referenceUrl,
      referenceImage,
      isGlobal,
      currentPage,
      conversationHistory = [],
    } = body;

    if (!section || !message) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: section, message',
      });
    }

    // ── New Page action ──
    if (action === 'new-page') {
      let userPrompt = `The user wants to create a new page for a Bigspring Light Astro website using Tailwind CSS.

The user wants: ${message}`;
      if (referenceUrl) userPrompt += `\n\nReference website: ${referenceUrl}`;
      if (referenceImage) userPrompt += `\n\nA reference image has been provided.`;
      userPrompt += `\n\nGenerate a complete Astro page file. Import Base from "@/layouts/Base.astro". Use Tailwind CSS utilities. Include data-section attributes on each section.`;

      const result = await callClaude(userPrompt, conversationHistory, referenceImage);
      return res.status(200).json({
        success: true,
        message: result.explanation,
        modifiedCode: result.code,
        originalCode: null,
        filePath: null,
      });
    }

    // ── Resolve the file path ──
    const filePath = resolveFilePath(section, currentPage);
    if (!filePath) {
      return res.status(400).json({
        success: false,
        message: `Could not resolve file path for section "${section}" on page "${currentPage}"`,
      });
    }

    // ── Fetch the source code from GitHub ──
    const originalCode = await fetchFileFromGitHub(filePath);

    // ── Build the user message for Claude ──
    let userPrompt: string;

    if (action === 'replace') {
      userPrompt = `Here is the current source code (${filePath}) containing the "${section}" section:\n\n\`\`\`astro\n${originalCode}\n\`\`\`\n\nThe user wants: ${message}`;
      if (referenceUrl) userPrompt += `\n\nReference website: ${referenceUrl}`;
      if (referenceImage) userPrompt += `\n\nA reference image has been provided.`;
      userPrompt += `\n\nBuild a completely new version of the "${section}" section. Return the complete file. Keep data-section attributes.`;
    } else {
      userPrompt = `Here is the current source code (${filePath}) containing the "${section}" section:\n\n\`\`\`astro\n${originalCode}\n\`\`\`\n\nThe user wants to modify the "${section}" section: ${message}`;
      if (referenceUrl) userPrompt += `\n\nReference website: ${referenceUrl}`;
      if (referenceImage) userPrompt += `\n\nA reference image has been provided.`;
      userPrompt += `\n\nModify the "${section}" section to match the request. Return the complete file.`;
    }

    if (isGlobal) {
      userPrompt += `\n\nIMPORTANT: This is a GLOBAL component that appears on every page. Preserve data-global="true".`;
    }

    const result = await callClaude(userPrompt, conversationHistory, referenceImage);

    return res.status(200).json({
      success: true,
      message: result.explanation,
      modifiedCode: result.code,
      originalCode,
      filePath,
    });
  } catch (error: any) {
    console.error('Edit API error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error',
    });
  }
}
