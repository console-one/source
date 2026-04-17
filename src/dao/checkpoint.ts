import { Checkpoint as SourceCheckpoint } from '../checkpoint.js'
import { SourceID } from '../sourceid.js'
import { UpdateType } from '../update.js'
import { BlobStore } from '../adapters/types.js'
import { Update as UpdateDao } from './update.js'

/**
 * Storage adapter for full-source checkpoints.
 *
 * A checkpoint is a snapshot of source text + labels at one version.
 * Callers back this with any blob-oriented storage.
 */
export interface Checkpoint {
  save(source: SourceCheckpoint): Promise<void>
  load(version: SourceID): Promise<SourceCheckpoint>
  info(): any
}

export namespace Checkpoint {

  /**
   * Default implementation of the Checkpoint DAO.
   *
   * Writes base64-encoded source + labels as a JSON document to a
   * `BlobStore`, and delegates to the `Update` DAO to resolve lineage on
   * load and to demote a version's type from CHECKPOINT → UPDATE on delete.
   *
   * Originally named `S3Redis` in the source monorepo. Nothing here is
   * S3-specific — any `BlobStore` works.
   */
  export class Default implements Checkpoint {

    constructor(public blobStore: BlobStore, public updateDao: UpdateDao) {
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

    async save(source: SourceCheckpoint): Promise<void> {
      const checkpoint = JSON.stringify({
        labels: source.labels,
        source: Buffer.from(source.source, 'utf-8').toString('base64')
      })
      await this.blobStore.save(source.lineage[0][0].toString(), checkpoint)
    }

    async load(versionKey: SourceID): Promise<SourceCheckpoint> {
      const versionKeyToRead = versionKey.toString()
      const jsonObjPromise = this.blobStore.read(versionKeyToRead).then((jsonString) => {
        const json = JSON.parse(jsonString)
        json.source = Buffer.from(json.source, 'base64').toString('utf-8')
        return json
      })
      const updateInfoPromise = this.updateDao.load([versionKey])
      const [sourceJSON, updateInfo] = await Promise.all([jsonObjPromise, updateInfoPromise])

      if (updateInfo.length < 1) {
        throw new Error(`Attempting to load an update for a version key which does not exist or cannot ` +
          `be returned. Version key: ${versionKey.toString()}`)
      }

      return new SourceCheckpoint(updateInfo[0].lineage, sourceJSON.source, sourceJSON.labels)
    }
  }
}
