# PixAi — Instrucciones para ejecutar en local

## Requisitos

- [Bun](https://bun.sh/) instalado (funciona también con Node + npm, pero el proyecto usa Bun).
- Una clave de API de Google Gemini (Google AI Studio): https://aistudio.google.com/apikey

## Pasos

1. Descomprime el ZIP.
2. Abre una terminal en la carpeta del proyecto.
3. Ejecuta:
   ```bash
   bun install
   ```
4. Crea un archivo llamado `.env` en la raíz del proyecto (junto a `package.json`) con tu clave:
   ```env
   GEMINI_API_KEY=PEGA_AQUÍ_TU_CLAVE
   ```
   > No uses comillas. El archivo debe llamarse exactamente `.env`, no `.env.txt`.
5. Ejecuta:
   ```bash
   bun dev
   ```
6. Abre http://localhost:8080 en tu navegador.

## Notas importantes

- El análisis con IA necesita internet porque se conecta directamente a Google Gemini.
- La versión local usa el modelo `gemini-3.5-flash-lite`, disponible para claves nuevas de Google AI Studio.
- La clave `GEMINI_API_KEY` nunca se incluye en este ZIP por seguridad. Cada persona que use el proyecto debe crear la suya.
- Si ves errores de tipo `Missing LOVABLE_API_KEY`, significa que el servidor no ha leído tu `.env`. Para el servidor con `Ctrl+C` y vuelve a lanzar `bun dev`.
- En Lovable Cloud la app usa `LOVABLE_API_KEY`; en local usa `GEMINI_API_KEY`.
