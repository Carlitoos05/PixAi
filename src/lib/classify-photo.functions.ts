import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  imageBase64: z.string().min(10),
});

export type ClassifyResult = {
  isLabel: boolean;
  team: string | null;
  category: string | null;
};

const SYSTEM_PROMPT = `Eres un asistente que analiza fotos de un torneo de fútbol.
Los fotógrafos primero hacen una foto a una ETIQUETA impresa (un cartel/papel con el nombre del equipo resaltado en un color y la categoría) y después fotos del equipo.

Tu tarea: determinar si la foto recibida es una ETIQUETA o no.

Si es una etiqueta, extrae:
- "team": el nombre del equipo, normalmente resaltado con fondo de color (ej: "CCE TIANA 'B'", "FC BARCELONA A").
- "category": la categoría, normalmente un código corto (ej: "S12o", "S10", "Alevín", "Cadete", "Benjamín").

Si NO es una etiqueta (foto de jugadores, equipo, paisaje, etc.) devuelve isLabel=false y los demás campos en null.

Responde ÚNICAMENTE con JSON válido en este formato exacto:
{"isLabel": true|false, "team": "..."|null, "category": "..."|null}`;

export const classifyPhoto = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => Input.parse(input))
  .handler(async ({ data }): Promise<ClassifyResult> => {
    const lovableKey = process.env.LOVABLE_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (!lovableKey && !geminiKey) {
      throw new Error(
        "Falta la clave de IA. En local, añade GEMINI_API_KEY=... en tu archivo .env",
      );
    }

    const endpoint = lovableKey
      ? "https://ai.gateway.lovable.dev/v1/chat/completions"
      : "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    const model = lovableKey ? "google/gemini-3.1-flash-lite" : "gemini-3.5-flash-lite";

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey ?? geminiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Analiza esta foto y responde solo con el JSON pedido." },
              { type: "image_url", image_url: { url: data.imageBase64 } },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });


    if (res.status === 429) {
      throw new Error("Límite de peticiones alcanzado. Espera un momento e intenta de nuevo.");
    }
    if (res.status === 402) {
      throw new Error("Sin créditos de IA. Añade créditos en tu workspace.");
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Error IA ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    const content: string = json.choices?.[0]?.message?.content ?? "{}";

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : {};
    }

    const p = parsed as Partial<ClassifyResult>;
    return {
      isLabel: Boolean(p.isLabel),
      team: typeof p.team === "string" ? p.team.trim() : null,
      category: typeof p.category === "string" ? p.category.trim() : null,
    };
  });
