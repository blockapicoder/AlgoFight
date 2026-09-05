import { GestionMonde } from "../gestion-algofight-entity-model";
import * as mdl from "../algofight-entity-model"
import { assertEquals, log } from "../node_modules/tauri-kargo-tools/src/test"

export class TestEngine {

    gm: GestionMonde
    constructor(gm: GestionMonde) {
        this.gm = gm
    }

    prendreEnergie(joueur: mdl.Joueur, time: number, drone: mdl.Drone) {
        const gm = this.gm

        const energieLibre = gm.energies().find((e) => !e.proprietaire)
        if (!energieLibre) {

            return "energieLibre"
        }
        log("prendreEnergie ", energieLibre.id, " drone ", drone.id)
        assertEquals(gm.initDroneState(joueur, drone.id, energieLibre?.id!), true, "initSroneState energie")
        let p: mdl.Position = { ...drone.position }
        gm.step()
        assertEquals(!!drone.cible, true, "drone a une cible")
        const cible = drone.cible?.cible
        assertEquals(cible instanceof mdl.Energie, true, "drone a une bonne classe de cible energie")
        if (cible instanceof mdl.Energie) {
            assertEquals(cible.id, energieLibre!.id, "drone a une cible energie")
        }
        gm.step()


        while (time > 0) {
            gm.step()
            if (energieLibre?.proprietaire?.id === drone.id) {
                assertEquals(p.x !== drone.position.x, true, `position x differente ${drone.position.x - energieLibre?.position?.x!}`)
                assertEquals(p.y !== drone.position.y, true, `position y differente ${drone.position.y - energieLibre?.position?.y!}`)
                log(drone.cible?.fireTime!)
                while (drone.cible) {
                    gm.step()
                }
                assertEquals(energieLibre?.proprietaire?.id, drone.id, `energie recuperer ${energieLibre?.proprietaire?.id}`)



                return "ok"
            }

            time--
        }
        return "timeout"
    }

    donnerEnergiePourUsine(joueur: mdl.Joueur, time: number, drone: mdl.Drone, usine?: mdl.Usine) {
        const gm = this.gm
        if (!usine) {
            return "pas usine"
        }
        log("donnerEnergiePourUsine ", usine.id, " drone ", drone.id)
        assertEquals(gm.initDroneState(gm.joueurA, drone.id, usine.id), true, "initSroneState usine")
        const oldCount = usine.etat?.energieCount ?? 0
        gm.step()
        assertEquals(!!drone.cible, true, "drone a une cible")
        const cibleUsine = drone.cible?.cible
        const energiesDrone: mdl.Energie[] = this.gm.energies().filter((e) => e.proprietaire?.id === drone.id)
        assertEquals(cibleUsine instanceof mdl.Usine, true, "drone a une bonne cible usine")
        if (cibleUsine instanceof mdl.Usine) {
            assertEquals(cibleUsine.id, usine!.id, "drone a une cible usine")
        }
        let p: mdl.Position = { ...drone.position }
        while (time > 0) {
            this.gm.step()
            if (energiesDrone.some((e) => e.proprietaire?.id === usine.id)) {
                while (drone.cible) {
                    gm.step()
                }
                assertEquals(usine.etat?.joueur.id, gm.joueurA.id, " usine prise")
                assertEquals(usine.etat?.energieCount, oldCount + 1, " usine prise")
                return "ok"
            }
            time--;

        }

        return "timeout"

    }
}