
import * as mdl from "../algofight-entity-model"
import { Entity, entityToJsonData } from "../entity-model"
import * as moteur from "../gestion-algofight-entity-model"
import { assertEquals, log } from "../node_modules/tauri-kargo-tools/src/test"

import { TestEngine } from "./tools"
const gm = new moteur.GestionMonde()
const saveReq = await fetch("/app/test/save.json")
const save = await saveReq.json()
gm.load(save)
const testEngine = new TestEngine(gm)


const usinesA = gm.usines().filter((u) => u.etat && u.etat.joueur === gm.joueurA)
const usineA = usinesA[0]
for (let i = 0; i <= mdl.DEFAULT_CONFIG.BUILD_TIME; i++) {
    gm.step()
}
const drone = usineA.etat?.newDrone!
log("test")
let n =8
let count = n
while (count > 0) {
    assertEquals(testEngine.prendreEnergie(gm.joueurA, 2500, drone), "ok", "prendre energie")
    count--
}


assertEquals(gm.energies().filter((e) => e.proprietaire?.id === drone.id).length, n, `recuperation ${n} energie`)
