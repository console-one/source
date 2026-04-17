import { Checkpoint as SourceCheckpoint } from '../checkpoint.js'
import { SourceChange } from '../change.js'
import { Label, LabelChange } from '../label.js'
import { SourceCommit } from '../sourcecommit.js'
import { SourceID } from '../sourceid.js'
import { Transformations } from '../transformations.js'
import { Lineage, SourceUpdate, UpdateType } from '../update.js'
import { Version } from '../version.js'
import * as Dao from './index.js'

const DEFAULT_SNAPSHOT_FREQUENCY = 5
const DEFAULT_RETENTION = 20

export type CodeChange = {
  priorVersion?: SourceID,
  newVersion: SourceID,
  sourceChanges: SourceChange[],
  labelChanges: LabelChange[],
  workspace: string
}

export namespace Code {

  /**
   * High-level view over an event-sourced source-code store.
   *
   * Saving a version appends a compact update record (character-index
   * mutations + label changes) to the update store. Every Nth version —
   * controlled by `snapshotFrequency` — we additionally compute a full
   * checkpoint (apply all updates since the last checkpoint) and write
   * that to the checkpoint store.
   *
   * Loading a version finds the most recent checkpoint at or before that
   * version, then replays the intermediate updates forward. The
   * `sourceCache` and `updateCache` maps dedupe in-flight requests so N
   * concurrent callers asking for the same version share one round trip.
   */
  export interface View {
    save(update: CodeChange): Promise<SourceUpdate>
    load(programVersionKey: SourceID): Promise<SourceCheckpoint>
    addToWorkspaceCommit(source: SourceCommit): Promise<Version>
  }

  export namespace View {

    export class Checkpoint implements View {

      private sourceCache: Map<string, Promise<SourceCheckpoint>>
      private updateCache: Map<string, Promise<SourceUpdate>>

      constructor(
        private checkpointDao: Dao.Checkpoint,
        private updateDao: Dao.Update,
        private snapshotFrequency: number = DEFAULT_SNAPSHOT_FREQUENCY,
        private retention: number = DEFAULT_RETENTION) {

        if (this.snapshotFrequency > this.retention) {
          throw new Error(`Cannot create an event sourced dao with a snapshot frequency greater ` +
            `than the rate of retention. Provided frequency: ${snapshotFrequency} and retention: ${retention}`)
        }
        this.sourceCache = new Map<string, Promise<SourceCheckpoint>>()
        this.updateCache = new Map<string, Promise<SourceUpdate>>()
      }

      async set(_tlkey: any, codeUpdate: CodeChange) {
        return this.save(codeUpdate)
      }

      async loadUpdate(sourceID: SourceID): Promise<SourceUpdate> {
        if (!this.updateCache.has(sourceID.toString())) {
          this.updateCache.set(sourceID.toString(), new Promise(async (resolve, reject) => {
            try {
              const [updateItem] = await this.updateDao.load([sourceID])
              return resolve(updateItem)
            } catch (err) {
              reject(err)
            }
          }))
        }
        return this.updateCache.get(sourceID.toString())!
      }

      async loadAll(sourceIDs: SourceID[]): Promise<SourceUpdate[]> {
        const results: Array<Promise<SourceUpdate>> = new Array(sourceIDs.length)
        const promisedFromBulkCall: Array<{ sourceID: SourceID, resolver?: (v: SourceUpdate) => void, rejector?: (e: any) => void, done?: boolean }> = []

        for (let index = 0; index < sourceIDs.length; index++) {
          const id = sourceIDs[index]
          if (!this.updateCache.has(id.toString())) {
            const bulkCallIndex = promisedFromBulkCall.length
            promisedFromBulkCall.push({ sourceID: id })
            this.updateCache.set(id.toString(), new Promise((resolve, reject) => {
              promisedFromBulkCall[bulkCallIndex].resolver = resolve
              promisedFromBulkCall[bulkCallIndex].rejector = reject
            }))
          }
          results[index] = this.updateCache.get(id.toString())!
        }

        const toCallBulk = promisedFromBulkCall.map(p => p.sourceID)
        try {
          const retreived = await this.updateDao.load(toCallBulk)
          for (let i = 0; i < retreived.length; i++) {
            promisedFromBulkCall[i].resolver!(retreived[i])
            promisedFromBulkCall[i].done = true
          }
        } catch (err) {
          for (const bulkCall of promisedFromBulkCall) {
            if (!bulkCall.done) {
              this.updateCache.delete(bulkCall.sourceID.toString())
              bulkCall.rejector!(err)
              bulkCall.done = true
            }
          }
          throw err
        }

        return Promise.all(results)
      }

      async save(codeUpdate: CodeChange): Promise<SourceUpdate> {
        const priorVersion: SourceID | undefined = codeUpdate.priorVersion
        const newVersion: SourceID = codeUpdate.newVersion
        const sourceChanges: SourceChange[] = codeUpdate.sourceChanges
        const labelChanges: LabelChange[] = codeUpdate.labelChanges
        const workspace: string = codeUpdate.workspace

        if (!this.updateCache.has(newVersion.toString())) {
          this.updateCache.set(newVersion.toString(), new Promise(async (resolve, reject) => {
            try {
              if (priorVersion === undefined) {
                const version = newVersion
                const lineage: Lineage = [[version, UpdateType.CHECKPOINT, codeUpdate.workspace]]
                const change = codeUpdate.sourceChanges[0].change
                const checkpoint = new SourceCheckpoint(
                  lineage,
                  change,
                  Transformations.applyLabelChanges([], codeUpdate.labelChanges)
                )

                await this.checkpointDao.save(checkpoint)

                const update = new SourceUpdate(lineage, codeUpdate.sourceChanges, [])
                this.updateDao.save(update).then(() => update).then(resolve)

              } else {
                const updateItem = await this.loadUpdate(priorVersion)

                const checkpointIndex = this.getCheckpointIndex(newVersion.version, updateItem)

                const isCheckpoint = checkpointIndex >= this.snapshotFrequency - 1
                const updateType: UpdateType = isCheckpoint ? UpdateType.CHECKPOINT : UpdateType.UPDATE
                const nextLineage: Lineage = [[newVersion, updateType, workspace]]
                const retainFromIndex = Math.max(updateItem.lineage.length, this.retention)
                const newLineage = nextLineage.concat(updateItem.lineage).slice(0, retainFromIndex) as Lineage
                const nextUpdate = new SourceUpdate(newLineage, sourceChanges, labelChanges)

                if (isCheckpoint) {
                  const priorSource: SourceCheckpoint = await this.load(priorVersion)
                  const newSourceCode: string = Transformations.applyCodeChanges(priorSource.source, sourceChanges)
                  const newLabels: Label[] = Transformations.applyLabelChanges(priorSource.labels, labelChanges)
                  const newSource: SourceCheckpoint = new SourceCheckpoint(newLineage, newSourceCode, newLabels)
                  await this.checkpointDao.save(newSource)
                }

                this.updateDao.save(nextUpdate).then(() => nextUpdate).then(resolve)
              }
            } catch (err) {
              reject(err)
            }
          }))
        }

        return this.updateCache.get(newVersion.toString())!
      }

      private getCheckpointIndex(timestamp: number, update: SourceUpdate): number {
        let uptoTime = false
        for (let i = 0; i < update.lineage.length; i++) {
          if (update.lineage[i][0].version <= timestamp) uptoTime = true
          if (uptoTime && UpdateType.CHECKPOINT === update.lineage[i][1]) {
            return i
          }
        }
        throw new Error(`No checkpoint could be found any point upto ${timestamp} for ` +
          `update of ${JSON.stringify(update, null, 4)}`)
      }

      async get(versionKey: SourceID): Promise<SourceCheckpoint> {
        return this.load(versionKey)
      }

      async load(versionKey: SourceID): Promise<SourceCheckpoint> {
        if (!this.sourceCache.has(versionKey.toString())) {
          this.sourceCache.set(versionKey.toString(), new Promise(async (resolve, reject) => {
            try {
              const updateItem = await this.loadUpdate(versionKey)
              const checkpointIndex = this.getCheckpointIndex(versionKey.version, updateItem)
              const checkpointKey = updateItem.lineage[checkpointIndex][0]
              const updatesNeeded: SourceID[] = []
              let updateUptoIndex = checkpointIndex - 1

              while (updateUptoIndex >= 1) {
                updatesNeeded.push(updateItem.lineage[updateUptoIndex][0])
                updateUptoIndex--
              }

              const checkpointSource: SourceCheckpoint = await this.checkpointDao.load(checkpointKey)
              const updatesToApply: SourceUpdate[] = await this.loadAll(updatesNeeded)

              const updateItemKey = updateItem.lineage[0][0]
              if (checkpointKey.toString() !== updateItemKey.toString()) updatesToApply.push(updateItem)

              let source: SourceCheckpoint = checkpointSource
              for (const sourceUpdate of updatesToApply) {
                const newSourceCode: string = Transformations.applyCodeChanges(source.source, sourceUpdate.sourceCodeChanges)
                const newLabels: Label[] = Transformations.applyLabelChanges(source.labels, sourceUpdate.labelChanges)
                source = new SourceCheckpoint(sourceUpdate.lineage, newSourceCode, newLabels)
              }

              resolve(source)
            } catch (err) {
              reject(err)
            }
          }))
        }
        return this.sourceCache.get(versionKey.toString())!
      }

      async addToWorkspaceCommit(source: SourceCommit): Promise<Version> {
        return this.updateDao.addToWorkspaceCommit(source)
      }
    }
  }
}
