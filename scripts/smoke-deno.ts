// Deno smoke: `deno run --allow-read scripts/smoke-deno.ts` (after `npm run build`).
// Deno consumes the same ESM bundle the browser does.
import { runSmoke } from "./smoke-shared.mjs";
runSmoke("deno");
