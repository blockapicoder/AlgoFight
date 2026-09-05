import { boot, defineVue } from "./node_modules/tauri-kargo-tools/src/vue"

import { createClient, TauriKargoClient } from "./node_modules/tauri-kargo-tools/src/api"
import { initMonacoFromFilesObject } from "./monaco"
import { buildLightContext } from "./context"
import { Robot } from "./model"
import { Explorateur } from "./explorateur"
import { Monde } from "./monde"
import { AstNode } from "./node_modules/tauri-kargo-tools/src/types"
const ORIGIN = new URL(import.meta.url).origin;      // https://example.com
const BASE = new URL(".", import.meta.url).href;
function findAstNode(astNode: AstNode, path: string[], idx: number = 0): AstNode[] {
    const r: AstNode[] = []
    if (idx === path.length) {
        return [astNode]
    }
    for (const node of astNode.children) {
        if (node.kind === path[idx]) {
            r.push(...findAstNode(node, path, idx + 1))
        }
    }
    return r


}
export function replaceRange(text: string, start: number, end: number, s: string): string {
    // Normalisation + garde-fous
    const n = text.length;
    const a = Math.max(0, Math.min(n, start));
    const b = Math.max(0, Math.min(n, end));
    const from = Math.min(a, b);
    const to = Math.max(a, b);

    return text.slice(0, from) + s + text.slice(to);
}


export class RobotTypescriptFile implements Robot {
    selected = false
    nom: string = ""
    repertoire: string = ""
    explorateur!: RobotExplorateur

    ouvrirMonacoEditor(): MonacoEditor {
        const r: MonacoEditor = new MonacoEditor();
        r.nom = this.nom
        r.repertoire = this.repertoire
        r.explorateur = this.explorateur



        return r;
    }
    updateSelected() {
        this.explorateur.initPeutCombattre()
    }
    async getSource() {
        await this.explorateur.tauriKargoClient.setCurrentDirectory({ path: this.repertoire })
        const rep = await this.explorateur.tauriKargoClient.explorer({})
        let source = await this.explorateur.tauriKargoClient.readFileText("robot.ts")
        if (rep.type === "directory") {
            const c = rep.path + "\\" + this.nom + "\\robot.ts"
            const ast = await this.explorateur.tauriKargoClient.typescriptAst({ path: c })
            if (ast.ok) {
                const nodes = findAstNode(ast.ast, ["ImportDecl", "Str"])
                let deltat = 0
                for (const node of nodes) {
                    const p = (source).substring(node.start + deltat, node.end + deltat)
                    const ls = ["'", '"']
                    for (const sep of ls) {
                        if (p.startsWith(`${sep}./`)) {
                            const np = `${sep}${BASE}${p.substring(3)}`
                            source = replaceRange(source, node.start + deltat, node.end + deltat, np)
                            deltat = deltat + (np.length - p.length)
                        }
                    }


                }


            }
        }
        // console.log(source)
        return source

    }
}
defineVue(RobotTypescriptFile, {
    kind: "flow",
    orientation: "row",
    gap: 10,
    children: [
        { kind: "input", name: "selected", inputType: "checkbox", update: "updateSelected" },
        { kind: "label", name: "nom", width: "10%" },
        { kind: "label", name: "repertoire", width: '80%' },

        { kind: "staticBootVue", label: "Editer", factory: "ouvrirMonacoEditor", width: '10%' }
    ]
})
interface ExplorateurTypescriptContext {
    contexte: TypescriptContext
    path: string
}
export class RobotExplorateur {
    robots: RobotTypescriptFile[] = []
    tauriKargoClient!: TauriKargoClient
    peutCombattre = false


    constructor() {
        this.tauriKargoClient = createClient();


    }
    initPeutCombattre() {
        this.peutCombattre = this.robots.filter((r) => r.selected).length === 2
    }
    async init(div: HTMLDivElement) {
        await this.tauriKargoClient.setCurrentDirectory({ path: "." })
        try {
            const src = await this.tauriKargoClient.readFileText("robots.json")
            const robots: Robot[] = JSON.parse(src)
            this.robots = robots.map((r) => {
                const tmp = new RobotTypescriptFile()
                tmp.nom = r.nom
                tmp.repertoire = r.repertoire
                tmp.explorateur = this
                return tmp

            })
        } catch (e) {

        }
    }

    async createContexte(repertoire: string, contexte: TypescriptContext) {
        const content = await this.tauriKargoClient.explorer({
            type: "array",
            path: repertoire
        })
        if (content.type === "directory") {
            for (let e of content.content) {
                if ((e.name.endsWith(".ts") || e.name.endsWith(".js"))) {

                    const tmp = e.path.substring(content.path.length + 1)
                    contexte[tmp] = { path: tmp }



                }


            }

        }
        return contexte
    }
    creerMonde() {
        const r = new Monde()
        r.robot1 = this.robots[0]
        r.robot2 = this.robots[1]
        return r;
    }

    ajouterRobot(): Explorateur {
        const r = new Explorateur()
        r.robotExplorateur = this
        return r

    }
}
defineVue(RobotExplorateur, (vue) => {

    vue.flow({ orientation: "column", gap: 10 }, () => {
        vue.flow({ orientation: "row", gap: 10 }, () => {
            vue.staticBootVue({ factory: "creerMonde", label: "Combattre", width: "50%" })
            vue.staticBootVue({ factory: "ajouterRobot", label: "Ajouter robot", width: "50%" })
        })
        vue.listOfVue({
            list: "robots",
            gap: 10,
            orientation: "column",
            width: '100%',
            wrap: false,
            style: {
                overflow: "auto"
            }
        })


    })

}, { init: "init" })
export interface Content {
    path: string, content?: string

}
export type MonacoChangeType = "syntaxError" | "semanticError" | "value";

export type MonacoOnChange = (type: MonacoChangeType, payload: string) => void;

export type TypescriptContext = { [path: string]: Content }
class MonacoEditor {
    div!: HTMLDivElement
    source: string = ""
    nom!: string
    repertoire!: string
    explorateur!: RobotExplorateur
    titre = "Explorateur"
    constructor() {
        this.source = "function test() {\n  console.log('Hello Monaco');\n}\n"
    }


    factory(): HTMLDivElement {
        this.div = document.createElement("div")

        return this.div
    }
    async init() {



        //const tauriKargoToolsFiles = await this.explorateur.tauriKargoClient.explorer({ type:"array" , path:`${config.code}/node_modules/tauri-kargo-tools`})
        await this.explorateur.tauriKargoClient.setCurrentDirectory({ path: this.repertoire })
        this.source = await this.explorateur.tauriKargoClient.readFileText("robot.ts")
        const ctx = await buildLightContext({
            "robot.ts": {
                path: "./robot.ts",
                content: this.source
            }
        }, "robot.ts")
        const config = await this.explorateur.tauriKargoClient.getConfig()
        await this.explorateur.tauriKargoClient.setCurrentDirectory({ path: config.code })
        const files: string[] = [
            "algofight-entity-model.ts",       
            "entity-model.ts"]
        for (const file of files) {
            const sourceBase = await this.explorateur.tauriKargoClient.readFileText(file)
            ctx[file] = { path: `/${file}`, content: sourceBase }
        }
        await this.explorateur.tauriKargoClient.setCurrentDirectory({ path: this.repertoire })


        const editor = await initMonacoFromFilesObject(this.div, {
            files: ctx,
            entry: "robot.ts",
            language: "typescript",
            onChange: async (type: MonacoChangeType, payload: string) => {
                if (type === "value") {

                    await this.explorateur.tauriKargoClient.writeFileText("robot.ts", payload)
                }
            }
        });


    }
    ouvrirExplorateur(): RobotExplorateur {
        return this.explorateur
    }

}
defineVue(MonacoEditor, {
    kind: "flow",
    orientation: "column",
    height: "100vh",
    gap: 10,
    children: [
        { kind: "bootVue", factory: "ouvrirExplorateur", label: "titre", height: "5%" },
        {
            kind: "custom",
            factory: "factory",
            id: "my-monaco-editor",
            init: "init",
            height: "80%",

        }]
})
