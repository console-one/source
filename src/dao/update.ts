import { Heap } from 'heap-js'
import { ListMultimap } from '@console-one/multimap'

import { SourceID } from '../sourceid.js'
import { SourceCommit } from '../sourcecommit.js'
import { Version } from '../version.js'
import { SourceUpdate } from '../update.js'
import { ColumnKey, PartitionMap, SortedSet } from '../adapters/types.js'

/**
 * Storage adapter for per-version update records.
 *
 * The engine (`Code.View.Checkpoint`) never touches storage directly —
 * all reads and writes of `SourceUpdate` records flow through this
 * interface. Generic over `TPatch` because a `SourceUpdate` carries a
 * list of patches, but this DAO doesn't inspect them.
 */
export interface Update<TPatch = unknown> {
  save(sourceUpdate: SourceUpdate<TPatch>): Promise<boolean>
  delete(version: SourceID): Promise<boolean>
  load(functionAddress: SourceID[]): Promise<SourceUpdate<TPatch>[]>
  addToWorkspaceCommit(source: SourceCommit): Promise<Version>
}

export namespace Update {

  /**
   * Default implementation of the Update DAO.
   *
   * Stores `SourceUpdate` records in a `PartitionMap` keyed by `(path,
   * version)` and indexes versions in a `SortedSet` keyed by
   * `(workspace, path)` so the most recent version for a workspace can be
   * found in O(log n).
   */
  export class Default<TPatch = unknown> implements Update<TPatch> {

    constructor(
      private map: PartitionMap<SourceUpdate<TPatch>>,
      private sset: SortedSet<number>
    ) {
    }

    async save(sourceUpdate: SourceUpdate<TPatch>): Promise<boolean> {
      const mapColumns = ColumnKey.from(sourceUpdate.lineage[0][0].path)
      const mapPromise = this.map.set(mapColumns.extend(sourceUpdate.lineage[0][0].version + ''), sourceUpdate)

      const ssetColumns = ColumnKey.from(sourceUpdate.lineage[0][2], sourceUpdate.lineage[0][0].path)
      const ssetPromise = this.sset.add(ssetColumns, sourceUpdate.lineage[0][0].version)
      return Promise.all([mapPromise, ssetPromise]).then(() => true).catch(err => {
        console.error(`Update dao save error: ${err}`)
        return false
      })
    }

    async has(version: SourceID): Promise<boolean> {
      const mapColumns = ColumnKey.from(version.path, version.version + '')
      return this.map.has(mapColumns)
    }

    async delete(version: SourceID): Promise<boolean> {
      const mapColumns = ColumnKey.from(version.path, version.version + '')
      const sourceUpdate = await this.map.get(mapColumns)
      if (sourceUpdate === undefined) return false
      const ssetColumns = ColumnKey.from(sourceUpdate.lineage[0][2], sourceUpdate.lineage[0][0].path)
      const removedFromSet = this.sset.remove(ssetColumns, sourceUpdate.lineage[0][0].version)
      const removedFromMap = this.map.delete(mapColumns)
      return Promise.all([removedFromMap, removedFromSet]).then(() => true).catch(err => {
        console.error(`Update dao delete error: ${err}`)
        return false
      })
    }

    async load(programVersionKeys: SourceID[]): Promise<SourceUpdate<TPatch>[]> {
      const namespacesToVersions: ListMultimap<string, number> = Default.byNamespace(programVersionKeys)
      const retrievals = new Heap<SourceUpdate<TPatch>>((a, b) => a.lineage[0][0].version > b.lineage[0][0].version ?
        1 : a.lineage[0][0].version === b.lineage[0][0].version ? 0 : -1)

      const namespaceKeys = Array.from(namespacesToVersions.keys())

      for (const namespace of namespaceKeys) {
        const updatesForNamespace = namespacesToVersions.get(namespace)
        const toQuery = updatesForNamespace.map(update => ColumnKey.from(namespace, update + ''))
        const versions = await this.map.getAll(toQuery)
        for (const version of versions) retrievals.push(version[1])
      }

      const result: SourceUpdate<TPatch>[] = []
      while (retrievals.length > 0) result.push(retrievals.pop()!)
      return result
    }

    async addToWorkspaceCommit(source: SourceCommit): Promise<Version> {
      const path = source.path
      const ssetColumns = ColumnKey.from('us-east', path)
      try {
        const version = await this.sset.findMax(ssetColumns)
        // TODO: add labels to checkpoint (carried over from source)
        return new Version(version)
      } catch (err) {
        console.error("Add workspace to commit error: ", err)
        throw err
      }
    }

    static byNamespace(programVersionKeys: SourceID[]): ListMultimap<string, number> {
      return programVersionKeys.reduce((mmap, versionKey) => {
        return mmap.set(versionKey.path.trim(), versionKey.version)
      }, new ListMultimap<string, number>())
    }
  }
}
