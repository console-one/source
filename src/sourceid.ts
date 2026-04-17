
export class SourceID { 

  constructor(
    public readonly path: string,
    public readonly version: number
  ) {
    if (path === null || path === undefined || path.length < 1) throw new Error(`Source Id created with an invalid path of: ${path}`);
  }

  toString(): string {

    let path = this.path;
  

    return `${path}/${this.version}`;
  }

  toJSON() {
    return { path: this.path, version: this.version }
  }

  static fromJSON(json: any): SourceID {
    return new SourceID(json.path, json.version);
  }

}
