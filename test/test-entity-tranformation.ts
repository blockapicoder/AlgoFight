import { assertEquals, log} from "../node_modules/tauri-kargo-tools/src/test"
import * as mdl from "../algofight-entity-model"
import * as tools from "../entity-model"


const d = new mdl.Drone()
const joueur = new mdl.Joueur()
d.joueur = joueur
d.usine = new mdl.Usine()
d.usine.etat = { joueur:joueur , energieCount: 10 , populationCount:1 , time:5}
const dataJson = tools.entityToJsonData(d)
const e:mdl.Drone = tools.JsonDatatoEntity(dataJson,[ mdl.Drone ,mdl.Joueur , mdl.Usine , mdl.Energie, mdl.Vie])
assertEquals(d.id , e.id,"drone id")
assertEquals(d.usine.id,e.usine.id,"usine id")
log("id=",e.id)



