import {
    Drone,
    Monde,
    Usine,
    setTarget,
    Position,
    Element,
    Vie,
    Energie,
    start,
    setLog
} from "../algofight-entity-model"

function dist(a: Position, b: Position) {
    const dx = a.x - b.x
    const dy = a.y - b.y
    return dx * dx + dy * dy
}
function nearest<T extends Element>(usines: T[], p: Position) {
    let r = usines[0]
    let d = dist(usines[0].position, p)

    for (const u of usines) {
        const tmp = dist(p, u.position)
        if (tmp < d) {
            d = tmp
            r = u;
        }
    }
    return r
}

const setEnergie: Set<string> = new Set()
const setVie: Set<string> = new Set()

let dronePreneurUsine: Set<string> = new Set()
start((monde: Monde) => {
    const droneVivant: Set<string> = new Set()
    let debugCount = 0
    const drones = monde.entities.filter(
        (entity): entity is Drone => {
            if (entity instanceof Drone) {

                if (entity.joueur === monde.joueur) {
                    if (entity.vieCount > 1) {
                        debugCount++;
                    }
                    droneVivant.add(entity.id)
                    if (dronePreneurUsine.size < 5) {
                        dronePreneurUsine.add(entity.id)
                    }
                    if (entity.cible) {
                        return false
                    }
                    return true
                }

            }
            return false
        }
    )
    let tmpDronePreneurUsine: Set<string> = new Set()
    dronePreneurUsine.forEach((i) => {
        if (droneVivant.has(i)) {
            tmpDronePreneurUsine.add(i)
        }
    })
    dronePreneurUsine = tmpDronePreneurUsine
    let max = 1

    let usines = monde.entities.filter((e): e is Usine => {

        if (e instanceof Usine) {



            if (e.etat?.joueur === monde.joueur) {

                if (e.etat.vieCount < max) {
                    return true
                }
                return false

            }
            return true
        }
        return false
    })
    let usinesAdverse = monde.entities.filter((e): e is Usine => {

        if (e instanceof Usine) {
            if (e.etat && e.etat.joueur !== monde.joueur) {
                return true
            }
        }
        return false
    })

    let vies = monde.entities.filter((e): e is Vie => {

        if (e instanceof Vie) {
            if (e.proprietaire) {
                setVie.delete(e.id)
                return false

            }
            return true

        }

        return false
    })
    let energie = monde.entities.filter((e): e is Energie => {
        if (e instanceof Energie) {
            if (e.proprietaire) {
                setEnergie.delete(e.id)
                return false
            }
            return true
        }
        return false
    })

    let dronesAdverse = monde.entities.filter(
        (entity): entity is Drone =>
            entity instanceof Drone
            && entity.joueur !== monde.joueur

    )

    let nbAttaquant = 0
    let droneAvecCible = 0

    for (const drone of drones) {


        let estAttaquant = !dronePreneurUsine.has(drone.id)

        if (!estAttaquant) {
            if (drone.vieCount >= 1) {
                if (usines.length > 0) {
                    const r = nearest(usines, drone.position)
                    usines = usines.filter((u) => u !== r)
                    setTarget(drone, r)
                    droneAvecCible++

                } else {
                    estAttaquant = true
                }
            } else {
                if (vies.length > 0) {
                    const r = nearest(vies, drone.position)
                    vies = vies.filter((u) => u !== r)
                    setTarget(drone, r)
                    setVie.add(r.id)
                    droneAvecCible++
                } else {
                    estAttaquant = true
                }
            }
        }
        if (estAttaquant) {
            if (usinesAdverse.length > 1) {

                nbAttaquant++
                const r = nearest(usinesAdverse, drone.position)
                let u = r.etat?.vieCount ?? 0
                if (r && ( drone.energieCount >= 1 || dronesAdverse.length === 0)) {

                    usinesAdverse = usinesAdverse.filter((u) => u != r)
                    setTarget(drone, r)
                    droneAvecCible++

                } else {
                    if (energie.length > 0) {
                        const r = nearest(energie, drone.position)
                        energie = energie.filter((u) => u !== r)
                        setTarget(drone, r)
                        droneAvecCible++
                        setEnergie.add(r.id)
                    } else {
                        max++
                    }
                }
            } else {
                nbAttaquant++
                const r = nearest(dronesAdverse, drone.position)

                if (r && drone.energieCount >= 1) {

                    dronesAdverse = dronesAdverse.filter((u) => u != r)
                    setTarget(drone, r)
                    droneAvecCible++

                } else {
                    if (energie.length > 0) {
                        const r = nearest(energie, drone.position)
                        energie = energie.filter((u) => u !== r)
                        setTarget(drone, r)
                        droneAvecCible++
                        setEnergie.add(r.id)
                    } else {
                        max++
                    }
                }
            }
        }





        // Choisissez une cible puis appelez : setTarget(drone, cible)
    }
    setLog({ type: "botState", values: { tyme: "flag", nbUsinesAdverse: usinesAdverse.length, nbAttaquant: nbAttaquant, droneSansCible: drones.length - droneAvecCible, nbDrone: droneVivant.size, nbPreneurUsine: dronePreneurUsine.size, debugCount: debugCount, max: max } });

})
