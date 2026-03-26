import {
  FileState,
  GoogleGenAI,
  Type,
  createPartFromUri,
  createUserContent,
} from "@google/genai";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getGeminiModelName() {
  return process.env.GEMINI_MODEL ?? "gemini-3.1-pro-preview";
}

export function getGeminiTranscriptionModelName() {
  return process.env.GEMINI_TRANSCRIPTION_MODEL ?? "gemini-3-flash-preview";
}

function getApiKey() {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new Error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY)");
  }
  return key;
}

export function getGeminiClient() {
  return new GoogleGenAI({ apiKey: getApiKey() });
}

export async function uploadAndWait(params: {
  filePath: string;
  mimeType: string;
  displayName: string;
}) {
  console.log("[gemini] uploading file", {
    displayName: params.displayName,
    filePath: params.filePath,
    mimeType: params.mimeType,
  });
  const ai = getGeminiClient();
  const uploaded = await ai.files.upload({
    file: params.filePath,
    config: {
      mimeType: params.mimeType,
      displayName: params.displayName,
    },
  });

  let file = uploaded;
  const name = file.name;
  const fileUri = file.uri;

  if (!name || !fileUri) {
    throw new Error("Gemini file upload did not return name/uri");
  }

  console.log("[gemini] file uploaded", {
    displayName: params.displayName,
    fileName: name,
    initialState: String(file.state),
  });

  for (let index = 0; index < 120; index++) {
    if (file.state === FileState.ACTIVE) break;
    if (file.state === FileState.FAILED) {
      await safeDelete(ai, name);
      throw new Error(file.error?.message ?? "Gemini file processing failed");
    }

    if (index === 0 || (index + 1) % 10 === 0) {
      console.log("[gemini] waiting for file to become ACTIVE", {
        displayName: params.displayName,
        fileName: name,
        attempt: index + 1,
        state: String(file.state),
      });
    }

    await sleep(2000);
    file = await ai.files.get({ name });
  }

  if (file.state !== FileState.ACTIVE) {
    await safeDelete(ai, name);
    throw new Error("Gemini file did not become ACTIVE in time");
  }

  console.log("[gemini] file ACTIVE", {
    displayName: params.displayName,
    fileName: name,
  });

  return {
    ai,
    name,
    file,
    fileUri,
  };
}

export async function withUploadedFile<T>(params: {
  filePath: string;
  mimeType: string;
  displayName: string;
  run: (context: Awaited<ReturnType<typeof uploadAndWait>>) => Promise<T>;
}) {
  const context = await uploadAndWait({
    filePath: params.filePath,
    mimeType: params.mimeType,
    displayName: params.displayName,
  });

  try {
    return await params.run(context);
  } finally {
    await safeDelete(context.ai, context.name);
  }
}

export async function generateJsonFromUploadedFile<T>(params: {
  filePath: string;
  mimeType: string;
  displayName: string;
  responseSchema: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}) {
  return withUploadedFile<T>({
    filePath: params.filePath,
    mimeType: params.mimeType,
    displayName: params.displayName,
    run: async ({ ai, file, fileUri }) => {
      console.log("[gemini] generateContent start", {
        displayName: params.displayName,
        model: params.model ?? getGeminiModelName(),
        mimeType: (file.mimeType as string) || params.mimeType,
      });
      const response = await ai.models.generateContent({
        model: params.model ?? getGeminiModelName(),
        contents: createUserContent([
          createPartFromUri(
            fileUri,
            (file.mimeType as string) || params.mimeType,
          ),
          params.userPrompt,
        ]),
        config: {
          systemInstruction: params.systemPrompt,
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: params.responseSchema as {
            type: Type;
          },
          maxOutputTokens: 65536,
        },
      });

      if (!response.text) {
        throw new Error("Gemini returned an empty response");
      }

      console.log("[gemini] generateContent complete", {
        displayName: params.displayName,
        textLength: response.text.length,
      });

      try {
        return JSON.parse(response.text) as T;
      } catch {
        throw new Error("Gemini returned invalid JSON");
      }
    },
  });
}

export async function generateJsonFromText<T>(params: {
  responseSchema: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}) {
  const ai = getGeminiClient();
  console.log("[gemini] text-only generateContent start", {
    model: params.model ?? getGeminiModelName(),
    promptLength: params.userPrompt.length,
  });
  const response = await ai.models.generateContent({
    model: params.model ?? getGeminiModelName(),
    contents: params.userPrompt,
    config: {
      systemInstruction: params.systemPrompt,
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: params.responseSchema as {
        type: Type;
      },
      maxOutputTokens: 65536,
    },
  });

  if (!response.text) {
    throw new Error("Gemini returned an empty response");
  }

  console.log("[gemini] text-only generateContent complete", {
    textLength: response.text.length,
  });

  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }
}

async function safeDelete(ai: GoogleGenAI, name: string | undefined) {
  if (!name) return;
  try {
    await ai.files.delete({ name });
  } catch {
    // Ignore cleanup errors.
  }
}
