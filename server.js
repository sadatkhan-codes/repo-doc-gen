require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { Octokit } = require("octokit");
const { GoogleGenAI } = require("@google/genai");

const app = express();

const PORT = process.env.PORT || 3000;

// ============================================================
// API CLIENTS
// ============================================================

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// ============================================================
// SETTINGS
// ============================================================

const MAX_FILE_SIZE = 10000;
const MAX_TOTAL_AI_CONTENT = 70000;
const MAX_IMPORTANT_FILES = 18;

// Try less busy / efficient models first.
// If one is unavailable, the next one is tried automatically.
const GEMINI_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
];

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());

app.use(
  express.json({
    limit: "1mb",
  }),
);

app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Automated README Generator server is running",
    geminiModels: GEMINI_MODELS,
  });
});

// ============================================================
// ENVIRONMENT CHECK
// ============================================================

if (!process.env.GITHUB_TOKEN) {
  console.warn("WARNING: GITHUB_TOKEN is not configured.");
}

if (!process.env.GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is not configured.");
}

// ============================================================
// GITHUB URL PARSER
// ============================================================

function parseGitHubUrl(repoUrl) {
  let url;

  try {
    url = new URL(repoUrl);
  } catch {
    throw new Error("Invalid GitHub repository URL.");
  }

  if (url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Please enter a valid github.com repository URL.");
  }

  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length < 2) {
    throw new Error(
      "Invalid GitHub repository URL. Example: https://github.com/owner/repository",
    );
  }

  const owner = parts[0];

  let repo = parts[1];

  if (repo.endsWith(".git")) {
    repo = repo.slice(0, -4);
  }

  return {
    owner,
    repo,
  };
}

// ============================================================
// READ FILE FROM GITHUB
// ============================================================

async function readGitHubFile(owner, repo, filePath) {
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
    });

    // Directory instead of file
    if (Array.isArray(response.data)) {
      return null;
    }

    if (!response.data.content) {
      return null;
    }

    return Buffer.from(response.data.content, "base64").toString("utf-8");
  } catch (error) {
    console.log(`Could not read ${filePath}: ${error.message}`);

    return null;
  }
}

// ============================================================
// SELECT IMPORTANT FILES
// ============================================================

function selectImportantFiles(tree) {
  const files = tree
    .filter((file) => file.type === "blob")
    .map((file) => file.path);

  const selected = [];

  function addIfExists(filePath) {
    if (files.includes(filePath) && !selected.includes(filePath)) {
      selected.push(filePath);
    }
  }

  // ----------------------------------------------------------
  // Documentation
  // ----------------------------------------------------------

  const documentationFiles = [
    "README.md",
    "README",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
  ];

  for (const file of documentationFiles) {
    addIfExists(file);
  }

  // ----------------------------------------------------------
  // Package / dependency files
  // ----------------------------------------------------------

  const packageFiles = [
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "Pipfile",
    "poetry.lock",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "composer.json",
    "Gemfile",
  ];

  for (const file of packageFiles) {
    addIfExists(file);
  }

  // ----------------------------------------------------------
  // Build / deployment files
  // ----------------------------------------------------------

  const buildFiles = [
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    ".dockerignore",
    "Makefile",
    "vercel.json",
    "netlify.toml",
  ];

  for (const file of buildFiles) {
    addIfExists(file);
  }

  // ----------------------------------------------------------
  // Configuration files
  // ----------------------------------------------------------

  const configFiles = [
    "tsconfig.json",
    "vite.config.js",
    "vite.config.ts",
    "next.config.js",
    "next.config.ts",
    "webpack.config.js",
    "webpack.config.ts",
    "angular.json",
    "astro.config.js",
    "astro.config.ts",
    "nuxt.config.js",
    "nuxt.config.ts",
    "tailwind.config.js",
    "tailwind.config.ts",
  ];

  for (const file of configFiles) {
    addIfExists(file);
  }

  // ----------------------------------------------------------
  // Common entry points
  // ----------------------------------------------------------

  const entryPointNames = [
    "index.js",
    "index.jsx",
    "index.ts",
    "index.tsx",

    "server.js",
    "server.ts",

    "app.js",
    "app.ts",

    "main.js",
    "main.jsx",
    "main.ts",
    "main.tsx",

    "src/index.js",
    "src/index.jsx",
    "src/index.ts",
    "src/index.tsx",

    "src/main.js",
    "src/main.jsx",
    "src/main.ts",
    "src/main.tsx",

    "src/App.js",
    "src/App.jsx",
    "src/App.ts",
    "src/App.tsx",

    "main.py",
    "app.py",
    "main.go",
    "main.rs",
  ];

  for (const file of entryPointNames) {
    addIfExists(file);
  }

  // ----------------------------------------------------------
  // Source entry points
  // ----------------------------------------------------------

  const sourceCandidates = files.filter((file) => {
    const lower = file.toLowerCase();

    if (
      lower.includes("node_modules/") ||
      lower.includes(".git/") ||
      lower.includes("dist/") ||
      lower.includes("build/") ||
      lower.includes("coverage/")
    ) {
      return false;
    }

    return (
      lower.includes("/src/") &&
      (lower.endsWith("/index.js") ||
        lower.endsWith("/index.jsx") ||
        lower.endsWith("/index.ts") ||
        lower.endsWith("/index.tsx") ||
        lower.endsWith("/main.js") ||
        lower.endsWith("/main.jsx") ||
        lower.endsWith("/main.ts") ||
        lower.endsWith("/main.tsx") ||
        lower.endsWith("/app.js") ||
        lower.endsWith("/app.jsx") ||
        lower.endsWith("/app.ts") ||
        lower.endsWith("/app.tsx"))
    );
  });

  for (const file of sourceCandidates.slice(0, 6)) {
    addIfExists(file);
  }

  // ----------------------------------------------------------
  // Backend entry points
  // ----------------------------------------------------------

  const backendCandidates = files.filter((file) => {
    const lower = file.toLowerCase();

    if (
      lower.includes("node_modules/") ||
      lower.includes(".git/") ||
      lower.includes("dist/") ||
      lower.includes("build/")
    ) {
      return false;
    }

    return (
      lower.endsWith("/server.js") ||
      lower.endsWith("/server.ts") ||
      lower.endsWith("/app.py") ||
      lower.endsWith("/main.py")
    );
  });

  for (const file of backendCandidates.slice(0, 4)) {
    addIfExists(file);
  }

  return selected.slice(0, MAX_IMPORTANT_FILES);
}

// ============================================================
// CLEAN GEMINI RESPONSE
// ============================================================

function cleanGeminiResponse(text) {
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  let cleaned = text.trim();

  // Remove Markdown JSON fences
  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Direct JSON
  try {
    return JSON.parse(cleaned);
  } catch {}

  // Find JSON object inside response
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const possibleJson = cleaned.slice(firstBrace, lastBrace + 1);

    try {
      return JSON.parse(possibleJson);
    } catch {}
  }

  throw new Error("Gemini returned invalid JSON.");
}

// ============================================================
// CHECK IF GEMINI ERROR IS TEMPORARY
// ============================================================

function isRetryableGeminiError(error) {
  const message = String(error?.message || "").toLowerCase();

  return (
    message.includes("503") ||
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("504") ||
    message.includes("high demand") ||
    message.includes("overloaded") ||
    message.includes("temporarily") ||
    message.includes("unavailable") ||
    message.includes("resource exhausted")
  );
}

// ============================================================
// WAIT
// ============================================================

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ============================================================
// GEMINI GENERATION WITH AUTOMATIC FALLBACK
// ============================================================

async function generateWithGemini(prompt) {
  let lastError = null;

  for (const model of GEMINI_MODELS) {
    console.log("");
    console.log(`Trying Gemini model: ${model}`);

    // Try each model twice
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Gemini attempt ${attempt}/2 using ${model}...`);

        const response = await ai.models.generateContent({
          model: model,
          contents: prompt,

          config: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        });

        console.log(`Gemini request successful using ${model}.`);

        return response;
      } catch (error) {
        lastError = error;

        console.log(`Gemini error with ${model}:`);

        console.log(error.message);

        // If this is a permanent error,
        // immediately move to next model.
        if (!isRetryableGeminiError(error)) {
          console.log(`Non-retryable error for ${model}.`);

          break;
        }

        // Temporary error:
        // wait before trying same model again.
        if (attempt < 2) {
          const waitTime = attempt === 1 ? 4000 : 8000;

          console.log(
            `Temporary Gemini error. Waiting ${waitTime / 1000} seconds...`,
          );

          await wait(waitTime);
        }
      }
    }

    console.log(`Model ${model} failed. Trying next model...`);
  }

  throw lastError || new Error("All Gemini models failed.");
}

// ============================================================
// MAIN GENERATION ENDPOINT
// ============================================================

app.post("/api/generate", async (req, res) => {
  try {
    const repoUrl = req.body?.repoUrl;

    console.log("");
    console.log("=================================");
    console.log("Repository received:", repoUrl);
    console.log("=================================");

    // --------------------------------------------------------
    // Validate URL
    // --------------------------------------------------------

    if (!repoUrl) {
      return res.status(400).json({
        error: "GitHub repository URL is required.",
      });
    }

    let owner;
    let repo;

    try {
      const parsed = parseGitHubUrl(repoUrl);

      owner = parsed.owner;
      repo = parsed.repo;
    } catch (error) {
      return res.status(400).json({
        error: error.message,
      });
    }

    console.log(`Owner: ${owner}`);
    console.log(`Repository: ${repo}`);

    // --------------------------------------------------------
    // Get repository information
    // --------------------------------------------------------

    console.log("");
    console.log("Fetching repository information...");

    let repositoryResponse;

    try {
      repositoryResponse = await octokit.rest.repos.get({
        owner,
        repo,
      });
    } catch (error) {
      console.error("GitHub repository request failed:", error.message);

      if (error.status === 404) {
        return res.status(404).json({
          error:
            "Repository not found. Make sure the repository is public or your GitHub token has access to it.",
        });
      }

      if (error.status === 403) {
        return res.status(403).json({
          error:
            "GitHub API access was denied or rate limited. Check your GitHub token.",
        });
      }

      throw error;
    }

    const repository = repositoryResponse.data;
    console.log("GitHub owner:", repository.owner?.login);
    console.log("GitHub full name:", repository.full_name);
    console.log("GitHub URL:", repository.html_url);

    console.log("Repository:", repository.name);

    console.log("Default branch:", repository.default_branch);

    // --------------------------------------------------------
    // Get complete repository tree
    // --------------------------------------------------------

    console.log("");
    console.log("Fetching repository tree...");

    const treeResponse = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: repository.default_branch,
      recursive: "true",
    });

    const tree = treeResponse.data.tree || [];

    console.log("Total repository items:", tree.length);

    if (treeResponse.data.truncated) {
      console.log("WARNING: GitHub truncated the repository tree.");
    }

    const totalFiles = tree.filter((file) => file.type === "blob").length;

    const totalFolders = tree.filter((file) => file.type === "tree").length;

    console.log("Files:", totalFiles);

    console.log("Folders:", totalFolders);

    // --------------------------------------------------------
    // Select important files
    // --------------------------------------------------------

    const importantFiles = selectImportantFiles(tree);

    console.log("");
    console.log("Selected important files:");

    console.log(importantFiles);

    // --------------------------------------------------------
    // Read important files
    // --------------------------------------------------------

    console.log("");
    console.log("Reading important files...");

    const fileResults = await Promise.all(
      importantFiles.map(async (filePath) => {
        console.log(`Reading: ${filePath}`);

        const content = await readGitHubFile(owner, repo, filePath);

        if (!content) {
          return null;
        }

        return {
          path: filePath,
          content: content.slice(0, MAX_FILE_SIZE),
        };
      }),
    );

    const fileContents = fileResults.filter(Boolean);

    // --------------------------------------------------------
    // Limit total AI input
    // --------------------------------------------------------

    let totalCharacters = 0;

    const limitedFileContents = [];

    for (const file of fileContents) {
      const remaining = MAX_TOTAL_AI_CONTENT - totalCharacters;

      if (remaining <= 0) {
        break;
      }

      const content = file.content.slice(0, remaining);

      limitedFileContents.push({
        path: file.path,
        content: content,
      });

      totalCharacters += content.length;
    }

    console.log("Files successfully read:", fileContents.length);

    console.log("Characters sent to Gemini:", totalCharacters);

    // --------------------------------------------------------
    // Read package.json
    // --------------------------------------------------------

    let packageJson = null;

    const packageFile = tree.find(
      (file) => file.type === "blob" && file.path === "package.json",
    );

    if (packageFile) {
      console.log("");
      console.log("Reading package.json...");

      const packageContent = await readGitHubFile(owner, repo, "package.json");

      if (packageContent) {
        try {
          packageJson = JSON.parse(packageContent);
        } catch {
          console.log("package.json could not be parsed.");

          packageJson = null;
        }
      }
    }

    // --------------------------------------------------------
    // Project information
    // --------------------------------------------------------

    const projectInfo = {
      name: packageJson?.name || repository.name,

      version: packageJson?.version || null,

      description: packageJson?.description || repository.description || null,

      packageManager: packageJson?.packageManager || null,

      dependencies: Object.keys(packageJson?.dependencies || {}),

      devDependencies: Object.keys(packageJson?.devDependencies || {}),

      scripts: Object.keys(packageJson?.scripts || {}),
    };

    // --------------------------------------------------------
    // Repository structure
    // --------------------------------------------------------

    const structure = {
      totalItems: tree.length,

      files: totalFiles,

      folders: totalFolders,

      treeTruncated: treeResponse.data.truncated || false,

      importantFiles: importantFiles,
    };

    // --------------------------------------------------------
    // Data sent to Gemini
    // --------------------------------------------------------

    const analysisData = {
      repository: {
        name: repository.name,

        fullName: repository.full_name,

        description: repository.description,

        language: repository.language,

        defaultBranch: repository.default_branch,

        license: repository.license?.spdx_id || null,
      },

      structure,

      projectInfo,

      files: limitedFileContents,
    };

    // --------------------------------------------------------
    // Gemini prompt
    // --------------------------------------------------------

    console.log("");
    console.log("Preparing Gemini prompt...");

    const prompt = `
You are an expert software documentation engineer.
==================================================
LINK RULES
==================================================

1. When linking to files in the repository, use the
actual GitHub repository URL.

2. The repository URL is:

${repository.html_url}

3. NEVER generate:
http://localhost:3000
http://localhost:3000/
localhost:3000
or any localhost URL.

4. Do not invent external URLs.

5. If a repository file is referenced and the exact
GitHub URL cannot be determined, use the file path
as plain text instead of inventing a URL.

6. Preserve URLs from the existing README when they
are supplied as repository evidence.

7. Never replace a GitHub URL with localhost.
Analyze the supplied GitHub repository data and create
accurate developer documentation.

IMPORTANT:

Use ONLY the information supplied below.

Do NOT invent functionality.

Do NOT assume technologies that are not supported
by the supplied repository data.

Do NOT invent:

- APIs
- databases
- authentication systems
- cloud services
- environment variables
- installation commands
- features
- frameworks
- architecture components

If something cannot be determined, simply omit it
or write:

"Not determined from repository."

Existing README content can be used as evidence.

==================================================
TASK
==================================================

Generate:

1. A professional README.md
2. A Mermaid architecture diagram
3. A concise technical summary

==================================================
README
==================================================

Create a useful README containing applicable sections:

# Project title

## Description

## Features

## Technology Stack

## Project Structure

## Prerequisites

## Installation

## Configuration

## Usage

## Available Scripts

## Dependencies

## Development

## Testing

## Build

## Architecture

## Additional Notes

Only include sections supported by the repository.

Do not invent commands.

==================================================
ARCHITECTURE
==================================================

Create a valid Mermaid diagram.

Show only components that can reasonably be identified
from the repository.

Possible things to show when supported:

- frontend
- backend
- modules
- services
- APIs
- databases
- external services
- important data flow

Keep the diagram simple and readable.

Return Mermaid code WITHOUT Markdown code fences.

Example:

graph TD
    A[Frontend] --> B[Backend]
    B --> C[Database]

==================================================
OUTPUT
==================================================

Return ONLY valid JSON.

Use exactly:

{
  "summary": "short technical summary",
  "readme": "complete README markdown",
  "architecture": "complete Mermaid diagram"
}

==================================================
REPOSITORY DATA
==================================================

${JSON.stringify(analysisData, null, 2)}
`;

    // --------------------------------------------------------
    // Call Gemini
    // --------------------------------------------------------

    console.log("");
    console.log("Sending project information to Gemini...");

    const geminiResponse = await generateWithGemini(prompt);

    console.log("");
    console.log("Gemini response received.");

    const aiText = geminiResponse.text;

    // --------------------------------------------------------
    // Parse Gemini JSON
    // --------------------------------------------------------

    let generated;

    try {
      generated = cleanGeminiResponse(aiText);
    } catch (error) {
      console.error("Could not parse Gemini response.");

      console.error(aiText);

      return res.status(500).json({
        error:
          "Gemini returned an invalid documentation response. Please try again.",
      });
    }

    // --------------------------------------------------------
    // Validate response
    // --------------------------------------------------------

    if (typeof generated !== "object" || generated === null) {
      return res.status(500).json({
        error: "Gemini returned an invalid response format.",
      });
    }

    const summary =
      typeof generated.summary === "string" ? generated.summary : "";

    const readme = typeof generated.readme === "string" ? generated.readme : "";

    const architecture =
      typeof generated.architecture === "string" ? generated.architecture : "";

    if (!readme && !architecture) {
      return res.status(500).json({
        error: "Gemini did not generate usable documentation.",
      });
    }

    // --------------------------------------------------------
    // SUCCESS
    // --------------------------------------------------------

    console.log("");
    console.log("Documentation generated successfully!");

    console.log("README characters:", readme.length);

    console.log("Architecture characters:", architecture.length);

    return res.json({
      message: "README generated successfully!",

      repository: {
        name: repository.name,

        fullName: repository.full_name,

        description: repository.description,

        language: repository.language,

        stars: repository.stargazers_count,

        forks: repository.forks_count,

        defaultBranch: repository.default_branch,

        url: repository.html_url,
      },

      analysis: {
        repository: analysisData.repository,

        structure: analysisData.structure,

        projectInfo: analysisData.projectInfo,

        files: analysisData.files,
      },

      generated: {
        summary: summary,

        readme: readme,

        architecture: architecture,
      },
    });
  } catch (error) {
    console.error("");
    console.error("=================================");

    console.error("SERVER ERROR:");

    console.error(error);

    console.error("=================================");

    const message = error?.message || "Could not generate documentation.";

    // --------------------------------------------------------
    // Gemini errors
    // --------------------------------------------------------

    if (
      message.includes("API key") ||
      message.includes("api key") ||
      message.includes("401")
    ) {
      return res.status(500).json({
        error: "Gemini API key is missing or invalid. Check your .env file.",
      });
    }

    if (message.includes("quota") || message.includes("resource exhausted")) {
      return res.status(429).json({
        error: "Gemini API quota was reached. Please try again later.",
      });
    }

    if (
      message.includes("503") ||
      message.includes("high demand") ||
      message.includes("unavailable")
    ) {
      return res.status(503).json({
        error:
          "Gemini is temporarily busy. The server tried multiple Gemini models but they were unavailable. Please try again in a few moments.",
      });
    }

    // --------------------------------------------------------
    // Generic error
    // --------------------------------------------------------

    return res.status(500).json({
      error: message,
    });
  }
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log("");
  console.log("=================================");

  console.log("Automated README Generator");

  console.log(`Server running at http://localhost:${PORT}`);

  console.log("Gemini fallback models:");

  console.log(GEMINI_MODELS.join(" → "));

  console.log("=================================");

  console.log("");
});
