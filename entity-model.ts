
export abstract class Entity {
    id!: string

    constructor() {
        this.id = crypto.randomUUID()
    }
}

type Class<T> = abstract new (...args: any[]) => T;

export type JsonEntity = {
    [name: string]: Value
}

export type Value =
    | { type: 'ref', id: string }
    | number
    | string
    | boolean
    | Value[]
    | { type: 'data', value: any }

export interface JsonData {
    entities: {
        [id: string]: {
            className: string
            jsonEntity: JsonEntity
        }
    }
    root: string
}

export function entityToJsonData(entity: Entity): JsonData {
    if (!(entity instanceof Entity)) {
        throw new TypeError(
            "entityToJsonData: value is not an Entity"
        )
    }

    const jsonData: JsonData = {
        entities: {},
        root: entity.id
    }
    const entitiesById = new Map<string, Entity>()

    entityToJsonEntity(
        entity,
        jsonData,
        entitiesById
    )

    return jsonData
}

export function JsonEntitytoEntity(
    jsonData: JsonData,
    jsonEntity: JsonEntity,
    classes: Class<Entity>[]
): Entity {

    const entry = Object.entries(jsonData.entities)
        .find(([, data]) => data.jsonEntity === jsonEntity)

    if (!entry) {
        throw new Error(
            "JsonEntitytoEntity: jsonEntity does not belong to jsonData.entities"
        )
    }

    const [id] = entry

    return entityFromId(jsonData, id, classes, new Map())
}

export function JsonDatatoEntity<T extends Entity>(
    jsonData: JsonData,
    classes: Class<Entity>[]
): T {

    if (!jsonData.root) {
        throw new Error(
            "JsonDatatoEntity: jsonData.root is empty"
        )
    }

    if (!jsonData.entities[jsonData.root]) {
        throw new Error(
            `JsonDatatoEntity: root entity '${jsonData.root}' does not exist`
        )
    }

    return entityFromId(
        jsonData,
        jsonData.root,
        classes,
        new Map()
    ) as T
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function entityToJsonEntity(
    entity: Entity,
    jsonData: JsonData,
    entitiesById: Map<string, Entity>
): JsonEntity {

    if (typeof entity.id !== "string" || entity.id.length === 0) {
        throw new Error(
            "entityToJsonData: entity has no valid id"
        )
    }

    const knownEntity = entitiesById.get(entity.id)

    if (knownEntity) {
        if (knownEntity !== entity) {
            throw new Error(
                `entityToJsonData: several entities use id '${entity.id}'`
            )
        }

        return jsonData.entities[entity.id].jsonEntity
    }

    const className = entity.constructor.name

    if (!className) {
        throw new Error(
            `entityToJsonData: entity '${entity.id}' has no class name`
        )
    }

    const jsonEntity: JsonEntity = {}

    // Enregistrement avant le parcours des propriétés : A -> B -> A ne
    // déclenche ainsi ni récursion infinie ni double sérialisation.
    entitiesById.set(entity.id, entity)
    jsonData.entities[entity.id] = {
        className,
        jsonEntity
    }

    try {
        for (const [name, value] of Object.entries(entity)) {
            // L'id canonique est la clé de jsonData.entities.
            if (name === "id" || value === undefined) {
                continue
            }

            jsonEntity[name] = valueToJsonValue(
                value,
                jsonData,
                entitiesById,
                className + "." + name,
                new WeakSet()
            )
        }
    }
    catch (error) {
        entitiesById.delete(entity.id)
        delete jsonData.entities[entity.id]

        throw new Error(
            `entityToJsonData: cannot serialize entity '${entity.id}' of class '${className}'`,
            { cause: error }
        )
    }

    return jsonEntity
}

function valueToJsonValue(
    value: any,
    jsonData: JsonData,
    entitiesById: Map<string, Entity>,
    path: string,
    dataAncestors: WeakSet<object>
): Value {

    if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    ) {
        return value
    }

    if (value instanceof Entity) {
        entityToJsonEntity(
            value,
            jsonData,
            entitiesById
        )

        return {
            type: "ref",
            id: value.id
        }
    }

    if (Array.isArray(value)) {
        assertNoDataCycle(value, path, dataAncestors)

        try {
            return Array.from(value, (item, index) => {
                if (item === undefined) {
                    throw new Error(
                        "valueToJsonValue: undefined value at '" + path + "[" + index + "]'"
                    )
                }

                return valueToJsonValue(
                    item,
                    jsonData,
                    entitiesById,
                    path + "[" + index + "]",
                    dataAncestors
                )
            })
        }
        finally {
            dataAncestors.delete(value)
        }
    }

    if (value !== undefined && typeof value === "object") {
        if (value === null) {
            return {
                type: "data",
                value: null
            }
        }

        assertNoDataCycle(value, path, dataAncestors)

        try {
            const data: { [name: string]: Value } = {}

            for (const [name, item] of Object.entries(value)) {
                if (item === undefined) {
                    continue
                }

                data[name] = valueToJsonValue(
                    item,
                    jsonData,
                    entitiesById,
                    path + "." + name,
                    dataAncestors
                )
            }

            return {
                type: "data",
                value: data
            }
        }
        finally {
            dataAncestors.delete(value)
        }
    }

    throw new Error(
        `valueToJsonValue: unsupported value of type '${typeof value}' at '${path}'`
    )
}

function assertNoDataCycle(
    value: object,
    path: string,
    dataAncestors: WeakSet<object>
) {
    if (dataAncestors.has(value)) {
        throw new Error(
            "valueToJsonValue: circular data value at '" + path + "'"
        )
    }

    dataAncestors.add(value)
}

function entityFromId(
    jsonData: JsonData,
    id: string,
    classes: Class<Entity>[],
    cache: Map<string, Entity>
): Entity {

    // Important pour les références circulaires.
    const cached = cache.get(id)

    if (cached) {
        return cached
    }

    const definition = jsonData.entities[id]

    if (!definition) {
        throw new Error(
            `entityFromId: entity '${id}' does not exist`
        )
    }

    const clazz = classes.find(
        clazz => clazz.name === definition.className
    )

    if (!clazz) {
        throw new Error(
            `entityFromId: class '${definition.className}' was not provided`
        )
    }

    let entity: Entity

    try {
        // Class<T> accepte les classes abstraites au niveau du type,
        // mais une classe réellement présente ici doit être instanciable.
        const Constructor = clazz as new () => Entity
        entity = new Constructor()
    }
    catch (error) {
        throw new Error(
            `entityFromId: cannot instantiate class '${definition.className}'`,
            { cause: error }
        )
    }

    // On remplace l'id créé par le constructeur par l'id sérialisé.
    entity.id = id

    // IMPORTANT :
    // mise en cache AVANT la résolution des propriétés.
    //
    // A -> B -> A fonctionne donc correctement.
    cache.set(id, entity)

    try {
        for (const [name, value] of Object.entries(definition.jsonEntity)) {

            if (name === "id") {
                // L'id canonique vient de jsonData.entities[id].
                continue
            }

            ; (entity as any)[name] = valueToValue(
                jsonData,
                value,
                classes,
                cache
            )
        }
    }
    catch (error) {
        cache.delete(id)

        throw new Error(
            `entityFromId: cannot deserialize entity '${id}' of class '${definition.className}'`,
            { cause: error }
        )
    }

    return entity
}

function valueToValue(
    jsonData: JsonData,
    value: Value,
    classes: Class<Entity>[],
    cache: Map<string, Entity>
): any {

    if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    ) {
        return value
    }

    if (Array.isArray(value)) {
        return value.map(
            item => valueToValue(
                jsonData,
                item,
                classes,
                cache
            )
        )
    }

    if (value === null || typeof value !== "object") {
        throw new Error(
            `valueToValue: invalid value '${String(value)}'`
        )
    }

    if (value.type === "ref") {

        if (!value.id) {
            throw new Error(
                "valueToValue: reference has no id"
            )
        }

        if (!jsonData.entities[value.id]) {
            throw new Error(
                `valueToValue: referenced entity '${value.id}' does not exist`
            )
        }

        return entityFromId(
            jsonData,
            value.id,
            classes,
            cache
        )
    }

    if (value.type === "data") {
        return dataValueToValue(
            jsonData,
            value.value,
            classes,
            cache
        )
    }

    throw new Error(
        `valueToValue: unknown value type`
    )
}

function dataValueToValue(
    jsonData: JsonData,
    value: any,
    classes: Class<Entity>[],
    cache: Map<string, Entity>
): any {

    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    ) {
        return value
    }

    if (Array.isArray(value)) {
        return value.map(item =>
            valueToValue(jsonData, item, classes, cache)
        )
    }

    if (typeof value === "object") {
        const result: { [name: string]: any } = {}

        for (const [name, item] of Object.entries(value)) {
            result[name] = valueToValue(
                jsonData,
                item as Value,
                classes,
                cache
            )
        }

        return result
    }

    throw new Error(
        `dataValueToValue: invalid value '${String(value)}'`
    )
}
