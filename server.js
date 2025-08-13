// AI Code Review Bot for GitHub - Fixed ES Module Version
import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';

const app = express();
app.use(express.json());

// Configuration
const config = {
  github: {
    token: process.env.GITHUB_TOKEN,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4-turbo-preview'
  },
  port: process.env.PORT || 3000
};

// Initialize clients
const octokit = new Octokit({
  auth: config.github.token,
});

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

// Webhook signature verification
function verifySignature(payload, signature) {
  const hmac = crypto.createHmac('sha256', config.github.webhookSecret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// Extract code changes from PR
async function getPullRequestDiff(owner, repo, pullNumber) {
  try {
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
    });

    const relevantFiles = files.filter(file => 
      file.status !== 'removed' && 
      isCodeFile(file.filename) &&
      file.changes < 1000 // Skip very large files
    );

    // Get PR details to get the correct head SHA
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    const headSha = pr.head.sha;

    const filesWithContent = await Promise.all(
      relevantFiles.map(async (file) => {
        try {
          // For new files or modified files, get content from the PR head
          if (file.status === 'added' || file.status === 'modified') {
            try {
              const { data: content } = await octokit.rest.repos.getContent({
                owner,
                repo,
                path: file.filename,
                ref: headSha,
              });

              return {
                filename: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patch: file.patch,
                content: Buffer.from(content.content, 'base64').toString('utf-8'),
                language: getLanguage(file.filename)
              };
            } catch (contentError) {
              console.warn(`Could not fetch full content for ${file.filename}, using patch only`);
              // Fallback: return file info with patch only
              return {
                filename: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patch: file.patch,
                content: null, // No full content available
                language: getLanguage(file.filename)
              };
            }
          } else {
            // For other statuses, just return the patch info
            return {
              filename: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              changes: file.changes,
              patch: file.patch,
              content: null,
              language: getLanguage(file.filename)
            };
          }
        } catch (error) {
          console.error(`Error processing file ${file.filename}:`, error.message);
          return null;
        }
      })
    );

    return filesWithContent.filter(file => file !== null);
  } catch (error) {
    console.error('Error fetching PR diff:', error);
    throw error;
  }
}

// Check if file is a code file
function isCodeFile(filename) {
  const codeExtensions = [
    '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.cs',
    '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.sh',
    '.sql', '.html', '.css', '.scss', '.less', '.vue', '.svelte'
  ];
  
  return codeExtensions.some(ext => filename.toLowerCase().endsWith(ext));
}

// Get programming language from filename
function getLanguage(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const languageMap = {
    'js': 'JavaScript',
    'ts': 'TypeScript',
    'jsx': 'React JSX',
    'tsx': 'React TSX',
    'py': 'Python',
    'java': 'Java',
    'cpp': 'C++',
    'c': 'C',
    'cs': 'C#',
    'php': 'PHP',
    'rb': 'Ruby',
    'go': 'Go',
    'rs': 'Rust',
    'swift': 'Swift',
    'kt': 'Kotlin',
    'scala': 'Scala',
    'sh': 'Shell',
    'sql': 'SQL',
    'html': 'HTML',
    'css': 'CSS'
  };
  
  return languageMap[ext] || 'Unknown';
}

// Generate AI code review
async function generateCodeReview(files, prDescription, prTitle) {
  const prompt = `
You are an expert code reviewer. Please review the following pull request and provide constructive feedback.

**Pull Request Title:** ${prTitle}
**Pull Request Description:** ${prDescription}

**Files Changed:**
${files.map(file => `
### ${file.filename} (${file.language})
**Status:** ${file.status}
**Changes:** +${file.additions} -${file.deletions}

**Code Changes:**
\`\`\`diff
${file.patch || 'No patch available'}
\`\`\`

${file.content ? `**Full File Content:**
\`\`\`${file.language.toLowerCase()}
${file.content}
\`\`\`` : '**Note:** Full file content not available, review based on diff only.'}
`).join('\n')}

Please provide a comprehensive code review focusing on:

1. **Code Quality & Best Practices**
   - Code style and formatting
   - Naming conventions
   - Code organization and structure

2. **Performance & Efficiency**
   - Potential performance bottlenecks
   - Resource usage optimization
   - Algorithm efficiency

3. **Security Concerns**
   - Input validation
   - Authentication/authorization
   - Data sanitization
   - Common security vulnerabilities

4. **Maintainability**
   - Code readability
   - Documentation
   - Error handling
   - Testing considerations

5. **Logic & Functionality**
   - Potential bugs or edge cases
   - Business logic correctness
   - Error scenarios

**Format your response as follows:**

## 🎯 Overall Assessment
[Brief summary of the PR and overall code quality]

## ✅ What's Good
[Highlight positive aspects of the code]

## 🔍 Issues Found
[List specific issues with file references and line numbers when possible]

## 💡 Suggestions
[Provide specific improvement suggestions]

## 🏁 Recommendation
[APPROVE, REQUEST_CHANGES, or COMMENT with reasoning]

Keep your feedback constructive, specific, and actionable. Focus on the most important issues first.
`;

  try {
    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: 'You are a senior software engineer and code reviewer with expertise in multiple programming languages. Provide thorough, constructive, and actionable code review feedback.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 3000
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating AI review:', error);
    throw error;
  }
}

// Parse AI review to extract recommendation
function parseRecommendation(review) {
  const recommendationMatch = review.match(/## 🏁 Recommendation\s*\*?\*?([A-Z_]+)/i);
  if (recommendationMatch) {
    const rec = recommendationMatch[1].toUpperCase();
    if (['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(rec)) {
      return rec;
    }
  }
  
  // Fallback logic based on content
  if (review.toLowerCase().includes('request changes') || 
      review.toLowerCase().includes('issues found') && 
      review.toLowerCase().includes('critical')) {
    return 'REQUEST_CHANGES';
  } else if (review.toLowerCase().includes('approve') ||
             review.toLowerCase().includes('looks good')) {
    return 'APPROVE';
  }
  
  return 'COMMENT';
}

// Submit review to GitHub
async function submitReview(owner, repo, pullNumber, review, event) {
  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      body: review,
      event: event
    });
    
    console.log(`Review submitted for PR #${pullNumber} with event: ${event}`);
  } catch (error) {
    console.error('Error submitting review:', error);
    throw error;
  }
}

// Main webhook handler
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const payload = JSON.stringify(req.body);

  // Verify webhook signature
  if (!verifySignature(payload, signature)) {
    console.log('Invalid webhook signature');
    return res.status(401).send('Unauthorized');
  }

  const event = req.headers['x-github-event'];
  const { action, pull_request, repository } = req.body;

  // Only process pull request opened and synchronize events
  if (event === 'pull_request' && ['opened', 'synchronize'].includes(action)) {
    const { owner, repo } = {
      owner: repository.owner.login,
      repo: repository.name
    };
    
    const pullNumber = pull_request.number;
    const prTitle = pull_request.title;
    const prDescription = pull_request.body || '';

    console.log(`Processing PR #${pullNumber} in ${owner}/${repo}`);

    try {
      // Skip draft PRs
      if (pull_request.draft) {
        console.log('Skipping draft PR');
        return res.status(200).send('Draft PR skipped');
      }

      // Get PR diff and files
      const files = await getPullRequestDiff(owner, repo, pullNumber);
      
      if (files.length === 0) {
        console.log('No code files to review');
        return res.status(200).send('No code files to review');
      }

      // Generate AI review
      const aiReview = await generateCodeReview(files, prDescription, prTitle);
      
      // Parse recommendation
      const recommendation = parseRecommendation(aiReview);
      
      // Submit review
      await submitReview(owner, repo, pullNumber, aiReview, recommendation);
      
      res.status(200).send('Review completed successfully');
      
    } catch (error) {
      console.error('Error processing webhook:', error);
      
      // Post error comment
      try {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: '🤖 **AI Code Review Bot Error**\n\nSorry, I encountered an error while reviewing this PR. Please check the logs or try again later.'
        });
      } catch (commentError) {
        console.error('Error posting error comment:', commentError);
      }
      
      res.status(500).send('Internal server error');
    }
  } else {
    res.status(200).send('Event not processed');
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Start server
const server = app.listen(config.port, () => {
  console.log(`🤖 AI Code Review Bot running on port ${config.port}`);
  console.log('Ready to review pull requests!');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;