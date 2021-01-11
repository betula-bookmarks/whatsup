import { Factor } from './factor'
import { Event, EventCtor, EventListener } from './event'
import { Atom } from './atom'
import { Actor, ActorController, ActorGenerator } from './actor'
import { Result, Err } from './result'
import { Stream } from './stream'

type Ctor<T> = Function | (new (...args: any[]) => T)

export class Context {
    /**@internal */
    readonly parent: Context | null

    private readonly atom: Atom
    private readonly actors: Map<ActorGenerator<any, any>, ActorController<any, any>>
    private shared: WeakMap<Factor<any> | Ctor<any>, any> | undefined
    private listeners: WeakMap<EventCtor, Set<EventListener>> | undefined

    constructor(atom: Atom, parent: Context | null) {
        this.atom = atom
        this.parent = parent
        this.actors = new Map()
    }

    /**@internal */
    getShared() {
        return this.shared
    }

    share<T>(instance: T & { constructor: Ctor<T> }) {
        if (!this.shared) {
            this.shared = new WeakMap()
        }
        this.shared.set(instance.constructor, instance)
    }

    define<T>(key: Factor<T>, value: T) {
        if (!this.shared) {
            this.shared = new WeakMap()
        }
        this.shared.set(key, value)
    }

    find<T>(key: Factor<T>): T | undefined
    find<T>(key: Ctor<T>): T | undefined
    find<T>(key: Factor<T> | Ctor<T>): T | undefined {
        let parent = this.parent as Context | null

        while (parent) {
            const shared = parent.getShared()

            if (shared && shared.has(key)) {
                return shared.get(key)
            }

            parent = parent.parent
        }

        if (key instanceof Factor) {
            return key.defaultValue
        }

        return undefined
    }

    on<T extends Event>(ctor: EventCtor<T>, listener: EventListener<T>) {
        if (!this.listeners) {
            this.listeners = new WeakMap()
        }
        if (!this.listeners.has(ctor)) {
            this.listeners.set(ctor, new Set())
        }

        this.listeners.get(ctor)!.add(listener)

        return () => this.off(ctor, listener)
    }

    off<T extends Event>(ctor: EventCtor<T>, listener?: EventListener<T>) {
        if (this.listeners) {
            if (this.listeners.has(ctor)) {
                if (listener) {
                    this.listeners.get(ctor)!.delete(listener)
                } else {
                    this.listeners.delete(ctor)
                }
            }
        }
    }

    dispath<T extends Event>(event: T) {
        const ctor = event.constructor as EventCtor<T>

        if (this.listeners && this.listeners.has(ctor)) {
            const listeners = this.listeners.get(ctor)!

            for (const listener of listeners) {
                listener(event)

                if (event.isPropagationImmediateStopped()) {
                    break
                }
            }
        }

        if (this.parent instanceof Context && !event.isPropagationStopped()) {
            this.parent.dispath(event)
        }
    }

    actor<T, A>(generator: ActorGenerator<T, A>) {
        const { atom, actors } = this

        if (actors.has(generator)) {
            return actors.get(generator)!
        }

        const { controller } = new Actor<T, A>(
            (arg: A) => {
                const cache = atom.exec(function (this: Stream<any>, ctx: Context) {
                    return generator.call(this, ctx, arg) as any
                }) as Result

                if (cache instanceof Err) {
                    throw cache.value
                }

                return cache.value
            },
            () => actors.delete(generator)
        )

        actors.set(generator, controller)

        return controller
    }

    /* 
                    здесь 
    ctx.defer(()=>                          а здесь 
                    будет идти
    ctx.defer(()=>                          пойдет
                    ветка синхронного
    ctx.defer(()=>                          ветка 
                    кода
    ctx.defer(()=>                          асинхронного кода )
                    все
    ctx.defer(()=>                          будут в правильном 
                    контексты 
    ctx.defer(()=>                          порядке )
    */

    private deferred: Promise<any> | null = null

    defer<T>(deffered: () => Promise<T>) {
        const promise = this.deferred ? this.deferred.then(deffered) : deffered()
        const result = { value: undefined } as { value: T | undefined }

        promise.then((r) => {
            result.value = r

            if (this.deferred === promise) {
                this.deferred = null
                this.update()
            }
        })

        this.deferred = promise

        return result
    }

    update() {
        this.atom.update()
    }

    dispose() {
        this.shared = undefined
        this.listeners = undefined

        for (const [_, actor] of this.actors) {
            actor.dispose()
        }

        this.actors.clear()
    }
}
