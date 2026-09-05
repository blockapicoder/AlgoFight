// ts-context-prune.ts

import { createClient } from "./node_modules/tauri-kargo-tools/src/api";
import { Content, TypescriptContext } from "./robot-explorateur";

const tauriKargoClient = createClient()

/**
 * Construit un contexte réduit à partir d’un fichier d’entrée.
 * - ctx : { [path]: source }
 * - entry : "index.ts" ou ["index.ts", "autre.ts"]
 * - exts : extensions à essayer pour la résolution (par défaut .ts/.tsx/.js/.jsx)
 */
export async function buildLightContext(
  ctx: TypescriptContext,
  entry: string | string[],
  exts: string[] = [".ts", ".tsx", ".js", ".jsx"]
): Promise<TypescriptContext> {
  const normIndex = new Map<
    string,
    { key: string; content: Content }
  >();

  // Index des fichiers par chemin normalisé
  for (const [key, content] of Object.entries(ctx)) {
    const norm = normalizePath(key);
    normIndex.set(norm, { key, content });
  }

  const entries = Array.isArray(entry) ? entry : [entry];
  const entryNorms = entries.map((e) => normalizePath(e));

  for (const e of entryNorms) {
    if (!normIndex.has(e)) {
      throw new Error(`Entry "${e}" introuvable dans le contexte.`);
    }
  }

  const visited = new Set<string>(); // chemins normalisés
  const stack: string[] = [...entryNorms];
  const result: TypescriptContext = {};

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const rec = normIndex.get(current);
    if (!rec) continue;

    // Ajout dans le contexte réduit avec le nom de fichier original
    result[rec.key] = rec.content;

    // Extraction des imports
    if (!rec.content.content) {
     rec.content.content  = await tauriKargoClient.readFileText(rec.content.path)
    }
    const specs = findImports(rec.content.content);

    for (const spec of specs) {
      const resolved = resolveImport(current, spec, exts, normIndex);
      if (resolved && !visited.has(resolved)) {
        stack.push(resolved);
      }
    }
  }

  return result;
}

/* ---------- Helpers ---------- */

function normalizePath(path: string): string {
  // style POSIX, sans "./", avec .. résolus
  const cleaned = path.replace(/\\/g, "/");
  const parts = cleaned.split("/");
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

/**
 * Extrait les specifiers d'import/export/require/import()
 * Ne garde que les chemins relatifs ("./", "../", "/").
 */
function findImports(source: string): string[] {
  const specs: string[] = [];

  const add = (s: string) => {
    if (!s) return;
    if (s.startsWith(".") || s.startsWith("/")) specs.push(s);
  };

  // import ..., import "x"
  const reImport = /\bimport\s+(?:[^'"]*?from\s*)?["']([^"']+)["']/g;
  // export ... from "x"
  const reExport = /\bexport\s+(?:[^'"]*?from\s*)?["']([^"']+)["']/g;
  // dynamic import("x")
  const reDynImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  // require("x")
  const reRequire = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

  let m: RegExpExecArray | null;
  while ((m = reImport.exec(source))) add(m[1]);
  while ((m = reExport.exec(source))) add(m[1]);
  while ((m = reDynImport.exec(source))) add(m[1]);
  while ((m = reRequire.exec(source))) add(m[1]);

  return specs;
}

/**
 * Résout un specifier relatif à partir d'un fichier courant normalisé.
 * Retourne le chemin normalisé s'il existe dans l'index, sinon null.
 */
function resolveImport(
  fromNorm: string,
  spec: string,
  exts: string[],
  index: Map<string, { key: string; content: Content }>
): string | null {
  let base: string;

  if (spec.startsWith("/")) {
    // Chemin "absolu" dans le contexte virtuel : on enlève les /
    base = normalizePath(spec.replace(/^\/+/, ""));
  } else {
    // Relatif : ./ or ../
    const fromParts = fromNorm.split("/");
    fromParts.pop(); // dossier contenant le fichier courant
    base = normalizePath([...fromParts, spec].join("/"));
  }

  const hasKnownExt = exts.some((ext) => base.endsWith(ext));

  // 1) Si le specifier a déjà une extension connue, essayer tel quel
  if (hasKnownExt) {
    if (index.has(base)) return base;
  } else {
    // 2) Essayer base + ext
    for (const ext of exts) {
      const candidate = base + ext;
      if (index.has(candidate)) return candidate;
    }
  }

  // 3) Essayer base/index + ext
  for (const ext of exts) {
    const candidate = normalizePath(base + "/index" + ext);
    if (index.has(candidate)) return candidate;
  }

  // Non résolu (probablement un module externe ou absent du contexte)
  return null;
}

/* ---------- Exemple d'utilisation ---------- */
/*
const ctx: TypescriptContext = {
  "index.ts": "import * as lib from './lib-test'; console.log(lib.print());",
  "lib-test.ts": "export function print(){ return 'ok'; }",
  "unused.ts": "console.log('jamais importé');"
};

const light = buildLightContext(ctx, "index.ts");
// light contient uniquement "index.ts" et "lib-test.ts"
*/
