// monaco.js (ES module)

const MONACO_BASE = window.MONACO_BASE || "/node_modules/monaco-editor/min";
const PROJECT_ROOT = "file:///";

let monacoPromise = null;
/* ---------- import path autocomplete (FS virtuel via filesObj) ---------- */

const importPathCompletionState = {
    disposable: null,
    filesObj: null,
};

function _normPath(p) {
    return String(p || "").replace(/^\/+/, "").replace(/\\/g, "/");
}
function _isCodeFile(p) {
    return /\.(tsx?|jsx?)$/.test(p);
}
function _stripExt(p) {
    return p.replace(/\.(tsx?|jsx?)$/, "");
}
function _dirname(p) {
    p = _normPath(p);
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(0, i) : "";
}
function _relativePath(fromDir, toPath) {
    fromDir = _normPath(fromDir);
    toPath = _normPath(toPath);

    const from = fromDir ? fromDir.split("/") : [];
    const to = toPath.split("/");

    let i = 0;
    while (i < from.length && i < to.length && from[i] === to[i]) i++;

    const upCount = from.length - i;
    const down = to.slice(i);

    const parts = [];
    for (let k = 0; k < upCount; k++) parts.push("..");
    parts.push(...down);

    let rel = parts.join("/");
    if (!rel) rel = ".";
    if (!rel.startsWith(".")) rel = "./" + rel;
    return rel;
}

function _toModuleSpecifier(fromFile, toFile) {
    const fromDir = _dirname(fromFile);

    // cible sans extension + "index" compacté
    let target = _stripExt(_normPath(toFile));
    if (target.endsWith("/index")) target = target.slice(0, -"/index".length) || ".";

    const rel = _relativePath(fromDir, target);
    return rel === "." ? "./" : rel;
}

function _toRootSpecifier(toFile) {
    let target = _stripExt(_normPath(toFile));
    if (target.endsWith("/index")) target = target.slice(0, -"/index".length);
    return target;
}

function enableImportPathAutocomplete(monaco, filesObj) {
    importPathCompletionState.filesObj = filesObj || {};

    if (importPathCompletionState.disposable) return;

    importPathCompletionState.disposable =
        monaco.languages.registerCompletionItemProvider("typescript", {
            triggerCharacters: ["'", '"', "/", "."],
            provideCompletionItems: (model, position) => {
                const files = importPathCompletionState.filesObj || {};
                const lineNumber = position.lineNumber;
                const line = model.getLineContent(lineNumber);

                // Monaco: position.column est 1-based
                const upto = line.slice(0, position.column - 1);

                // On ne déclenche que si on est dans:
                //   import ... from '...|
                //   export ... from '...|
                //   import('...|
                //   require('...|
                const m = upto.match(
                    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]*)$/
                );
                if (!m) return { suggestions: [] };

                const typed = m[1] || "";
                const startIndex = upto.length - typed.length; // 0-based index du début du fragment tapé

                const range = new monaco.Range(
                    lineNumber,
                    startIndex + 1,          // -> 1-based
                    lineNumber,
                    position.column
                );

                const currentPath = _normPath(model.uri.path); // ex: "/src/a.ts" -> "src/a.ts"

                const suggestionsSet = new Set();

                for (const p of Object.keys(files)) {
                    const fp = _normPath(p);
                    if (!_isCodeFile(fp)) continue;
                    if (fp === currentPath) continue;

                    // Si l’utilisateur tape un relatif ("." / ".."), on ne propose que du relatif.
                    // Sinon, on propose root + relatif (pratique quand on veut des imports type "src/...")
                    const relSpec = _toModuleSpecifier(currentPath, fp);
                    const rootSpec = _toRootSpecifier(fp);

                    const candidates = typed.startsWith(".")
                        ? [relSpec]
                        : [rootSpec, relSpec];

                    for (const spec of candidates) {
                        if (!spec) continue;
                        if (!spec.startsWith(typed)) continue;
                        if (spec.startsWith(".")) {
                            suggestionsSet.add(spec);
                        }
                    }
                }

                const suggestions = Array.from(suggestionsSet)
                    .sort((a, b) => a.localeCompare(b))
                    .map((spec) => ({
                        label: spec,
                        kind: monaco.languages.CompletionItemKind.File,
                        insertText: spec,
                        range,
                    }));

                return { suggestions };
            },
        });
}

/* ---------- utils scripts + CSS ---------- */

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = (e) => reject(e);
        document.head.appendChild(s);
    });
}

function ensureMonacoCss(rootNode) {
    const target = rootNode && rootNode.nodeType === 11 ? rootNode : document.head;

    if (
        target.querySelector &&
        target.querySelector('link[data-name="vs/editor/editor.main"]')
    ) {
        return;
    }

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = MONACO_BASE + "/vs/editor/editor.main.css";
    link.dataset.name = "vs/editor/editor.main";
    target.appendChild(link);
}

/* ---------- loadMonaco ---------- */

async function loadMonaco() {
    if (window.monaco) return window.monaco;

    if (!monacoPromise) {
        monacoPromise = (async () => {
            if (typeof window.require === "undefined" || !window.require.config) {
                await loadScript(MONACO_BASE + "/vs/loader.js");
            }

            window.require.config({
                paths: { vs: MONACO_BASE + "/vs" },
            });

            return new Promise((resolve, reject) => {
                window.require(["vs/editor/editor.main"], () => {
                    const ts = monaco.languages.typescript;

                    ts.typescriptDefaults.setEagerModelSync(true);
                    ts.typescriptDefaults.setDiagnosticsOptions({
                        noSemanticValidation: false,
                        noSyntaxValidation: false,
                    });

                    ts.typescriptDefaults.setCompilerOptions({
                        target: ts.ScriptTarget.ES2020,
                        module: ts.ModuleKind.ESNext,
                        moduleResolution: ts.ModuleResolutionKind.NodeJs,
                        allowNonTsExtensions: true,
                        allowJs: true,   // ✅ autorise les .js
                        checkJs: true,
                        strict: true,
                        noEmit: true,
                        lib: ["es2020", "dom"],
                    });

                    resolve(monaco);
                }, reject);
            });
        })();
    }

    return monacoPromise;
}

/* ---------- helpers projet (FS virtuel) ---------- */

function projectUri(monaco, path) {
    const clean = path.replace(/^\/+/, "").replace(/\\/g, "/");
    return monaco.Uri.parse(`${PROJECT_ROOT}${clean}`);
}

function languageFromPath(path) {
    if (
        path.endsWith(".ts") ||
        path.endsWith(".tsx") ||
        path.endsWith(".js") ||
        path.endsWith(".jsx")
    ) {
        // ✅ tout passe par le worker TypeScript
        return "typescript";
    }
    return "plaintext";
}

function syncProjectFiles(monaco, filesObj, entryPath) {
    const files = filesObj || {};
    const existing = monaco.editor.getModels();

    const allPaths = Object.keys(files);
    const needed = new Set(allPaths.map((p) => projectUri(monaco, p).toString()));

    // nettoyer les anciens modèles
    for (const model of existing) {
        const uriStr = model.uri.toString();
        if (uriStr.startsWith(PROJECT_ROOT) && !needed.has(uriStr)) {
            model.dispose();
        }
    }

    // ordre: tous sauf entry, puis entry
    let orderedPaths = allPaths;
    if (entryPath && allPaths.includes(entryPath)) {
        orderedPaths = allPaths.filter((p) => p !== entryPath);
        orderedPaths.push(entryPath); // ✅ entry en dernier
    }

    for (const path of orderedPaths) {
        const content = files[path].content;
        const uri = projectUri(monaco, path);
        const lang = languageFromPath(path);
        let model = monaco.editor.getModel(uri);

        if (!model) {
            monaco.editor.createModel(content, lang, uri);
        } else {
            if (model.getLanguageId() !== lang) {
                monaco.editor.setModelLanguage(model, lang);
            }
            if (model.getValue() !== content) {
                model.setValue(content);
            }
        }
    }
}

/* ---------- format diagnostics (TS worker) ---------- */

function flattenTsMessageText(messageText) {
    if (typeof messageText === "string") return messageText;

    // DiagnosticMessageChain
    const parts = [];
    let cur = messageText;
    while (cur) {
        if (cur.messageText) parts.push(String(cur.messageText));
        cur = cur.next && cur.next.length ? cur.next[0] : null;
    }
    return parts.join(" ");
}

function formatTsDiagnostics(diags, model) {
    if (!Array.isArray(diags) || diags.length === 0) return "";

    return diags
        .map((d) => {
            const start = typeof d.start === "number" ? d.start : 0;
            const pos = model.getPositionAt(start);
            const code = d.code ? `TS${d.code}` : "";
            const msg = flattenTsMessageText(d.messageText);
            const loc = `L${pos.lineNumber}:${pos.column}`;
            return [loc, code, msg].filter(Boolean).join(" ").trim();
        })
        .join("\n");
}

/* ---------- 1) Charger à partir d’un objet { [path]: string } ---------- */

export async function loadProjectFromObject(files) {
    const monaco = await loadMonaco();
    const filesObj = files || {};
    syncProjectFiles(monaco, filesObj);
    return { monaco, files: filesObj };
}

/* ---------- 2) Init éditeur dans Shadow DOM à partir de l’objet ---------- */

/**
 * options:
 * - files: { [path: string]: { content: string } }
 * - entry: string
 * - editorOptions: object
 * - onChange?: (type: "syntaxError" | "semanticError" | "value", payload: string) => void
 */
export async function initMonacoFromFilesObject(host, options = {}) {
    const { files, entry, editorOptions = {}, onChange } = options;
    if (!host) throw new Error("initMonacoFromFilesObject: host manquant");
    if (!files) throw new Error("initMonacoFromFilesObject: files manquant");

    // dispose ancien éditeur
    if (host._monacoEditor) {
        host._monacoEditor.dispose();
        host._monacoEditor = null;
    }

    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild);

    const container = document.createElement("div");
    container.style.width = "100%";
    container.style.height = "100%";
    shadow.appendChild(container);

    ensureMonacoCss(shadow);

    const monaco = await loadMonaco();
    const filesObj = files || {};

    const entryPath = entry || Object.keys(filesObj)[0];
    if (!entryPath) {
        throw new Error("initMonacoFromFilesObject: aucun fichier fourni");
    }

    // ⚙️ sync avec entry en dernier
    syncProjectFiles(monaco, filesObj, entryPath);
    enableImportPathAutocomplete(monaco, filesObj);

    const entryUri = projectUri(monaco, entryPath);
    let model = monaco.editor.getModel(entryUri);

    if (!model) {
        console.warn(
            "Models exist:",
            monaco.editor.getModels().map((m) => m.uri.toString())
        );
        throw new Error(
            `initMonacoFromFilesObject: fichier d'entrée introuvable: ${entryPath}`
        );
    }

    // init TS worker
    try {
        const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
        await getWorker(entryUri);
    } catch (e) {
        console.warn("[monaco] TS worker init failed:", e);
    }

    const editor = monaco.editor.create(container, {
        model,
        theme: "vs-dark",
        automaticLayout: true,
        ...editorOptions,
    });

    // --- Callback onChange (syntaxError -> semanticError -> value) ---
    if (typeof onChange === "function") {
        let timer = null;
        let seq = 0;

        const fileName = entryUri.toString(); // utilisé par le worker TS

        const runValidation = async (expectedSeq, expectedVersionId) => {
            try {
                const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
                const worker = await getWorker(entryUri);

                const synt = await worker.getSyntacticDiagnostics(fileName);

                // anti-race
                if (expectedSeq !== seq || expectedVersionId !== model.getVersionId()) return;

                if (synt && synt.length) {
                    onChange("syntaxError", formatTsDiagnostics(synt, model));
                    return;
                }

                const sem = await worker.getSemanticDiagnostics(fileName);

                if (expectedSeq !== seq || expectedVersionId !== model.getVersionId()) return;

                if (sem && sem.length) {
                    onChange("semanticError", formatTsDiagnostics(sem, model));
                    return;
                }

                onChange("value", model.getValue());
            } catch (e) {
                // fallback (si worker KO) via markers monaco
                const markers = monaco.editor.getModelMarkers({ resource: entryUri }) || [];
                if (markers.length) {
                    const msg = markers
                        .map((m) => `L${m.startLineNumber}:${m.startColumn} ${m.message}`)
                        .join("\n");
                    onChange("semanticError", msg);
                } else {
                    onChange("value", model.getValue());
                }
            }
        };

        const scheduleValidation = () => {
            seq += 1;
            const mySeq = seq;
            const myVersionId = model.getVersionId();

            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                runValidation(mySeq, myVersionId);
            }, 200);
        };

        const disposable = editor.onDidChangeModelContent(() => {
            // optionnel mais utile : garder l'objet files en phase avec l'éditeur
            if (filesObj[entryPath] && typeof filesObj[entryPath] === "object") {
                filesObj[entryPath].content = model.getValue();
            }
            scheduleValidation();
        });

        // première émission (état initial)
        scheduleValidation();

        editor.onDidDispose(() => {
            if (timer) clearTimeout(timer);
            disposable.dispose();
        });
    }

    host._monacoEditor = editor;
    return { editor, monaco };
}

export { monacoPromise };
