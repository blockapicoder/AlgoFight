
import * as mdl from "../algofight-entity-model"
import { Entity, entityToJsonData } from "../entity-model"
import * as moteur from "../gestion-algofight-entity-model"
import { assertEquals, log } from "../node_modules/tauri-kargo-tools/src/test"
import * as client from "../node_modules/tauri-kargo-tools/src/api"
import { TestEngine } from "./tools"
const gm = new moteur.GestionMonde()
const saveReq = await fetch("/app/test/save.json")
const save = await saveReq.json()
gm.load(save)
const testEngine = new TestEngine(gm)
/*
gm.createWorld(1000, 600)
const s = gm.save()
const tauriClient = client.createClient()
tauriClient.writeFileText("save.json",JSON.stringify(entityToJsonData(s)))
*/
assertEquals(gm.drones().length, 0)
assertEquals(gm.usines().length, mdl.DEFAULT_CONFIG.USINE_COUNT, "usines count")

assertEquals(gm.energies().length, mdl.DEFAULT_CONFIG.ENERGIE_COUNT, "energie count")

assertEquals(gm.vies().length, mdl.DEFAULT_CONFIG.VIE_COUNT, "vie count")

const usinesA = gm.usines().filter((u) => u.etat && u.etat.joueur === gm.joueurA)
const usineA = usinesA[0]

const usinesB = gm.usines().filter((u) => u.etat && u.etat.joueur === gm.joueurB)
assertEquals(usinesA.length, 1)
assertEquals(usinesB.length, 1)

assertEquals(usineA.etat?.populationCount, 0)
assertEquals(usineA.etat?.energieCount, 0)
assertEquals(usineA.etat?.joueur.id, gm.joueurA.id)
assertEquals((usineA.etat?.time ?? 0) > 0, true, "build time")

const usineB = usinesB[0]
assertEquals(usineB.etat?.populationCount, 0)
assertEquals(usineB.etat?.energieCount, 0)
assertEquals(usineB.etat?.joueur.id, gm.joueurB.id)
assertEquals((usineB.etat?.time ?? 0) > 0, true, "build time")
for (let i = 0; i <= mdl.DEFAULT_CONFIG.BUILD_TIME; i++) {
    gm.step()
}
assertEquals(!!usineB.etat?.newDrone, true, "new Drone B")
assertEquals(!!usineA.etat?.newDrone, true, "new Drone A")
const drone = usineA.etat?.newDrone!


assertEquals(testEngine.prendreEnergie(gm.joueurA, 1500, drone), "ok", "prendre energie")

assertEquals(usineA.etat?.newDrone?.id !== drone.id, true, " usine reinit")

const usineCible = gm.usines().find((u) => !u.etat)
assertEquals(testEngine.donnerEnergiePourUsine(gm.joueurA, 1500, drone, usineCible), "ok", "donnerEnergiePourUsine")

const usinesAApres = gm.usines().filter((u) => u.etat && u.etat.joueur === gm.joueurA)

assertEquals(usinesA.length + 1, usinesAApres.length, " une usine en plus ")
assertEquals(usineA.etat?.populationCount, 2, "deux drone")
