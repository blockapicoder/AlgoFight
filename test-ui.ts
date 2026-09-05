import {
    Config,
    DEFAULT_CONFIG,
    Drone,
    Energie,
    Element as GameElement,
    Joueur,
    Technologie,
    Usine,
    Vie
} from "./algofight-entity-model"
import { listBotsScript } from "./bots-script-tools"
import { entityToJsonData, JsonData } from "./entity-model"
import { GestionMonde } from "./gestion-algofight-entity-model"


console.log(JSON.stringify(await listBotsScript()))


type JoueurSelectionne = "A" | "B"
type AnimationType = "creation" | "destruction" | "capture"

export interface ActionEnregistree {
    tick: number
    joueur: JoueurSelectionne
    mobileRef: string
    targetRef: string
    mobileKey?: string
    targetKey?: string
}

export interface EnregistrementAlgoFight {
    version: 1
    largeur: number
    hauteur: number
    config: Config
    sauvegarde: JsonData
    actions: ActionEnregistree[]
    dureeTicks: number
}

interface AnimationJeu {
    type: AnimationType
    x: number
    y: number
    couleur: string
    libelle: string
    debut: number
    duree: number
}

interface EntiteSnapshot {
    x: number
    y: number
    joueur?: string
}

interface MondeSnapshot {
    drones: Map<string, EntiteSnapshot>
    usines: Map<string, EntiteSnapshot>
}

interface EvenementJeu {
    tick: number
    type: "action" | "creation" | "destruction" | "capture" | "systeme" | "erreur"
    texte: string
}

interface VueCanvas {
    scale: number
    offsetX: number
    offsetY: number
    largeur: number
    hauteur: number
}

const TECHNOLOGIES: readonly Technologie[] = [
    "Population",
    "Vitesse",
    "Porte",
    "Transport",
    "Puissance"
]

const COULEUR_A = "#41c9ff"
const COULEUR_B = "#ff557a"
const COULEUR_NEUTRE = "#7f8ca8"

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
}

function echapper(value: unknown) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;")
}

function idCourt(id: string) {
    return id.slice(0, 8)
}

export class TestUi {
    root!: HTMLDivElement
    canvas!: HTMLCanvasElement
    ctx!: CanvasRenderingContext2D
    gestionMonde!: GestionMonde

    largeurMonde = 1200
    hauteurMonde = 720
    tick = 0
    joueurSelectionne: JoueurSelectionne = "A"
    mobileRef = ""
    targetRef = ""
    hoverRef = ""
    actions: ActionEnregistree[] = []
    evenements: EvenementJeu[] = []
    animations: AnimationJeu[] = []
    sauvegardeInitiale?: JsonData
    configEnregistree: Config = { ...DEFAULT_CONFIG }
    dureeEnregistree = 0

    private playing = true
    private replayMode = false
    private replayActions: ActionEnregistree[] = []
    private replayIndex = 0
    private replayEndTick = 0
    private requestId?: number
    private lastFrame = 0
    private accumulator = 0
    private lastUiRefresh = 0
    private pointerMonde?: { x: number; y: number }
    private logicalKeyById = new Map<string, string>()
    private idByLogicalKey = new Map<string, string>()
    private droneCountByFactory = new Map<string, number>()
    private vueCanvas: VueCanvas = {
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        largeur: 1,
        hauteur: 1
    }

    private widthInput!: HTMLInputElement
    private heightInput!: HTMLInputElement
    private speedInput!: HTMLInputElement
    private speedValue!: HTMLElement
    private playerAButton!: HTMLButtonElement
    private playerBButton!: HTMLButtonElement
    private playButton!: HTMLButtonElement
    private statusElement!: HTMLElement
    private summaryElement!: HTMLElement
    private statsElement!: HTMLElement
    private inspectorElement!: HTMLElement
    private timelineElement!: HTMLElement
    private fileInput!: HTMLInputElement

    createInterface() {
        this.root = document.createElement("div")
        this.root.className = "algofight-lab"
        this.root.innerHTML = `
            <style>
                .algofight-lab {
                    --bg: #070b16;
                    --panel: rgba(18, 26, 48, .92);
                    --panel-2: rgba(12, 18, 34, .95);
                    --line: rgba(132, 155, 205, .22);
                    --text: #ecf2ff;
                    --muted: #91a0c0;
                    --a: ${COULEUR_A};
                    --b: ${COULEUR_B};
                    box-sizing: border-box;
                    min-height: 100vh;
                    width: 100%;
                    padding: 14px;
                    color: var(--text);
                    background:
                        radial-gradient(circle at 18% 0%, rgba(54, 109, 255, .16), transparent 31%),
                        radial-gradient(circle at 88% 5%, rgba(255, 61, 126, .12), transparent 27%),
                        var(--bg);
                    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
                    font-size: 15px;
                }
                .algofight-lab * { box-sizing: border-box; }
                .af-header, .af-toolbar, .af-panel, .af-arena-card, .af-timeline {
                    border: 1px solid var(--line);
                    background: var(--panel);
                    box-shadow: 0 12px 32px rgba(0, 0, 0, .24);
                }
                .af-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 18px;
                    padding: 15px 18px;
                    border-radius: 14px 14px 0 0;
                }
                .af-title { font-size: 23px; font-weight: 800; letter-spacing: .04em; }
                .af-subtitle { margin-top: 3px; color: var(--muted); font-size: 14px; }
                .af-summary { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
                .af-chip {
                    padding: 6px 9px;
                    border: 1px solid var(--line);
                    border-radius: 999px;
                    background: rgba(5, 9, 19, .55);
                    color: var(--muted);
                    font-size: 13px;
                }
                .af-chip strong { color: var(--text); }
                .af-toolbar {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 8px;
                    padding: 10px 12px;
                    border-top: 0;
                    border-radius: 0 0 14px 14px;
                    margin-bottom: 12px;
                }
                .af-field { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
                .af-field input, .af-select {
                    min-width: 0;
                    border: 1px solid var(--line);
                    border-radius: 7px;
                    padding: 7px 8px;
                    color: var(--text);
                    background: #0a1020;
                    outline: none;
                }
                .af-field input[type=number] { width: 78px; }
                .af-field input[type=range] { width: 110px; padding: 0; accent-color: #7f8cff; }
                .af-button {
                    border: 1px solid var(--line);
                    border-radius: 8px;
                    padding: 7px 10px;
                    color: var(--text);
                    background: linear-gradient(180deg, #202d51, #151d36);
                    cursor: pointer;
                    font-weight: 700;
                    font-size: 13px;
                }
                .af-button:hover { border-color: #7185bc; transform: translateY(-1px); }
                .af-button.primary { background: linear-gradient(180deg, #596cff, #3447c9); }
                .af-grid {
                    display: grid;
                    grid-template-columns: minmax(220px, 270px) minmax(430px, 1fr) minmax(260px, 330px);
                    gap: 12px;
                    align-items: stretch;
                }
                .af-panel, .af-arena-card { border-radius: 13px; overflow: hidden; }
                .af-panel { padding: 13px; background: var(--panel-2); }
                .af-panel h2, .af-panel h3 {
                    margin: 0 0 10px;
                    font-size: 14px;
                    letter-spacing: .12em;
                    text-transform: uppercase;
                    color: #aebde0;
                }
                .af-section { padding-bottom: 13px; margin-bottom: 13px; border-bottom: 1px solid var(--line); }
                .af-section:last-child { border: 0; margin: 0; padding: 0; }
                .af-player-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
                .af-player.active-a { border-color: var(--a); box-shadow: inset 0 0 0 1px var(--a); }
                .af-player.active-b { border-color: var(--b); box-shadow: inset 0 0 0 1px var(--b); }
                .af-order-help {
                    display: grid;
                    gap: 8px;
                    color: var(--muted);
                    font-size: 14px;
                    line-height: 1.45;
                }
                .af-order-help strong { color: var(--text); }
                .af-order-step {
                    display: grid;
                    grid-template-columns: 27px 1fr;
                    gap: 8px;
                    align-items: start;
                }
                .af-order-step > b {
                    display: grid;
                    place-items: center;
                    width: 27px;
                    height: 27px;
                    border-radius: 50%;
                    color: #fff;
                    background: #4355d1;
                }
                .af-status {
                    min-height: 42px;
                    margin-top: 9px;
                    padding: 8px;
                    border-radius: 7px;
                    background: rgba(0, 0, 0, .22);
                    color: var(--muted);
                    font-size: 14px;
                    line-height: 1.4;
                }
                .af-arena-card { position: relative; min-height: 620px; background: #050914; }
                .af-canvas { display: block; width: 100%; height: 620px; cursor: crosshair; }
                .af-legend {
                    position: absolute;
                    left: 12px;
                    bottom: 10px;
                    display: flex;
                    gap: 10px;
                    flex-wrap: wrap;
                    padding: 7px 9px;
                    border-radius: 8px;
                    background: rgba(4, 8, 18, .78);
                    color: var(--muted);
                    font-size: 12px;
                    pointer-events: none;
                }
                .af-dot { display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 50%; }
                .af-hint {
                    position: absolute;
                    right: 12px;
                    top: 10px;
                    max-width: 310px;
                    padding: 7px 9px;
                    border-radius: 8px;
                    background: rgba(4, 8, 18, .78);
                    color: var(--muted);
                    font-size: 13px;
                    pointer-events: none;
                }
                .af-kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px; margin-bottom: 11px; }
                .af-kpi { padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: rgba(4, 8, 18, .45); }
                .af-kpi span { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; }
                .af-kpi strong { display: block; margin-top: 3px; font-size: 18px; }
                .af-player-card { margin-bottom: 9px; padding: 9px; border: 1px solid var(--line); border-radius: 9px; }
                .af-player-card.a { border-left: 3px solid var(--a); }
                .af-player-card.b { border-left: 3px solid var(--b); }
                .af-player-head { display: flex; justify-content: space-between; font-size: 14px; font-weight: 800; }
                .af-mini-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 7px; }
                .af-mini-grid div { padding: 5px; background: rgba(0, 0, 0, .2); border-radius: 5px; font-size: 11px; color: var(--muted); }
                .af-mini-grid strong { display: block; color: var(--text); font-size: 15px; }
                .af-tech { width: 100%; border-collapse: collapse; margin-top: 7px; font-size: 12px; }
                .af-tech td { padding: 3px 2px; border-top: 1px solid rgba(132, 155, 205, .12); }
                .af-tech td:last-child { text-align: right; font-weight: 800; }
                .af-inspector { color: var(--muted); font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
                .af-inspector strong { color: var(--text); }
                .af-timeline {
                    margin-top: 12px;
                    padding: 12px;
                    border-radius: 13px;
                }
                .af-timeline-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
                .af-timeline-head h2 { margin: 0; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; }
                .af-events { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 6px; max-height: 150px; overflow: auto; }
                .af-event { padding: 7px 8px; border-radius: 7px; background: rgba(4, 8, 18, .5); font-size: 12px; color: var(--muted); }
                .af-event strong { color: #dce6ff; }
                .af-event.creation { border-left: 2px solid #5cffba; }
                .af-event.destruction, .af-event.erreur { border-left: 2px solid #ff5b67; }
                .af-event.capture { border-left: 2px solid #ffd166; }
                .af-event.action { border-left: 2px solid #7f8cff; }
                @media (max-width: 1100px) {
                    .af-grid { grid-template-columns: 240px 1fr; }
                    .af-grid > aside:last-child { grid-column: 1 / -1; }
                }
                @media (max-width: 760px) {
                    .algofight-lab { padding: 7px; }
                    .af-grid { grid-template-columns: 1fr; }
                    .af-canvas, .af-arena-card { height: 500px; min-height: 500px; }
                    .af-header { align-items: flex-start; flex-direction: column; }
                }
            </style>

            <header class="af-header">
                <div>
                    <div class="af-title">ALGOFIGHT · LABORATOIRE DE SIMULATION</div>
                    <div class="af-subtitle">Pilotage manuel, télémétrie complète et relecture déterministe</div>
                </div>
                <div class="af-summary" data-role="summary"></div>
            </header>

            <div class="af-toolbar">
                <label class="af-field">Largeur <input data-role="width" type="number" min="300" max="4000" step="50" value="1200"></label>
                <label class="af-field">Hauteur <input data-role="height" type="number" min="300" max="3000" step="50" value="720"></label>
                <button class="af-button primary" data-role="new-world">Nouveau monde</button>
                <button class="af-button" data-role="play">Pause</button>
                <button class="af-button" data-role="single-step">+1 step</button>
                <label class="af-field">Vitesse <input data-role="speed" type="range" min="1" max="240" value="30"><strong data-role="speed-value">30/s</strong></label>
                <button class="af-button" data-role="replay">Rejouer</button>
                <button class="af-button" data-role="export">Exporter</button>
                <button class="af-button" data-role="import">Importer</button>
                <input data-role="file" type="file" accept="application/json,.json" hidden>
            </div>

            <main class="af-grid">
                <aside class="af-panel">
                    <section class="af-section">
                        <h2>Joueur actif</h2>
                        <div class="af-player-tabs">
                            <button class="af-button af-player" data-role="player-a">Joueur A</button>
                            <button class="af-button af-player" data-role="player-b">Joueur B</button>
                        </div>
                    </section>
                    <section class="af-section">
                        <h2>Commande en 2 clics</h2>
                        <div class="af-order-help">
                            <div class="af-order-step"><b>1</b><span>Cliquez un <strong>drone disponible</strong>, ou une usine alliée avec un <strong>newDrone prêt</strong>.</span></div>
                            <div class="af-order-step"><b>2</b><span>Suivez la flèche puis cliquez la cible : l’ordre part immédiatement.</span></div>
                        </div>
                        <div class="af-status" data-role="status">Initialisation…</div>
                    </section>
                    <section class="af-section">
                        <h3>Inspecteur</h3>
                        <div class="af-inspector" data-role="inspector"></div>
                    </section>
                </aside>

                <section class="af-arena-card">
                    <canvas class="af-canvas" data-role="canvas"></canvas>
                    <div class="af-hint">1er clic : drone disponible ou usine avec newDrone · 2e clic : cible et départ immédiat · ⛔ = drone occupé</div>
                    <div class="af-legend">
                        <span><i class="af-dot" style="background:${COULEUR_A}"></i>Joueur A</span>
                        <span><i class="af-dot" style="background:${COULEUR_B}"></i>Joueur B</span>
                        <span><i class="af-dot" style="background:#ffa62b"></i>Énergie</span>
                        <span><i class="af-dot" style="background:#63e6be"></i>Vie</span>
                        <span><i class="af-dot" style="background:${COULEUR_NEUTRE}"></i>Neutre</span>
                    </div>
                </section>

                <aside class="af-panel">
                    <h2>Télémétrie</h2>
                    <div data-role="stats"></div>
                </aside>
            </main>

            <section class="af-timeline">
                <div class="af-timeline-head">
                    <h2>Chronologie des actions et événements</h2>
                    <span class="af-chip">La sauvegarde initiale + les ordres horodatés suffisent au replay</span>
                </div>
                <div class="af-events" data-role="timeline"></div>
            </section>
        `
        return this.root
    }

    initInterface() {
        this.canvas = this.role<HTMLCanvasElement>("canvas")
        this.ctx = this.canvas.getContext("2d")!
        this.widthInput = this.role<HTMLInputElement>("width")
        this.heightInput = this.role<HTMLInputElement>("height")
        this.speedInput = this.role<HTMLInputElement>("speed")
        this.speedValue = this.role<HTMLElement>("speed-value")
        this.playerAButton = this.role<HTMLButtonElement>("player-a")
        this.playerBButton = this.role<HTMLButtonElement>("player-b")
        this.playButton = this.role<HTMLButtonElement>("play")
        this.statusElement = this.role<HTMLElement>("status")
        this.summaryElement = this.role<HTMLElement>("summary")
        this.statsElement = this.role<HTMLElement>("stats")
        this.inspectorElement = this.role<HTMLElement>("inspector")
        this.timelineElement = this.role<HTMLElement>("timeline")
        this.fileInput = this.role<HTMLInputElement>("file")

        this.role<HTMLButtonElement>("new-world").addEventListener("click", () => this.nouveauMonde())
        this.playButton.addEventListener("click", () => this.toggleLecture())
        this.role<HTMLButtonElement>("single-step").addEventListener("click", () => this.stepManuel())
        this.role<HTMLButtonElement>("replay").addEventListener("click", () => this.rejouer())
        this.role<HTMLButtonElement>("export").addEventListener("click", () => this.exporter())
        this.role<HTMLButtonElement>("import").addEventListener("click", () => this.fileInput.click())
        this.fileInput.addEventListener("change", () => void this.importer())
        this.playerAButton.addEventListener("click", () => this.selectionnerJoueur("A"))
        this.playerBButton.addEventListener("click", () => this.selectionnerJoueur("B"))
        this.speedInput.addEventListener("input", () => {
            this.speedValue.textContent = this.stepsParSeconde() + "/s"
        })
        this.canvas.addEventListener("click", event => this.selectionCanvas(event))
        this.canvas.addEventListener("pointermove", event => this.survolCanvas(event))
        this.canvas.addEventListener("pointerleave", () => {
            this.hoverRef = ""
            this.pointerMonde = undefined
            this.refreshUi(true)
        })

        this.nouveauMonde()
        this.lastFrame = performance.now()
        this.requestId = requestAnimationFrame(time => this.boucle(time))
    }

    private role<T>(name: string) {
        const element = this.root.querySelector(`[data-role="${name}"]`)
        if (!element) throw new Error(`Élément UI '${name}' introuvable`)
        return element as T
    }

    private nouveauMonde() {
        try {
            this.largeurMonde = Math.max(300, Number(this.widthInput.value) || 1200)
            this.hauteurMonde = Math.max(300, Number(this.heightInput.value) || 720)
            this.widthInput.value = String(this.largeurMonde)
            this.heightInput.value = String(this.hauteurMonde)

            this.gestionMonde = new GestionMonde([], DEFAULT_CONFIG)
            this.gestionMonde.createWorld(this.largeurMonde, this.hauteurMonde)
            this.configEnregistree = { ...this.gestionMonde.config }
            this.sauvegardeInitiale = cloneJson(entityToJsonData(this.gestionMonde.save()))
            this.initialiserReferencesLogiques()
            this.actions = []
            this.evenements = []
            this.animations = []
            this.tick = 0
            this.dureeEnregistree = 0
            this.replayMode = false
            this.replayActions = []
            this.replayIndex = 0
            this.mobileRef = ""
            this.targetRef = ""
            this.hoverRef = ""
            this.playing = true
            this.accumulator = 0
            this.ajouterEvenement("systeme", `Monde ${this.largeurMonde} × ${this.hauteurMonde} créé et sauvegardé`)
            this.setStatus("Sauvegarde initiale créée. La simulation est en cours.")
            this.refreshUi(true)
        } catch (error) {
            this.playing = false
            this.setStatus(error instanceof Error ? error.message : String(error), true)
        }
    }

    private boucle(time: number) {
        const elapsed = Math.min(250, time - this.lastFrame)
        this.lastFrame = time

        if (this.playing && this.gestionMonde) {
            this.accumulator += elapsed * this.stepsParSeconde() / 1000
            let steps = 0
            while (this.accumulator >= 1 && steps < 50 && this.playing) {
                this.executerStep()
                this.accumulator--
                steps++
            }
        }

        this.dessiner(time)
        if (time - this.lastUiRefresh > 120) {
            this.refreshUi(false)
            this.lastUiRefresh = time
        }
        this.requestId = requestAnimationFrame(next => this.boucle(next))
    }

    private executerStep() {
        if (this.replayMode) {
            while (
                this.replayIndex < this.replayActions.length &&
                this.replayActions[this.replayIndex].tick === this.tick
            ) {
                const action = this.replayActions[this.replayIndex++]
                const joueur = action.joueur === "A"
                    ? this.gestionMonde.joueurA
                    : this.gestionMonde.joueurB
                const mobileRef = this.resoudreReference(action.mobileKey, action.mobileRef)
                const targetRef = this.resoudreReference(action.targetKey, action.targetRef)
                const accepted = this.gestionMonde.initDroneState(
                    joueur,
                    mobileRef,
                    targetRef
                )
                this.ajouterEvenement(
                    accepted ? "action" : "erreur",
                    `Replay ${action.joueur} · ${idCourt(action.mobileRef)} → ${idCourt(action.targetRef)}${accepted ? "" : " (refusé)"}`
                )
            }
        }

        const before = this.snapshot()
        this.gestionMonde.step()
        this.tick++
        this.detecterEvenements(before, this.snapshot())

        if (!this.replayMode) {
            this.dureeEnregistree = Math.max(this.dureeEnregistree, this.tick)
        } else if (this.tick >= this.replayEndTick) {
            this.playing = false
            this.replayMode = false
            this.ajouterEvenement("systeme", `Replay terminé au tick ${this.tick}`)
            this.setStatus(`Replay terminé : ${this.replayActions.length} action(s) reproduite(s).`)
        }
    }

    private stepManuel() {
        if (!this.gestionMonde) return
        this.playing = false
        this.executerStep()
        this.refreshUi(true)
    }

    private toggleLecture() {
        this.playing = !this.playing
        this.accumulator = 0
        this.setStatus(this.playing ? "Simulation en cours." : "Simulation en pause.")
        this.refreshUi(true)
    }

    private selectionnerJoueur(joueur: JoueurSelectionne) {
        this.joueurSelectionne = joueur
        this.mobileRef = ""
        this.targetRef = ""
        this.setStatus(`Joueur ${joueur} sélectionné.`)
        this.refreshUi(true)
    }

    private executerOrdre() {
        if (this.replayMode) {
            this.setStatus("Les commandes manuelles sont désactivées pendant le replay.", true)
            return
        }
        if (!this.mobileRef || !this.targetRef) {
            this.setStatus("Sélectionnez un drone et une cible.", true)
            return
        }

        const mobileRef = this.mobileRef
        const targetRef = this.targetRef
        const joueur = this.joueurActif()
        const accepted = this.gestionMonde.initDroneState(
            joueur,
            mobileRef,
            targetRef
        )

        if (!accepted) {
            this.ajouterEvenement(
                "erreur",
                `Ordre refusé pour ${this.joueurSelectionne} · ${idCourt(mobileRef)} → ${idCourt(targetRef)}`
            )
            this.targetRef = ""
            this.setStatus("Ordre refusé : drone indisponible, cible invalide ou cooldown actif.", true)
            this.refreshUi(true)
            return
        }

        const action: ActionEnregistree = {
            tick: this.tick,
            joueur: this.joueurSelectionne,
            mobileRef,
            targetRef,
            mobileKey: this.logicalKeyById.get(mobileRef),
            targetKey: this.logicalKeyById.get(targetRef)
        }
        this.actions.push(action)
        this.dureeEnregistree = Math.max(this.dureeEnregistree, this.tick + 1)
        this.ajouterEvenement(
            "action",
            `Joueur ${action.joueur} · ${this.libelleEntite(this.entite(action.mobileRef))} → ${this.libelleEntite(this.entite(action.targetRef))}`
        )
        this.mobileRef = ""
        this.targetRef = ""
        this.setStatus(`Ordre accepté et enregistré au tick ${this.tick}.`)
        this.refreshUi(true)
    }

    private rejouer() {
        if (!this.sauvegardeInitiale) {
            this.setStatus("Aucune sauvegarde initiale disponible.", true)
            return
        }

        const actions = this.actions.map(action => ({ ...action }))
        const duree = Math.max(
            this.dureeEnregistree,
            actions.length ? Math.max(...actions.map(action => action.tick + 1)) : 0
        )

        this.gestionMonde = new GestionMonde([], this.configEnregistree)
        this.gestionMonde.load(cloneJson(this.sauvegardeInitiale))
        this.initialiserReferencesLogiques()
        this.tick = 0
        this.replayActions = actions.sort((a, b) => a.tick - b.tick)
        this.replayIndex = 0
        this.replayEndTick = duree
        this.replayMode = true
        this.playing = duree > 0
        this.animations = []
        this.evenements = []
        this.mobileRef = ""
        this.targetRef = ""
        this.hoverRef = ""
        this.accumulator = 0
        this.ajouterEvenement("systeme", `Replay démarré : ${actions.length} action(s), ${duree} tick(s)`)
        this.setStatus(duree > 0 ? "Replay en cours…" : "Enregistrement vide.")
        this.refreshUi(true)
    }

    private enregistrement(): EnregistrementAlgoFight {
        if (!this.sauvegardeInitiale) {
            throw new Error("Aucune sauvegarde initiale")
        }
        return {
            version: 1,
            largeur: this.largeurMonde,
            hauteur: this.hauteurMonde,
            config: { ...this.configEnregistree },
            sauvegarde: cloneJson(this.sauvegardeInitiale),
            actions: this.actions.map(action => ({ ...action })),
            dureeTicks: Math.max(this.dureeEnregistree, this.tick)
        }
    }

    private exporter() {
        try {
            const contenu = JSON.stringify(this.enregistrement(), null, 2)
            const url = URL.createObjectURL(new Blob([contenu], { type: "application/json" }))
            const link = document.createElement("a")
            link.href = url
            link.download = `algofight-replay-${Date.now()}.json`
            link.click()
            URL.revokeObjectURL(url)
            this.setStatus("Enregistrement exporté.")
        } catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), true)
        }
    }

    private async importer() {
        const file = this.fileInput.files?.[0]
        this.fileInput.value = ""
        if (!file) return

        try {
            const data = JSON.parse(await file.text()) as EnregistrementAlgoFight
            if (
                data.version !== 1 ||
                !data.sauvegarde?.root ||
                !Array.isArray(data.actions) ||
                !data.config
            ) {
                throw new Error("Format d’enregistrement invalide")
            }

            this.largeurMonde = data.largeur
            this.hauteurMonde = data.hauteur
            this.widthInput.value = String(data.largeur)
            this.heightInput.value = String(data.hauteur)
            this.configEnregistree = { ...data.config }
            this.sauvegardeInitiale = cloneJson(data.sauvegarde)
            this.actions = data.actions.map(action => ({ ...action }))
            this.dureeEnregistree = data.dureeTicks
            this.gestionMonde = new GestionMonde([], this.configEnregistree)
            this.gestionMonde.load(cloneJson(this.sauvegardeInitiale))
            this.initialiserReferencesLogiques()
            this.tick = 0
            this.playing = false
            this.replayMode = false
            this.animations = []
            this.evenements = []
            this.mobileRef = ""
            this.targetRef = ""
            this.ajouterEvenement("systeme", `${this.actions.length} action(s) importée(s)`)
            this.setStatus("Enregistrement importé. Cliquez sur Rejouer.")
            this.refreshUi(true)
        } catch (error) {
            this.setStatus(error instanceof Error ? error.message : String(error), true)
        }
    }

    private snapshot(): MondeSnapshot {
        const drones = new Map<string, EntiteSnapshot>()
        const usines = new Map<string, EntiteSnapshot>()
        for (const entity of this.gestionMonde.entities) {
            if (entity instanceof Drone) {
                drones.set(entity.id, {
                    x: entity.position.x,
                    y: entity.position.y,
                    joueur: entity.joueur.id
                })
            } else if (entity instanceof Usine) {
                usines.set(entity.id, {
                    x: entity.position.x,
                    y: entity.position.y,
                    joueur: entity.etat?.joueur.id
                })
            }
        }
        return { drones, usines }
    }

    private detecterEvenements(before: MondeSnapshot, after: MondeSnapshot) {
        const maintenant = performance.now()

        for (const [id, value] of after.drones) {
            if (!before.drones.has(id)) {
                const drone = this.entite(id)
                if (drone instanceof Drone) {
                    this.enregistrerDroneCree(drone)
                }
                const couleur = value.joueur === this.gestionMonde.joueurA.id ? COULEUR_A : COULEUR_B
                this.animations.push({
                    type: "creation",
                    x: value.x,
                    y: value.y,
                    couleur,
                    libelle: "+ DRONE",
                    debut: maintenant,
                    duree: 950
                })
                this.ajouterEvenement("creation", `Une usine a créé le drone ${idCourt(id)}`)
            }
        }

        for (const [id, value] of before.drones) {
            if (!after.drones.has(id)) {
                this.animations.push({
                    type: "destruction",
                    x: value.x,
                    y: value.y,
                    couleur: "#ff6b57",
                    libelle: "DRONE DÉTRUIT",
                    debut: maintenant,
                    duree: 1100
                })
                this.ajouterEvenement("destruction", `Drone ${idCourt(id)} détruit`)
                if (this.mobileRef === id) this.mobileRef = ""
                if (this.targetRef === id) this.targetRef = ""
            }
        }

        for (const [id, value] of after.usines) {
            const old = before.usines.get(id)
            if (old && old.joueur !== value.joueur && value.joueur) {
                const joueur = value.joueur === this.gestionMonde.joueurA.id ? "A" : "B"
                const couleur = joueur === "A" ? COULEUR_A : COULEUR_B
                this.animations.push({
                    type: "capture",
                    x: value.x,
                    y: value.y,
                    couleur,
                    libelle: `USINE → ${joueur}`,
                    debut: maintenant,
                    duree: 1400
                })
                this.ajouterEvenement("capture", `Joueur ${joueur} prend l’usine ${idCourt(id)}`)
            }
        }
    }

    private selectionCanvas(event: MouseEvent) {
        if (this.replayMode) {
            this.setStatus("Les commandes manuelles sont désactivées pendant le replay.", true)
            return
        }

        const entity = this.entiteSousPointeur(event)
        if (!entity) {
            this.setStatus(this.mobileRef
                ? "Cliquez directement sur une entité pour choisir la cible."
                : "Cliquez sur un drone disponible ou sur une usine alliée avec newDrone.", true)
            return
        }

        if (!this.mobileRef) {
            const drone = this.droneDepuisSelection(entity)
            if (!drone) {
                this.setStatus("Premier clic invalide : choisissez un drone allié ou une usine alliée avec newDrone.", true)
                return
            }
            if (this.droneOccupe(drone)) {
                this.setStatus(`⛔ Drone ${idCourt(drone.id)} occupé : attendez la fin de son action.`, true)
                return
            }

            this.mobileRef = drone.id
            this.targetRef = ""
            this.setStatus(entity instanceof Usine
                ? `newDrone ${idCourt(drone.id)} de l’usine ${idCourt(entity.id)} sélectionné. Choisissez sa cible.`
                : `Drone ${idCourt(drone.id)} prêt. Choisissez maintenant sa cible.`)
            this.refreshUi(true)
            return
        }

        const mobile = this.entite(this.mobileRef)
        if (!(mobile instanceof Drone) || this.droneOccupe(mobile)) {
            this.mobileRef = ""
            this.targetRef = ""
            this.setStatus("⛔ Ce drone n’est plus disponible. Sélectionnez-en un autre.", true)
            this.refreshUi(true)
            return
        }

        if (entity.id === mobile.id) {
            this.mobileRef = ""
            this.targetRef = ""
            this.setStatus("Sélection annulée.")
            this.refreshUi(true)
            return
        }

        if (entity instanceof Drone && entity.joueur === this.joueurActif()) {
            this.setStatus("⛔ Un drone allié ne peut pas être pris pour cible.", true)
            this.refreshUi(true)
            return
        }

        this.targetRef = entity.id
        this.executerOrdre()
    }

    private survolCanvas(event: PointerEvent) {
        this.pointerMonde = this.positionSousPointeur(event)
        const entity = this.entiteSousPointeur(event)
        const id = entity?.id ?? ""
        if (id !== this.hoverRef) {
            this.hoverRef = id
            this.refreshUi(true)
        }
    }

    private positionSousPointeur(event: MouseEvent | PointerEvent) {
        const rect = this.canvas.getBoundingClientRect()
        const x = (event.clientX - rect.left - this.vueCanvas.offsetX) / this.vueCanvas.scale
        const y = (event.clientY - rect.top - this.vueCanvas.offsetY) / this.vueCanvas.scale
        if (x < 0 || y < 0 || x > this.largeurMonde || y > this.hauteurMonde) return undefined
        return { x, y }
    }

    private entiteSousPointeur(event: MouseEvent | PointerEvent) {
        const pointer = this.positionSousPointeur(event)
        if (!pointer) return undefined

        let best: GameElement | undefined
        let bestDistance = Infinity
        let bestPriority = Infinity
        for (const entity of this.gestionMonde.entities) {
            const radius = entity instanceof Usine ? 22 : entity instanceof Drone ? 15 : 10
            const distance = Math.hypot(entity.position.x - pointer.x, entity.position.y - pointer.y)
            const priority = this.prioritePremierClic(entity)
            if (
                distance <= radius &&
                (priority < bestPriority || (priority === bestPriority && distance < bestDistance))
            ) {
                best = entity
                bestDistance = distance
                bestPriority = priority
            }
        }
        return best
    }

    private prioritePremierClic(entity: GameElement) {
        if (this.mobileRef) return 0
        const joueur = this.joueurActif()
        if (entity instanceof Usine && entity.etat?.joueur === joueur && entity.etat.newDrone) return 0
        if (entity instanceof Drone && entity.joueur === joueur) return 1
        return 2
    }

    private droneDepuisSelection(entity: GameElement) {
        const joueur = this.joueurActif()
        if (entity instanceof Drone && entity.joueur === joueur) return entity
        if (entity instanceof Usine && entity.etat?.joueur === joueur) return entity.etat.newDrone
        return undefined
    }

    private droneOccupe(drone: Drone) {
        const state = this.gestionMonde.droneStates.find(value => value.ref === drone)
        return !state || state.type !== "wait" || (drone.cible?.fireTime ?? 0) > 0
    }

    private refreshUi(force: boolean) {
        if (!this.gestionMonde) return

        this.playButton.textContent = this.playing ? "Pause" : "Lecture"
        this.playerAButton.classList.toggle("active-a", this.joueurSelectionne === "A")
        this.playerBButton.classList.toggle("active-b", this.joueurSelectionne === "B")
        this.speedValue.textContent = this.stepsParSeconde() + "/s"

        const moving = this.gestionMonde.droneStates.filter(state => state.type === "move").length
        this.summaryElement.innerHTML = `
            <span class="af-chip">Tick <strong>${this.tick}</strong></span>
            <span class="af-chip">Mode <strong>${this.replayMode ? "REPLAY" : this.playing ? "LIVE" : "PAUSE"}</strong></span>
            <span class="af-chip">Entités <strong>${this.gestionMonde.entities.length}</strong></span>
            <span class="af-chip">Drones en mouvement <strong>${moving}</strong></span>
            <span class="af-chip">Actions <strong>${this.actions.length}</strong></span>
        `
        this.statsElement.innerHTML = this.htmlStatistiques()
        this.inspectorElement.innerHTML = this.htmlInspecteur()
        this.refreshTimeline()

        if (force) this.dessiner(performance.now())
    }

    private htmlStatistiques() {
        const usines = this.gestionMonde.entities.filter((entity): entity is Usine => entity instanceof Usine)
        const energies = this.gestionMonde.entities.filter((entity): entity is Energie => entity instanceof Energie)
        const vies = this.gestionMonde.entities.filter((entity): entity is Vie => entity instanceof Vie)
        const drones = this.gestionMonde.entities.filter((entity): entity is Drone => entity instanceof Drone)
        const neutral = usines.filter(usine => !usine.etat).length
        const energieLibre = energies.filter(energie => !energie.proprietaire).length
        const vieLibre = vies.filter(vie => !vie.proprietaire).length

        return `
            <div class="af-kpis">
                <div class="af-kpi"><span>Usines neutres</span><strong>${neutral}</strong></div>
                <div class="af-kpi"><span>Drones total</span><strong>${drones.length}</strong></div>
                <div class="af-kpi"><span>Énergies libres</span><strong>${energieLibre}/${energies.length}</strong></div>
                <div class="af-kpi"><span>Vies libres</span><strong>${vieLibre}/${vies.length}</strong></div>
            </div>
            ${this.htmlJoueur("A", this.gestionMonde.joueurA)}
            ${this.htmlJoueur("B", this.gestionMonde.joueurB)}
            <div class="af-player-card">
                <div class="af-player-head"><span>Configuration</span><span>${this.largeurMonde}×${this.hauteurMonde}</span></div>
                <div class="af-mini-grid">
                    <div><strong>${this.gestionMonde.config.BUILD_TIME}</strong>Build</div>
                    <div><strong>${this.gestionMonde.config.FIRE_TIME}</strong>Cooldown</div>
                    <div><strong>${this.gestionMonde.config.TRANSPORT_COUNT}</strong>Transport base</div>
                </div>
            </div>
        `
    }

    private htmlJoueur(key: JoueurSelectionne, joueur: Joueur) {
        const drones = this.gestionMonde.entities.filter(
            (entity): entity is Drone => entity instanceof Drone && entity.joueur === joueur
        )
        const usines = this.gestionMonde.entities.filter(
            (entity): entity is Usine => entity instanceof Usine && entity.etat?.joueur === joueur
        )
        const energie = drones.reduce((sum, drone) => sum + drone.energieCount, 0)
        const vie = drones.reduce((sum, drone) => sum + drone.vieCount, 0)
        const techRows = TECHNOLOGIES.map(technologie => {
            const count = usines.filter(usine => usine.technologie === technologie).length
            return `<tr><td>${technologie}</td><td>${count}</td></tr>`
        }).join("")

        return `
            <div class="af-player-card ${key.toLowerCase()}">
                <div class="af-player-head"><span>Joueur ${key}</span><span>${usines.length} usine(s)</span></div>
                <div class="af-mini-grid">
                    <div><strong>${drones.length}</strong>Drones</div>
                    <div><strong>${energie}</strong>Énergie</div>
                    <div><strong>${vie}</strong>Vie</div>
                    <div><strong>${this.gestionMonde.getDroneSpeed(joueur)}</strong>Vitesse</div>
                    <div><strong>${this.gestionMonde.getDroneRange(joueur)}</strong>Portée</div>
                    <div><strong>${this.gestionMonde.getDronePower(joueur)}</strong>Puissance</div>
                    <div><strong>${this.gestionMonde.getDroneTransport(joueur)}</strong>Transport</div>
                    <div><strong>${this.gestionMonde.getDronePopulation(joueur)}</strong>Population/usine</div>
                    <div><strong>${usines.reduce((sum, usine) => sum + (usine.etat?.energieCount ?? 0), 0)}</strong>Stock usine</div>
                </div>
                <table class="af-tech"><tbody>${techRows}</tbody></table>
            </div>
        `
    }

    private htmlInspecteur() {
        const hover = this.entite(this.hoverRef)
        const mobile = this.entite(this.mobileRef)
        const target = this.entite(this.targetRef)
        const inspected = hover ?? target ?? mobile
        if (!inspected) {
            return "Survolez une entité ou sélectionnez un drone et une cible."
        }

        const lines = [
            `<strong>${echapper(this.libelleEntite(inspected))}</strong>`,
            `ID : ${echapper(inspected.id)}`,
            `Position : ${inspected.position.x.toFixed(1)}, ${inspected.position.y.toFixed(1)}`
        ]
        if (inspected instanceof Drone) {
            const state = this.gestionMonde.droneStates.find(value => value.ref === inspected)
            lines.push(`Joueur : ${this.nomJoueur(inspected.joueur)}`)
            lines.push(`Énergie / Vie : ${inspected.energieCount} / ${inspected.vieCount}`)
            lines.push(`État : ${state?.type ?? "absent"}`)
            lines.push(`Cible : ${inspected.cible ? this.libelleEntite(inspected.cible.cible as GameElement) : "aucune"}`)
            lines.push(`Cooldown : ${inspected.cible?.fireTime ?? 0}`)
            lines.push(`Usine mère : ${idCourt(inspected.usine.id)}`)
        } else if (inspected instanceof Usine) {
            lines.push(`Propriétaire : ${inspected.etat ? this.nomJoueur(inspected.etat.joueur) : "neutre"}`)
            lines.push(`Technologie : ${inspected.technologie}`)
            lines.push(`Énergie : ${inspected.etat?.energieCount ?? 0}`)
            lines.push(`Production : ${inspected.etat?.time ?? "inactive"}`)
            lines.push(`Population : ${inspected.etat?.populationCount ?? 0}`)
            lines.push(`Drone prêt : ${inspected.etat?.newDrone ? idCourt(inspected.etat.newDrone.id) : "non"}`)
        } else if (inspected instanceof Energie || inspected instanceof Vie) {
            lines.push(`Type : ${inspected instanceof Energie ? "Énergie" : "Vie"}`)
            lines.push(`Propriétaire : ${inspected.proprietaire ? this.libelleEntite(inspected.proprietaire) : "libre"}`)
        }
        return lines.join("<br>")
    }

    private refreshTimeline() {
        if (!this.evenements.length) {
            this.timelineElement.innerHTML = '<div class="af-event">Aucun événement.</div>'
            return
        }
        this.timelineElement.innerHTML = this.evenements
            .slice(-48)
            .reverse()
            .map(event => `
                <div class="af-event ${event.type}">
                    <strong>T${event.tick}</strong> · ${echapper(event.texte)}
                </div>
            `)
            .join("")
    }

    private dessiner(time: number) {
        if (!this.canvas || !this.gestionMonde) return
        const rect = this.canvas.getBoundingClientRect()
        const width = Math.max(1, rect.width)
        const height = Math.max(1, rect.height)
        const dpr = window.devicePixelRatio || 1
        const pixelWidth = Math.round(width * dpr)
        const pixelHeight = Math.round(height * dpr)
        if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth
        if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        this.ctx.clearRect(0, 0, width, height)
        this.ctx.fillStyle = "#050914"
        this.ctx.fillRect(0, 0, width, height)

        const margin = 18
        const scale = Math.min(
            (width - margin * 2) / this.largeurMonde,
            (height - margin * 2) / this.hauteurMonde
        )
        const mapWidth = this.largeurMonde * scale
        const mapHeight = this.hauteurMonde * scale
        const offsetX = (width - mapWidth) / 2
        const offsetY = (height - mapHeight) / 2
        this.vueCanvas = { scale, offsetX, offsetY, largeur: width, hauteur: height }

        this.ctx.save()
        this.ctx.translate(offsetX, offsetY)
        this.ctx.scale(scale, scale)
        this.dessinerGrille(scale)
        this.dessinerOrdres(scale)
        this.dessinerRessources(scale)
        this.dessinerUsines(scale)
        this.dessinerDrones(scale)
        this.dessinerAnimations(time, scale)
        this.ctx.restore()
    }

    private dessinerGrille(scale: number) {
        this.ctx.fillStyle = "#071021"
        this.ctx.fillRect(0, 0, this.largeurMonde, this.hauteurMonde)
        this.ctx.strokeStyle = "rgba(111, 137, 192, .11)"
        this.ctx.lineWidth = 1 / scale
        const step = 50
        for (let x = 0; x <= this.largeurMonde; x += step) {
            this.ctx.beginPath()
            this.ctx.moveTo(x, 0)
            this.ctx.lineTo(x, this.hauteurMonde)
            this.ctx.stroke()
        }
        for (let y = 0; y <= this.hauteurMonde; y += step) {
            this.ctx.beginPath()
            this.ctx.moveTo(0, y)
            this.ctx.lineTo(this.largeurMonde, y)
            this.ctx.stroke()
        }
        this.ctx.strokeStyle = "rgba(130, 158, 220, .55)"
        this.ctx.lineWidth = 2 / scale
        this.ctx.strokeRect(0, 0, this.largeurMonde, this.hauteurMonde)
    }

    private dessinerOrdres(scale: number) {
        this.ctx.setLineDash([6 / scale, 5 / scale])
        this.ctx.lineWidth = 1.5 / scale
        for (const state of this.gestionMonde.droneStates) {
            if (state.type !== "move") continue
            this.ctx.strokeStyle = this.couleurJoueur(state.ref.joueur) + "99"
            this.ctx.beginPath()
            this.ctx.moveTo(state.ref.position.x, state.ref.position.y)
            this.ctx.lineTo(state.refTarget.position.x, state.refTarget.position.y)
            this.ctx.stroke()
        }
        this.ctx.setLineDash([])

        const mobile = this.entite(this.mobileRef)
        if (!(mobile instanceof Drone) || !this.pointerMonde) return
        const entity = this.entite(this.hoverRef)
        const destination = entity?.position ?? this.pointerMonde
        const cibleInterdite = entity instanceof Drone && entity.joueur === this.joueurActif()
        this.dessinerFleche(
            mobile.position.x,
            mobile.position.y,
            destination.x,
            destination.y,
            cibleInterdite ? "#ff405d" : this.couleurJoueur(mobile.joueur),
            scale
        )
    }

    private dessinerFleche(
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        couleur: string,
        scale: number
    ) {
        const dx = x2 - x1
        const dy = y2 - y1
        const distance = Math.hypot(dx, dy)
        if (distance < 0.001) return

        const angle = Math.atan2(dy, dx)
        const pointe = 13 / scale
        this.ctx.save()
        this.ctx.strokeStyle = couleur
        this.ctx.fillStyle = couleur
        this.ctx.lineWidth = 3 / scale
        this.ctx.shadowColor = couleur
        this.ctx.shadowBlur = 10
        this.ctx.beginPath()
        this.ctx.moveTo(x1, y1)
        this.ctx.lineTo(x2, y2)
        this.ctx.stroke()
        this.ctx.beginPath()
        this.ctx.moveTo(x2, y2)
        this.ctx.lineTo(
            x2 - Math.cos(angle - Math.PI / 6) * pointe,
            y2 - Math.sin(angle - Math.PI / 6) * pointe
        )
        this.ctx.lineTo(
            x2 - Math.cos(angle + Math.PI / 6) * pointe,
            y2 - Math.sin(angle + Math.PI / 6) * pointe
        )
        this.ctx.closePath()
        this.ctx.fill()
        this.ctx.restore()
    }

    private dessinerRessources(scale: number) {
        for (const state of this.gestionMonde.ressourceStates) {
            const resource = state.ref
            if (resource.proprietaire) continue
            const color = resource instanceof Energie ? "#ffa62b" : "#63e6be"
            this.ctx.fillStyle = color + "33"
            this.ctx.strokeStyle = color
            this.ctx.lineWidth = 1.5 / scale
            this.ctx.beginPath()
            this.ctx.arc(resource.position.x, resource.position.y, 4.5, 0, Math.PI * 2)
            this.ctx.fill()
            this.ctx.stroke()
        }
    }

    private dessinerUsines(scale: number) {
        for (const state of this.gestionMonde.usineStates) {
            const usine = state.ref
            const color = usine.etat ? this.couleurJoueur(usine.etat.joueur) : COULEUR_NEUTRE
            const selected = usine.id === this.targetRef || usine.id === this.hoverRef
            this.ctx.fillStyle = color + "28"
            this.ctx.strokeStyle = selected ? "#ffffff" : color
            this.ctx.lineWidth = (selected ? 3 : 2) / scale
            this.ctx.beginPath()
            this.ctx.arc(usine.position.x, usine.position.y, selected ? 17 : 14, 0, Math.PI * 2)
            this.ctx.fill()
            this.ctx.stroke()

            this.ctx.fillStyle = "#f4f7ff"
            this.ctx.font = `700 ${13 / scale}px ui-sans-serif`
            this.ctx.textAlign = "center"
            this.ctx.textBaseline = "middle"
            this.ctx.fillText(usine.technologie[0], usine.position.x, usine.position.y)
            this.ctx.font = `${11 / scale}px ui-monospace`
            this.ctx.fillStyle = color
            this.ctx.fillText(idCourt(usine.id), usine.position.x, usine.position.y + 27 / scale)

            if (usine.etat?.newDrone) {
                this.ctx.font = `800 ${11 / scale}px ui-sans-serif`
                this.ctx.fillStyle = this.droneOccupe(usine.etat.newDrone) ? "#ff405d" : "#66f2ad"
                this.ctx.fillText(
                    this.droneOccupe(usine.etat.newDrone) ? "⛔ OCCUPÉ" : "DRONE PRÊT",
                    usine.position.x,
                    usine.position.y - 27 / scale
                )
            }
        }
    }

    private dessinerDrones(scale: number) {
        for (const state of this.gestionMonde.droneStates) {
            const drone = state.ref
            const color = this.couleurJoueur(drone.joueur)
            const selected = drone.id === this.mobileRef || drone.id === this.hoverRef
            const radius = selected ? 10 : 7
            const previewTarget = drone.id === this.mobileRef && this.pointerMonde
                ? (this.entite(this.hoverRef)?.position ?? this.pointerMonde)
                : undefined
            const isMoving = !previewTarget
                && state.type === "move"
                && state.distance > 0
                && (drone.cible?.fireTime ?? 0) <= 0
                && Math.hypot(state.sx, state.sy) > 0
            const direction = previewTarget
                ? {
                    x: previewTarget.x - drone.position.x,
                    y: previewTarget.y - drone.position.y
                }
                : isMoving
                    ? { x: state.sx, y: state.sy }
                    : state.type === "move"
                        ? {
                            x: state.refTarget.position.x - drone.position.x,
                            y: state.refTarget.position.y - drone.position.y
                        }
                        : undefined
            const angle = direction
                ? Math.atan2(direction.y, direction.x) + Math.PI / 2
                : 0

            this.ctx.save()
            this.ctx.translate(drone.position.x, drone.position.y)
            this.ctx.rotate(angle)
            this.ctx.fillStyle = color
            this.ctx.strokeStyle = selected ? "#ffffff" : "#061020"
            this.ctx.lineWidth = (selected ? 3 : 1.5) / scale
            this.ctx.beginPath()
            this.ctx.moveTo(0, -radius)
            this.ctx.lineTo(radius * .82, radius)
            this.ctx.lineTo(-radius * .82, radius)
            this.ctx.closePath()
            this.ctx.fill()
            this.ctx.stroke()
            this.ctx.restore()

            this.ctx.font = `${11 / scale}px ui-monospace`
            this.ctx.textAlign = "center"
            this.ctx.fillStyle = "#f7f9ff"
            this.ctx.fillText(
                `${drone.energieCount}E ${drone.vieCount}V`,
                drone.position.x,
                drone.position.y + 19 / scale
            )

            if (this.droneOccupe(drone)) {
                const iconX = drone.position.x + 10 / scale
                const iconY = drone.position.y - 10 / scale
                const iconRadius = 7 / scale
                this.ctx.fillStyle = "rgba(8, 10, 18, .92)"
                this.ctx.strokeStyle = "#ff405d"
                this.ctx.lineWidth = 2.5 / scale
                this.ctx.beginPath()
                this.ctx.arc(iconX, iconY, iconRadius, 0, Math.PI * 2)
                this.ctx.fill()
                this.ctx.stroke()
                this.ctx.beginPath()
                this.ctx.moveTo(iconX - iconRadius * .7, iconY + iconRadius * .7)
                this.ctx.lineTo(iconX + iconRadius * .7, iconY - iconRadius * .7)
                this.ctx.stroke()
            }
        }
    }

    private dessinerAnimations(time: number, scale: number) {
        const active: AnimationJeu[] = []
        for (const animation of this.animations) {
            const progress = (time - animation.debut) / animation.duree
            if (progress < 0 || progress >= 1) continue
            active.push(animation)
            const alpha = 1 - progress
            this.ctx.save()
            this.ctx.globalAlpha = alpha
            this.ctx.strokeStyle = animation.couleur
            this.ctx.fillStyle = animation.couleur
            this.ctx.lineWidth = 3 / scale

            if (animation.type === "destruction") {
                for (let i = 0; i < 12; i++) {
                    const angle = i * Math.PI * 2 / 12
                    const r1 = 5 + progress * 12
                    const r2 = 12 + progress * 32
                    this.ctx.beginPath()
                    this.ctx.moveTo(animation.x + Math.cos(angle) * r1, animation.y + Math.sin(angle) * r1)
                    this.ctx.lineTo(animation.x + Math.cos(angle) * r2, animation.y + Math.sin(angle) * r2)
                    this.ctx.stroke()
                }
            } else {
                const radius = animation.type === "capture"
                    ? 18 + progress * 45
                    : 8 + progress * 30
                this.ctx.beginPath()
                this.ctx.arc(animation.x, animation.y, radius, 0, Math.PI * 2)
                this.ctx.stroke()
                if (animation.type === "capture") {
                    this.ctx.beginPath()
                    this.ctx.arc(animation.x, animation.y, radius * .65, 0, Math.PI * 2)
                    this.ctx.stroke()
                }
            }

            this.ctx.font = `800 ${12 / scale}px ui-sans-serif`
            this.ctx.textAlign = "center"
            this.ctx.fillText(animation.libelle, animation.x, animation.y - (26 + progress * 20) / scale)
            this.ctx.restore()
        }
        this.animations = active
    }

    private joueurActif() {
        return this.joueurSelectionne === "A"
            ? this.gestionMonde.joueurA
            : this.gestionMonde.joueurB
    }

    private initialiserReferencesLogiques() {
        this.logicalKeyById.clear()
        this.idByLogicalKey.clear()
        this.droneCountByFactory.clear()

        for (const entity of this.gestionMonde.entities) {
            const key = "entity:" + entity.id
            this.logicalKeyById.set(entity.id, key)
            this.idByLogicalKey.set(key, entity.id)
        }
    }

    private enregistrerDroneCree(drone: Drone) {
        const factoryId = drone.usine.id
        const count = (this.droneCountByFactory.get(factoryId) ?? 0) + 1
        this.droneCountByFactory.set(factoryId, count)
        const key = `drone:${factoryId}:${count}`
        this.logicalKeyById.set(drone.id, key)
        this.idByLogicalKey.set(key, drone.id)
    }

    private resoudreReference(key: string | undefined, fallback: string) {
        return key ? this.idByLogicalKey.get(key) ?? fallback : fallback
    }

    private nomJoueur(joueur: Joueur) {
        if (joueur === this.gestionMonde.joueurA) return "A"
        if (joueur === this.gestionMonde.joueurB) return "B"
        return idCourt(joueur.id)
    }

    private couleurJoueur(joueur: Joueur) {
        return joueur === this.gestionMonde.joueurA ? COULEUR_A : COULEUR_B
    }

    private entite(id: string) {
        return this.gestionMonde?.entities.find(entity => entity.id === id)
    }

    private libelleEntite(entity?: GameElement) {
        if (!entity) return "entité inconnue"
        if (entity instanceof Drone) {
            return `Drone ${this.nomJoueur(entity.joueur)} #${idCourt(entity.id)} · ${entity.energieCount}E/${entity.vieCount}V`
        }
        if (entity instanceof Usine) {
            return `Usine #${idCourt(entity.id)} · ${entity.technologie} · ${entity.etat ? "J" + this.nomJoueur(entity.etat.joueur) : "neutre"}`
        }
        if (entity instanceof Energie) return `Énergie #${idCourt(entity.id)}`
        if (entity instanceof Vie) return `Vie #${idCourt(entity.id)}`
        return `${entity.constructor.name} #${idCourt(entity.id)}`
    }

    private ajouterEvenement(type: EvenementJeu["type"], texte: string) {
        this.evenements.push({ tick: this.tick, type, texte })
        if (this.evenements.length > 300) this.evenements.shift()
    }

    private setStatus(message: string, error = false) {
        this.statusElement.textContent = message
        this.statusElement.style.color = error ? "#ff8a99" : "#aebde0"
    }

    private stepsParSeconde() {
        return Math.max(1, Number(this.speedInput.value) || 1)
    }
}

export function installerTestUi(container: HTMLElement = document.body) {
    const ui = new TestUi()
    container.replaceChildren(ui.createInterface())
    ui.initInterface()
    return ui
}

function installerDansBody() {
    installerTestUi(document.body)
}

if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", installerDansBody, { once: true })
    } else {
        installerDansBody()
    }
}
