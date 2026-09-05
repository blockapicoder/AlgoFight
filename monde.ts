import { Energie } from "./algofight-entity-model"
import { GestionMonde } from "./gestion-algofight-entity-model"
import { RobotTypescriptFile } from "./robot-explorateur"
import { runWorker } from "./worker-management"
import { createClient, TauriKargoClient } from "./node_modules/tauri-kargo-tools/src/api"
import { defineVue } from "./node_modules/tauri-kargo-tools/src/vue"

export interface MondeContexte {
    workerA: Worker
    workerB: Worker
    animationFrameId?: number
}

let mondeContexte: MondeContexte | undefined

const USINE_RAYON = 15
const RESSOURCE_RAYON = 5

export class Monde {
    canvas!: HTMLCanvasElement
    ctx!: CanvasRenderingContext2D
    robot1!: RobotTypescriptFile
    robot2!: RobotTypescriptFile

    sortie = ""
    client: TauriKargoClient
    gestionMonde!: GestionMonde

    constructor() {
        this.client = createClient()
    }

    fitCanvasToParent() {
        const dpr = window.devicePixelRatio || 1
        const w = Math.max(1, this.canvas.clientWidth)
        const h = Math.max(1, this.canvas.clientHeight)
        const pw = Math.round(w * dpr)
        const ph = Math.round(h * dpr)

        if (this.canvas.width !== pw) this.canvas.width = pw
        if (this.canvas.height !== ph) this.canvas.height = ph

        // Une unité du monde correspond à un pixel CSS.
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    createCanvas() {
        this.canvas = document.createElement("canvas")
        this.canvas.style.minHeight = "0"
        return this.canvas
    }

    afficher() {
        this.fitCanvasToParent()
        const w = this.canvas.clientWidth
        const h = this.canvas.clientHeight

        this.ctx.save()
        this.ctx.clearRect(0, 0, w, h)
        this.ctx.lineWidth = 2

        this.ctx.strokeStyle = "green"
        this.ctx.beginPath()
        this.ctx.rect(0, 0, w, h)
        this.ctx.stroke()

        for (const state of this.gestionMonde.usineStates) {
            const usine = state.ref
            this.ctx.beginPath()

            if (usine.etat?.joueur === this.gestionMonde.joueurA) {
                this.ctx.strokeStyle = "blue"
            } else if (usine.etat?.joueur === this.gestionMonde.joueurB) {
                this.ctx.strokeStyle = "red"
            } else {
                this.ctx.strokeStyle = "green"
            }

            this.ctx.arc(
                usine.position.x,
                usine.position.y,
                USINE_RAYON,
                0,
                2 * Math.PI
            )
            this.ctx.fillStyle = "green"
            this.ctx.fillText("U", usine.position.x - 4, usine.position.y + 4)
            this.ctx.stroke()
        }

        for (const state of this.gestionMonde.ressourceStates) {
            const ressource = state.ref
            if (ressource.proprietaire) {
                continue
            }

            this.ctx.beginPath()
            this.ctx.strokeStyle = ressource instanceof Energie ? "orange" : "white"
            this.ctx.arc(
                ressource.position.x,
                ressource.position.y,
                RESSOURCE_RAYON,
                0,
                2 * Math.PI
            )
            this.ctx.stroke()
        }

        this.ctx.restore()
    }

    initCanvas() {
        this.ctx = this.canvas.getContext("2d")!
    }

    private stopCurrentWorld() {
        if (!mondeContexte) {
            return
        }

        if (mondeContexte.animationFrameId !== undefined) {
            cancelAnimationFrame(mondeContexte.animationFrameId)
        }
        mondeContexte.workerA.terminate()
        mondeContexte.workerB.terminate()
        mondeContexte = undefined
    }

    private startWorld(contexte: MondeContexte) {
        const frame = () => {
            if (mondeContexte !== contexte) {
                return
            }

            this.gestionMonde.step()
            this.afficher()
            contexte.animationFrameId = requestAnimationFrame(frame)
        }

        frame()
    }

    async init(_div: HTMLDivElement) {
        this.stopCurrentWorld()
        this.fitCanvasToParent()

        const w = this.canvas.clientWidth
        const h = this.canvas.clientHeight
        this.gestionMonde = new GestionMonde()
        this.gestionMonde.createWorld(w, h)

        const typescriptSourceRobot1 = await this.robot1.getSource()
        const typescriptSourceRobot2 = await this.robot2.getSource()
        const javascriptSourceRobot1 = await this.client.typescriptTranspile(typescriptSourceRobot1)
        const javascriptSourceRobot2 = await this.client.typescriptTranspile(typescriptSourceRobot2)

        if (javascriptSourceRobot1.ok && javascriptSourceRobot2.ok) {
            const contexte: MondeContexte = {
                workerA: runWorker(javascriptSourceRobot1.src),
                workerB: runWorker(javascriptSourceRobot2.src)
            }
            mondeContexte = contexte

         //   this.gestionMonde.setWorkers(contexte.workerA, contexte.workerB)
            this.startWorld(contexte)
            return
        }

        this.afficher()
    }
}

defineVue(Monde, (vue) => {
    vue.flow({
        orientation: "column",
        width: "100vw",
        gap: 5,
        height: "90vh"
    }, () => {
        vue.custom({ factory: "createCanvas", init: "initCanvas" })
    })
}, { init: "init" })
