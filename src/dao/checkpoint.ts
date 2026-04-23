import { Checkpoint as SourceCheckpoint } from '../checkpoint.js'
import { ContentCodec } from '../codec.js'
import { SourceID } from '../sourceid.js'
import { UpdateType } from '../update.js'
import { BlobStore } from '../adapters/types.js'
import { Update as UpdateDao } from './update.js'

/**
 * Storage adapter for full-content checkpoints.
 *
 * A checkpoint is a snapshot of `TContent` + labels at one version. The
 * codec handles the content ↔ string translation; the BlobStore stores
 * the resulting string and doesn't care what's inside it.
 */
export interface Checkpoint<TContent = string> {
  save(source: SourceCheckpoint<TContent>): Promise<void>
  load(version: SourceID): Promise<SourceCheckpoint<TContent>>
  info(): any
}

export namespace Checkpoint {

  /**
   * Default implementation of the Checkpoint DAO.
   *
   * Writes `codec.serialize(content)` + labels as a JSON document to a
   * `BlobStore`, and delegates to the `Update` DAO to resolve lineage on
   * load and to demote a version's type from CHECKPOINT → UPDATE on delete.
   */
  export class Default<TContent = string, TPatch = unknown> implements Checkpoint<TContent> {

    constructor(
      public blobStore: BlobStore,
      public updateDao: UpdateDao<TPatch>,
      public codec: ContentCodec<TContent, TPatch>
    ) {
    }

    info() {
      return {
        bucket: this.blobStore.bucket(),
        partition: this.blobStore.partition()
      }
    }

    async has(versionKey: SourceID): Promise<boolean> {
      return this.blobStore.has(versionKey.toString())
    }

    async delete(versionKey: SourceID): Promise<boolean> {
      this.blobStore.delete(versionKey.toString())
      return this.updateDao.load([versionKey]).then((value) => {
        if (value.length < 1) {
          throw new Error(`Attempting to delete a version key which does not exist or cannot ` +
            `be returned for deletion. Version key: ${versionKey.toString()}`)
        }
        value[0].lineage[0][1] = UpdateType.UPDATE
        return this.updateDao.save(value[0])
      }).then(() => true).catch(err => {
        console.error(`Error trying to delete version key for source update: ${versionKey.toString()}`, err)
        return false
      })
    }

    async save(source: SourceCheckpoint<TContent>): Promise<void> {
      const blob = JSON.stringify({
        labels: source.labels,
        content: this.codec.serialize(source.content)
      })
      await this.blobStore.save(source.lineage[0][0].toString(), blob)
    }

    async load(versionKey: SourceID): Promise<SourceCheckpoint<TContent>> {
      const keyStr = versionKey.toString()
      const jsonObjPromise = this.blobStore.read(keyStr).then((jsonString) => {
        const json = JSON.parse(jsonString)
        const raw = json.content ?? json.source
        return { content: this.codec.deserialize(raw), labels: json.labels }
      })
      const updateInfoPromise = this.updateDao.load([versionKey])
      const [contentJSON, updateInfo] = await Promise.all([jsonObjPromise, updateInfoPromise])

      if (updateInfo.length < 1) {
        throw new Error(`Attempting to load an update for a version key which does not exist or cannot ` +
          `be returned. Version key: ${versionKey.toString()}`)
      }

      return new SourceCheckpoint<TContent>(updateInfo[0].lineage, contentJSON.content, contentJSON.labels)
    }
  }
}
