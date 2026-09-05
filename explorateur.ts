import { boot, defineVue } from "./node_modules/tauri-kargo-tools/src/vue"

import { createClient, TauriKargoClient } from "./node_modules/tauri-kargo-tools/src/api"
import { initMonacoFromFilesObject } from "./monaco"
import { buildLightContext } from "./context"
import { codeTemplate, Robot } from "./model"
import { RobotExplorateur } from "./robot-explorateur"
class Noeud {
    nom!: string
    path!: string
    explorateur!: Explorateur
    constructor() {

    }
}
class Reperoire extends Noeud {
    explorer() {
        this.explorateur.explorer(this.path)
    }
}


defineVue(Reperoire, {
    kind: "flow",
    orientation: "row",
    gap: 10,
    children: [
        { kind: "label", name: "path", width: '90%' },
        { kind: "staticButton", label: "Explorer", action: "explorer", width: '10%' }
    ]
})



class DialogCreerProjet {
    nom: string = ""
    nomRepertoire: string = ""
    erreur: string = "Saisir nom et nom répertoire"

    explorateur!: Explorateur
    peutCreer = false


    verifier() {
        this.erreur = ""
        if (this.nom.trim() === "") {
            this.erreur = "Nom vide"
            this.peutCreer = false
            return;
        }
        if (this.nomRepertoire.trim() === "") {
            this.erreur = "Nom réperoire vide"
            this.peutCreer = false
            return;
        }
        const cond1 = this.explorateur.noeuds.every((n) => n.nom.toLocaleLowerCase() != this.nomRepertoire.trim().toLocaleLowerCase())
        const cond2 = this.explorateur.robots.every((n) => n.nom.toLocaleLowerCase() != this.nom.trim().toLocaleLowerCase())
        if (!cond1) {
            this.erreur = "Répertoire existant"
        }
        if (!cond2) {
            this.erreur = "Nom existant"
        }
        this.peutCreer = cond1 && cond2

    }


    async creer() {
        const racine = this.explorateur.racine
        const client = this.explorateur.tauriKargoClient
        await client.setCurrentDirectory({ path: this.explorateur.racine })

        await client.createDirectory(this.nomRepertoire);
        const robot: Robot = { nom: this.nom, repertoire: `${racine}/${this.nomRepertoire}` }
        try {

            await client.setCurrentDirectory({ path: this.nomRepertoire })

            await client.writeFileText("robot.ts", await codeTemplate())
            await client.setCurrentDirectory({ path: "." })
            this.explorateur.robots.push(robot)
            await client.writeFileText("robots.json", JSON.stringify(this.explorateur.robots))
            await client.setCurrentDirectory({ path: this.explorateur.racine })
            await this.explorateur.explorer(racine)
            this.explorateur.dialogCreerProjet = undefined
        } catch (e: any) {
            this.erreur = e.message

        }
    }
    annuler() {
        this.explorateur.dialogCreerProjet = undefined

    }
}
defineVue(DialogCreerProjet, (vue) => {
    vue.flow({ orientation: 'column', gap: 10 }, () => {
        vue.staticLabel("Nom")
        vue.input({ name: "nom", update: "verifier" })
        vue.staticLabel("Nom repertoire")
        vue.input({ name: "nomRepertoire", update: "verifier" })
        vue.label("erreur", { enable: "peutCreer" })
        vue.flow({
            orientation: "row",
            gap: 10
        }, () => {
            vue.staticButton({ action: "creer", label: "Creer", width: '50%', enable: "peutCreer" })
            vue.staticButton({ action: "annuler", label: "Annuler", width: '50%' })
        })

    })

})
export class Explorateur {
    racine: string = "."
    parents: string[] = []
    noeuds: Noeud[] = []
    tauriKargoClient!: TauriKargoClient
    peutRemonter: boolean = false
    robotExplorateur!:RobotExplorateur

    dialogCreerProjet?: DialogCreerProjet
    robots: Robot[] = []

    constructor() {
        this.tauriKargoClient = createClient();
        this.explorerRacine()


    }
    explorerRacine() {
        this.explorer(this.racine)
    }

    async explorer(chemin: string) {
        const path = chemin == "." ? undefined : chemin

        const r = await this.tauriKargoClient.explorer({ path: path })
        const noeuds: Noeud[] = []
        this.racine = chemin


        if (r.type === "directory") {
            if (r.parent) {
                this.parents.push(r.parent)
                this.peutRemonter = true
            }

            for (const e of r.content) {
                if (e.type === "directory") {
                    const rep: Reperoire = new Reperoire()
                    rep.path = e.path
                    rep.nom = e.name


                    rep.explorateur = this
                    noeuds.push(rep)
                }


            }


        }
        this.noeuds = noeuds





    }
    creerProjet() {
        this.dialogCreerProjet = new DialogCreerProjet()
        this.dialogCreerProjet.explorateur = this;
        return this.dialogCreerProjet

    }
    async init(div: HTMLDivElement) {

        await this.tauriKargoClient.setCurrentDirectory({ path: "." })
        try {
            const src = await this.tauriKargoClient.readFileText("robots.json")
            this.robots = JSON.parse(src)
        } catch (e) {

        }


    }
    remonter() {
        const e = this.parents.pop()
        if (e) {
  
            this.explorer(e)
        }
        this.peutRemonter = this.parents.length > 0





    }
    explorerRobot() {
        return this.robotExplorateur
    }
}
defineVue(Explorateur, (vue) => {

    vue.flow({

        orientation: "column",
        gap: 10,
        height: '100vh',
    }, () => {
        vue.flow({
            orientation: "row",
            gap: 10,
        }, () => {
            vue.input({ name: "racine", update: "explorerRacine", width: "25%" })
            vue.staticButton({ label: "Remonter", enable: "peutRemonter", action: "remonter", width: "25%" })
            vue.dialog({ name: "dialogCreerProjet", action: "creerProjet", label: "Creer projet", buttonWidth: "25%" })
            vue.staticBootVue({ factory:"explorerRobot" , label:"Explorer robots",width:"25%"})
        })
        vue.listOfVue({
            list: "noeuds",
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